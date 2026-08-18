"""HTTP wiring.

Every WRITE -- transactional requests and Initialize alike -- flows through the
workspace's controller: serialized per workspace, fanned out after commit.
READS (Content, blobs) bypass it; MVCC handles them.

TOPOLOGY INVARIANT: exactly one process serves a workspace's writes and
streams. Deploy with a single worker; the controller's lease turns a second
one into a loud 503 rather than silent divergence.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import AsyncIterator, Iterator
from uuid import UUID

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import Engine, delete, func
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, SQLModel, select

from wsfs_suede__sqlmodel_utils_suede.associations import now
from wsfs_suede__sqlmodel_utils_suede.postgres.config import Config

from . import db, service, stream, text
from .blobs import Blobs
from .contract import (
    InitializeRequest,
    InitializeResponse,
    Queued,
    Rejection,
    Submitted,
    TextContentResponse,
)
from .controller import ControllerRegistry, WorkspaceServedElsewhere
from .models import BlobContent, Entry, StreamToken, User, Version, Workspace
from .stream import Emitted
from .tree import node as current_node

TOKEN_TTL = timedelta(seconds=60)

SHARDING_ACKNOWLEDGED = "WSFS_WORKSPACES_ARE_ROUTED_STICKILY"


def refuse_to_split_the_brain() -> None:
    """One process per workspace is a correctness requirement, and `--workers 4`
    is one keystroke from silently violating it. Session affinity is not the
    fix either: routing that may fail is, for correctness, routing that does
    not exist. Anyone who has genuinely solved it says so out loud."""
    workers = int(os.getenv("WEB_CONCURRENCY", "1"))
    if workers > 1 and not os.getenv(SHARDING_ACKNOWLEDGED):
        raise RuntimeError(
            f"WEB_CONCURRENCY={workers} would serve one workspace from several"
            f" processes. Run a single worker, or set {SHARDING_ACKNOWLEDGED}"
            " once each workspace is pinned to exactly one of them."
        )


@dataclass(frozen=True)
class Backend:
    engine: Engine
    registry: ControllerRegistry
    blobs: Blobs
    heartbeat_seconds: float
    max_blob_bytes: int


# -- identity ------------------------------------------------------------------


def authenticate(session: Session, email: str) -> User:
    """Stand-in for real authentication: the header names the user, and an
    unknown one is enrolled. Replace with token verification before this is
    reachable from anywhere but a trusted client."""
    known = session.exec(select(User).where(User.email == email)).first()
    if known is not None:
        return known
    session.add(User(email=email))
    try:
        session.flush()
    except IntegrityError:  # two first requests from the same new user, racing
        session.rollback()
        return session.exec(select(User).where(User.email == email)).one()
    return session.exec(select(User).where(User.email == email)).one()


def require_workspace(session: Session, workspace_id: UUID) -> Workspace:
    workspace = session.get(Workspace, workspace_id)
    if workspace is None:
        raise HTTPException(404, "no such workspace")
    return workspace


# -- reconciliation --------------------------------------------------------------


@dataclass
class Reconciliation:
    """Initialize's verdict on a presented outbox, in the order it was given."""

    applied: list[str] = field(default_factory=list)
    rejected: list[Rejection] = field(default_factory=list)
    events: list[Emitted] = field(default_factory=list)

    def record(self, transaction: str, outcome: service.Outcome) -> None:
        self.events.extend(outcome.events)
        if outcome.response.rejected:
            self.rejected.append(
                Rejection(
                    transaction=transaction,
                    reason=outcome.response.reason,
                    version=outcome.response.version,
                )
            )
        else:
            self.applied.append(transaction)


class Supersession:
    """The versions one replay has itself replaced.

    A client composes its outbox offline, against the versions it holds.
    Applying the first item mints a version the client could not have known, so
    every later item touching that entry presents a token that is now stale --
    and an outbox must be able to say "rename it, then delete it".

    So within a replay a superseded token reads as the token that replaced it.
    An outbox cannot conflict with itself; only with somebody else, whose work
    minted versions this map never saw.
    """

    def __init__(self) -> None:
        self._replaced: dict[UUID, UUID] = {}

    def current(self, presented: UUID) -> UUID:
        while presented in self._replaced:
            presented = self._replaced[presented]
        return presented

    def record(self, presented: UUID, outcome: service.Outcome) -> None:
        for emitted in outcome.events:
            self._replaced[presented] = emitted.event.version


def reconcile(submission: service.Submission, outbox: list[Queued]) -> Reconciliation:
    reconciliation = Reconciliation()
    superseded = Supersession()
    for queued in outbox:
        request = queued.model_copy(update={"version": superseded.current(queued.version)})
        outcome = service.adjudicate(submission, request)
        superseded.record(queued.version, outcome)
        reconciliation.record(queued.transaction, outcome)
    return reconciliation


def mint_token(session: Session, workspace: Workspace, user: User) -> str:
    token = secrets.token_hex(16)
    session.add(
        StreamToken(
            token=token,
            user_id=user.id,
            workspace_id=workspace.id,
            position=workspace.position,
            expires=now() + TOKEN_TTL,
        )
    )
    return token


def claim_token(session: Session, workspace_id: UUID, token: str) -> int:
    """Single-use by construction: the claim and the lookup are one statement,
    so two racing connects produce exactly one winner."""
    claimed = session.execute(
        delete(StreamToken)
        .where(
            StreamToken.token == token,
            StreamToken.workspace_id == workspace_id,
            StreamToken.expires > func.now(),
        )
        .returning(StreamToken.position)
    ).first()
    session.commit()
    if claimed is None:
        raise HTTPException(401, "invalid or spent token")
    return claimed[0]


# -- the two units of work every write is one of ------------------------------------


@contextmanager
def submitting(
    backend: Backend, workspace_id: UUID, email: str
) -> Iterator[service.Submission]:
    with Session(backend.engine) as session:
        require_workspace(session, workspace_id)
        yield service.Submission(
            session=session,
            workspace=workspace_id,
            user=authenticate(session, email),
            blobs=backend.blobs,
        )


def initialize_within(
    backend: Backend, workspace_id: UUID, email: str, body: InitializeRequest
) -> tuple[InitializeResponse, list[Emitted]]:
    """ONE database transaction: adjudicate the outbox in order, snapshot, and
    mint the position-bound token together. Splitting it apart kills the
    no-flicker and no-gap guarantees silently."""
    with submitting(backend, workspace_id, email) as submission:
        reconciliation = reconcile(submission, body.outbox)
        response = _snapshot_and_token(submission, reconciliation)
        submission.session.commit()
        return response, reconciliation.events


def _snapshot_and_token(
    submission: service.Submission, reconciliation: Reconciliation
) -> InitializeResponse:
    session = submission.session
    session.flush()
    workspace = require_workspace(session, submission.workspace)
    session.refresh(workspace)
    return InitializeResponse(
        token=mint_token(session, workspace, submission.user),
        entries=service.snapshot(session, submission.workspace),
        applied=reconciliation.applied,
        rejected=reconciliation.rejected,
    )


def apply_within(
    backend: Backend, workspace_id: UUID, email: str, request: Submitted
) -> tuple[service.Outcome, list[Emitted]]:
    with submitting(backend, workspace_id, email) as submission:
        outcome = service.adjudicate(submission, request)
        submission.session.commit()
        return outcome, outcome.events


# -- content ------------------------------------------------------------------------


def resolve_version(
    session: Session, workspace_id: UUID, entry_id: UUID, version_id: UUID | None
) -> Version:
    entry = session.get(Entry, entry_id)
    if entry is None or entry.workspace_id != workspace_id:
        raise HTTPException(404, "no such entry")
    if version_id is None:
        node = current_node(session, workspace_id, entry_id)
        if node is None:
            raise HTTPException(404, "entry has no versions")
        return node.version
    version = session.get(Version, version_id)
    if version is None or version.entry_id != entry_id:
        raise HTTPException(404, "no such version of this entry")
    return version


def content_response(session: Session, blobs: Blobs, version: Version) -> Response:
    if version.text_content_id is not None:
        body = TextContentResponse(content=text.at(session, version), version=version.id)
        return JSONResponse(
            body.model_dump(mode="json"), headers={"ETag": str(version.id)}
        )
    if version.blob_content_id is not None:
        blob = session.get(BlobContent, version.blob_content_id)
        assert blob is not None
        return Response(
            content=blobs.read(blob.hash),
            media_type=blob.mime,
            headers={"ETag": str(version.id), "X-Content-Hash": blob.hash},
        )
    raise HTTPException(404, "entry has no content at this version")


def declared_size(request: Request) -> int | None:
    """A Store sends Content-Length. Without one, the body's size is unknown
    until it has been buffered -- which is the thing a limit exists to stop."""
    declared = request.headers.get("content-length")
    return None if declared is None else int(declared)


# -- the stream -----------------------------------------------------------------------


def sent(event_payload: dict) -> str:
    return f"data: {json.dumps(event_payload)}\n\n"


HEARTBEAT = ": hb\n\n"


async def follow(
    backend: Backend, workspace_id: UUID, after: int, queue: asyncio.Queue[Emitted]
) -> AsyncIterator[str]:
    """Replay what the token's position missed, then follow live.

    Subscribing happens before the replay reads, so an event committed in
    between lands in both -- and the position cursor drops the duplicate.
    """
    cursor = after
    with Session(backend.engine) as session:
        replay = stream.since(session, workspace_id, after)
    for emitted in replay:
        cursor = emitted.position
        yield sent(emitted.event.payload())
    while True:
        try:
            emitted = await asyncio.wait_for(queue.get(), backend.heartbeat_seconds)
        except asyncio.TimeoutError:
            yield HEARTBEAT
            continue
        if emitted.position <= cursor:
            continue
        cursor = emitted.position
        yield sent(emitted.event.payload())


# -- the app -------------------------------------------------------------------------


def create_app(
    *,
    config: Config | None = None,
    blob_root: str | Path = "/tmp/wsfs-blobs",
    heartbeat_seconds: float = 15.0,
    grace_seconds: float = 30.0,
    max_blob_bytes: int = 64 * 1024 * 1024,
    create_tables: bool = False,
) -> FastAPI:
    refuse_to_split_the_brain()
    engine = db.engine(config)
    if create_tables:
        SQLModel.metadata.create_all(engine)
    backend = Backend(
        engine=engine,
        registry=ControllerRegistry(db.lease_engine(config), grace_seconds=grace_seconds),
        blobs=Blobs(Path(blob_root)),
        heartbeat_seconds=heartbeat_seconds,
        max_blob_bytes=max_blob_bytes,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        await backend.registry.shutdown()
        engine.dispose()

    app = FastAPI(title="wsfs", lifespan=lifespan)
    app.state.backend = backend

    def email(x_user_email: str = Header()) -> str:
        return x_user_email

    async def controller_for(workspace_id: UUID):
        try:
            return await backend.registry.visit(workspace_id)
        except WorkspaceServedElsewhere as elsewhere:
            raise HTTPException(503, str(elsewhere)) from elsewhere

    @app.post("/workspaces", status_code=201)
    def open_workspace() -> dict[str, str]:
        with Session(engine) as session:
            workspace = Workspace()
            session.add(workspace)
            session.commit()
            return {"id": str(workspace.id)}

    @app.post("/workspaces/{workspace_id}/initialize", response_model_exclude_none=True)
    async def initialize(
        workspace_id: UUID, body: InitializeRequest, user: str = Depends(email)
    ) -> InitializeResponse:
        controller = await controller_for(workspace_id)
        return await controller.submit(
            lambda: initialize_within(backend, workspace_id, user, body)
        )

    @app.post("/workspaces/{workspace_id}/transactions")
    async def transact(
        workspace_id: UUID, body: Submitted = Body(), user: str = Depends(email)
    ) -> Response:
        controller = await controller_for(workspace_id)
        outcome = await controller.submit(
            lambda: apply_within(backend, workspace_id, user, body)
        )
        return JSONResponse(
            outcome.response.model_dump(mode="json", exclude_none=True),
            status_code=409 if outcome.response.rejected else 200,
        )

    @app.put("/blobs/{digest}")
    async def store(digest: str, request: Request) -> Response:
        if backend.blobs.holds(digest):
            return JSONResponse({"rejected": False})  # idempotent by construction
        size = declared_size(request)
        if size is None or size > backend.max_blob_bytes:
            return JSONResponse({"rejected": True, "reason": "too large"}, 413)
        if not backend.blobs.store(digest, await request.body()):
            return JSONResponse({"rejected": True, "reason": "hash mismatch"}, 409)
        return JSONResponse({"rejected": False})

    @app.get("/blobs/{digest}")
    def fetch_blob(digest: str) -> Response:
        if not backend.blobs.holds(digest):
            raise HTTPException(404, "no such blob")
        return Response(backend.blobs.read(digest), media_type="application/octet-stream")

    @app.get("/workspaces/{workspace_id}/entries/{entry_id}/content")
    def content(
        workspace_id: UUID, entry_id: UUID, version: UUID | None = None
    ) -> Response:
        with Session(engine) as session:
            return content_response(
                session, backend.blobs, resolve_version(session, workspace_id, entry_id, version)
            )

    @app.get("/workspaces/{workspace_id}/stream")
    async def events(workspace_id: UUID, token: str) -> StreamingResponse:
        with Session(engine) as session:
            after = claim_token(session, workspace_id, token)
        queue: asyncio.Queue[Emitted] = asyncio.Queue()

        async def subscribed() -> AsyncIterator[str]:
            await backend.registry.acquire_stream(workspace_id, queue)
            try:
                async for chunk in follow(backend, workspace_id, after, queue):
                    yield chunk
            finally:
                await backend.registry.release_stream(workspace_id, queue)

        return StreamingResponse(
            subscribed(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return app
