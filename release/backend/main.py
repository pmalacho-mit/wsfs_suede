# pyright: reportUnusedFunction=false
"""The router a host mounts, and the units of work behind it.

Every WRITE -- transactional requests and Initialize alike -- flows through the
workspace's controller: serialized per workspace, fanned out after commit.
READS (Content, blobs) bypass it; MVCC handles them.

Nothing here decides anything that belongs to the host. It is handed a schema
(`build_models`), a database, a blob store, and a dependency that says which
user may reach a workspace -- and it makes no other assumption about either.

TOPOLOGY INVARIANT: exactly one process serves a workspace's writes and
streams, and nothing enforces it (ARCHITECTURE.md invariant 11).
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Annotated, Any, final
from uuid import UUID

from fastapi import APIRouter, Body, Depends, FastAPI, HTTPException, Request, Response
from fastapi import Path as APIPath
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import delete, func
from sqlmodel import col
from sqlmodel.ext.asyncio.session import AsyncSession

from ...wsfs_suede__sqlmodel_utils_suede.associations import now
from ...wsfs_suede__sqlmodel_utils_suede.postgres.db import Database

from . import service
from .blobs import Blobs
from .contract import (
    Create,
    InitializeRequest,
    InitializeResponse,
    Refusal,
    Rejected,
    Rejection,
    Submitted,
    TextContentResponse,
)
from .controller import ControllerRegistry, WorkspaceController
from .models import BlobContentRow, Models, TextContentRow
from .service import Workspaces
from .stream import Emitted

TOKEN_TTL = timedelta(seconds=60)

SHARDING_ACKNOWLEDGED = "WSFS_WORKSPACES_ARE_ROUTED_STICKILY"

Authorize = Callable[..., Awaitable[UUID]]
"""A host dependency: given the request, the user who may reach this
workspace. Raising is how a host refuses -- this package never asks who
anybody is, and never decides whether they may."""


def refuse_to_split_the_brain() -> None:
    """One process per workspace is a correctness requirement, and `--workers 4`
    is one keystroke from silently violating it. Session affinity is not the
    fix either: routing that may fail is, for correctness, routing that does
    not exist. Anyone who has genuinely solved it says so out loud.

    This reads the environment, which is where the mistake usually lives but
    not where it always lives: `WEB_CONCURRENCY` is only uvicorn's DEFAULT for
    `--workers`, so an explicit `--workers 4` sets nothing here and starts
    four processes anyway. Nothing in this codebase catches that -- running
    one instance is the host's promise, and ARCHITECTURE.md invariant 11 says
    what it costs to break it."""
    workers = int(os.getenv("WEB_CONCURRENCY", "1"))
    if workers > 1 and not os.getenv(SHARDING_ACKNOWLEDGED):
        raise RuntimeError(
            f"WEB_CONCURRENCY={workers} would serve one workspace from several "
            f"processes. Run a single worker, or set {SHARDING_ACKNOWLEDGED} "
            "once each workspace is pinned to exactly one of them."
        )


@final
@dataclass(frozen=True)
class Backend:
    """One wsfs, bound: its schema, where it stores things, and who serializes
    writes to it."""

    schema: Workspaces
    database: Database
    blobs: Blobs
    registry: ControllerRegistry
    heartbeat_seconds: float
    max_blob_bytes: int

    @classmethod
    def over(
        cls,
        models: Models,
        database: Database,
        blobs: Blobs,
        *,
        heartbeat_seconds: float,
        grace_seconds: float,
        max_blob_bytes: int,
    ) -> "Backend":
        schema = Workspaces.over(models)
        return cls(
            schema=schema,
            database=database,
            blobs=blobs,
            registry=ControllerRegistry(
                database, schema.stream, grace_seconds=grace_seconds
            ),
            heartbeat_seconds=heartbeat_seconds,
            max_blob_bytes=max_blob_bytes,
        )

    @property
    def models(self) -> Models:
        return self.schema.models


# -- reconciliation --------------------------------------------------------------


@dataclass
class Reconciliation:
    """Initialize's verdict on a presented outbox, in the order it was given."""

    applied: list[UUID] = field(default_factory=list)
    rejected: list[Rejection] = field(default_factory=list)
    events: list[Emitted] = field(default_factory=list)

    def record(self, transaction: UUID, outcome: service.Outcome) -> None:
        self.events.extend(outcome.events)
        answer = outcome.response
        if isinstance(answer, Rejected):
            self.rejected.append(
                Rejection(
                    transaction=transaction,
                    reason=answer.reason,
                    version=answer.version,
                )
            )
        else:
            self.applied.append(transaction)


@final
class Stillborn:
    """Entries whose queued create was refused.

    New with queued creates: everything later in the outbox that names one
    would otherwise be adjudicated against an entry that does not exist,
    turning one real failure into a cascade of confusing secondary ones.
    """

    def __init__(self) -> None:
        self._ids: set[UUID] = set()

    def __contains__(self, request: Submitted) -> bool:
        return request.id in self._ids

    def note(self, request: Submitted, outcome: service.Outcome) -> None:
        if isinstance(request, Create) and outcome.response.rejected:
            self._ids.add(request.id)


def _never_attempted() -> service.Outcome:
    return service.Outcome(Rejected(reason=Refusal.CREATE_REFUSED))


async def reconcile(
    submission: service.Submission, outbox: list[Submitted]
) -> Reconciliation:
    """An outbox applied in counter order.

    Nothing rewrites the tokens a client presented: it minted them, so it
    already knows what its own queued work produces and chained accordingly.
    """
    reconciliation = Reconciliation()
    stillborn = Stillborn()
    for request in outbox:
        outcome = (
            _never_attempted()
            if request in stillborn
            else await service.adjudicate(submission, request)
        )
        stillborn.note(request, outcome)
        reconciliation.record(request.transaction, outcome)
    return reconciliation


def mint_token(
    backend: Backend, session: AsyncSession, submission: service.Submission
) -> str:
    """Bound to the position this snapshot was taken at, so the stream that
    claims it replays exactly the changes the snapshot does not show."""
    token = secrets.token_hex(16)
    session.add(
        backend.models.token(
            token=token,
            user_id=submission.user,
            workspace_id=submission.workspace,
            position=submission.positions.at,
            expires=now() + TOKEN_TTL,
        )
    )
    return token


async def claim_token(
    backend: Backend, session: AsyncSession, workspace_id: UUID, token: str
) -> int:
    """Single-use by construction: the claim and the lookup are one statement,
    so two racing connects produce exactly one winner."""
    tokens = backend.models.token
    connection = await session.connection()
    claimed = (
        await connection.execute(
            delete(tokens)
            .where(
                col(tokens.token) == token,
                col(tokens.workspace_id) == workspace_id,
                col(tokens.expires) > func.now(),
            )
            .returning(col(tokens.position))
        )
    ).first()
    await session.commit()
    if claimed is None:
        raise HTTPException(401, "invalid or spent token")
    return claimed[0]


# -- the two units of work every write is one of ------------------------------------


@asynccontextmanager
async def submitting(
    backend: Backend, controller: WorkspaceController, user_id: UUID
) -> AsyncGenerator[service.Submission]:
    """The workspace is not checked for existence here. The host's dependency
    already said this user may reach it; re-deciding that would be this
    package overreaching, and a workspace id it never issued fails on the
    foreign key -- which is the database telling the host what it knew."""
    async with backend.database.session() as session:
        yield service.Submission(
            schema=backend.schema,
            session=session,
            workspace=controller.workspace_id,
            user=user_id,
            blobs=backend.blobs,
            positions=controller.positions,
        )


async def initialize_within(
    backend: Backend,
    controller: WorkspaceController,
    user_id: UUID,
    body: InitializeRequest,
) -> tuple[InitializeResponse, list[Emitted]]:
    """ONE database transaction: adjudicate the outbox in order, settle names,
    snapshot, and mint the position-bound token together. Splitting it apart
    kills the no-flicker and no-gap guarantees silently."""
    async with submitting(backend, controller, user_id) as submission:
        reconciliation = await reconcile(submission, body.outbox)
        # Before the snapshot, so it shows the names that settled.
        reconciliation.events.extend(await service.settle(submission))
        response = await _snapshot_and_token(backend, submission, reconciliation)
        await submission.session.commit()
        return response, reconciliation.events


async def _snapshot_and_token(
    backend: Backend, submission: service.Submission, reconciliation: Reconciliation
) -> InitializeResponse:
    session = submission.session
    await session.flush()
    return InitializeResponse(
        token=mint_token(backend, session, submission),
        entries=await service.snapshot(backend.schema, session, submission.workspace),
        applied=reconciliation.applied,
        rejected=reconciliation.rejected,
    )


async def apply_within(
    backend: Backend, controller: WorkspaceController, user_id: UUID, request: Submitted
) -> tuple[service.Outcome, list[Emitted]]:
    async with submitting(backend, controller, user_id) as submission:
        outcome = await service.adjudicate(submission, request)
        events = [*outcome.events, *await service.settle(submission)]
        await submission.session.commit()
        return outcome, events


# -- content ------------------------------------------------------------------------


async def resolve_content(
    backend: Backend,
    session: AsyncSession,
    workspace_id: UUID,
    entry_id: UUID,
    content_id: UUID | None,
) -> TextContentRow | BlobContentRow:
    """The write a content token names.

    A client holds `content_version` in its metadata and fetches with it
    directly -- the token IS the write, so there is nothing to translate.
    """
    entry = await session.get(backend.models.entry, entry_id)
    if entry is None or entry.workspace_id != workspace_id:
        raise HTTPException(404, "no such entry")
    held = (
        await _newest_write(backend, session, workspace_id, entry_id)
        if content_id is None
        else await _written(backend, session, content_id)
    )
    if held is None or held.entry_id != entry_id:
        raise HTTPException(404, "entry has no such content")
    return held


async def _written(
    backend: Backend, session: AsyncSession, content_id: UUID
) -> TextContentRow | BlobContentRow | None:
    return await session.get(
        backend.models.text_content, content_id
    ) or await session.get(backend.models.blob_content, content_id)


async def _newest_write(
    backend: Backend, session: AsyncSession, workspace_id: UUID, entry_id: UUID
) -> TextContentRow | BlobContentRow | None:
    node = await backend.schema.tree.node(session, workspace_id, entry_id)
    if node is None or node.content is None:
        return None
    return await _written(backend, session, node.content.version)


async def content_response(
    backend: Backend, session: AsyncSession, held: Any
) -> Response:
    if isinstance(held, backend.models.text_content):
        body = TextContentResponse(
            content=await backend.schema.text.at(session, held.entry_id, held.position),
            version=held.id,
        )
        return JSONResponse(
            body.model_dump(mode="json"), headers={"ETag": str(held.id)}
        )
    return Response(
        content=await backend.blobs.read(held.hash),
        media_type=held.mime,
        headers={"ETag": str(held.id), "X-Content-Hash": held.hash},
    )


def declared_size(request: Request) -> int | None:
    """A Store sends Content-Length. Without one, the body's size is unknown
    until it has been buffered -- which is the thing a limit exists to stop."""
    declared = request.headers.get("content-length")
    return None if declared is None else int(declared)


# -- the stream -----------------------------------------------------------------------


def sent(event_payload: dict[str, Any]) -> str:
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
    async with backend.database.session() as session:
        replay = await backend.schema.stream.since(session, workspace_id, after)
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


# -- the router ----------------------------------------------------------------------


def create_router(
    *, backend: Backend, authorize: Authorize, prefix: str = "/wsfs"
) -> APIRouter:
    """A router to include in a host's app.

    The backend is built by the host (`Backend.over`) rather than in here, so
    the host keeps a handle on it -- for `shutdown`, for its own queries, for
    whatever else it owns. The host owns the database and the blob store too,
    so it disconnects them; the only thing this router puts down is its own
    controllers, which it does in a lifespan of its own.
    """
    refuse_to_split_the_brain()
    database = backend.database

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        await backend.registry.shutdown()

    router = APIRouter(prefix=prefix, lifespan=lifespan)

    @asynccontextmanager
    async def serving(workspace_id: UUID) -> AsyncGenerator[WorkspaceController]:
        """The workspace's controller, held for the whole submission."""
        async with backend.registry.visiting(workspace_id) as controller:
            yield controller

    @router.post(
        "/workspaces/{workspace_id}/initialize", response_model_exclude_none=True
    )
    async def initialize(
        workspace_id: Annotated[UUID, APIPath()],
        body: Annotated[InitializeRequest, Body()],
        # Not Annotated[..., Depends(authorize)]: annotations here are strings,
        # and a closure variable is not in the globals they resolve against.
        user: UUID = Depends(authorize),
    ) -> InitializeResponse:
        async with serving(workspace_id) as controller:
            return await controller.submit(
                lambda: initialize_within(backend, controller, user, body)
            )

    @router.post("/workspaces/{workspace_id}/transactions")
    async def transact(
        workspace_id: Annotated[UUID, APIPath()],
        body: Annotated[Submitted, Body()],
        user: UUID = Depends(authorize),
    ) -> Response:
        async with serving(workspace_id) as controller:
            outcome = await controller.submit(
                lambda: apply_within(backend, controller, user, body)
            )
        return JSONResponse(
            outcome.response.model_dump(mode="json", exclude_none=True),
            status_code=409 if outcome.response.rejected else 200,
        )

    @router.put("/blobs/{digest}")
    async def store(digest: str, request: Request) -> Response:
        if await backend.blobs.holds(digest):
            return JSONResponse({"rejected": False})  # idempotent by construction
        size = declared_size(request)
        if size is None or size > backend.max_blob_bytes:
            return JSONResponse({"rejected": True, "reason": "too large"}, 413)
        if not await backend.blobs.store(digest, await request.body()):
            return JSONResponse({"rejected": True, "reason": "hash mismatch"}, 409)
        return JSONResponse({"rejected": False})

    @router.get("/blobs/{digest}")
    async def fetch_blob(digest: str) -> Response:
        if not await backend.blobs.holds(digest):
            raise HTTPException(404, "no such blob")
        return Response(
            await backend.blobs.read(digest), media_type="application/octet-stream"
        )

    @router.get("/workspaces/{workspace_id}/entries/{entry_id}/content")
    async def content(
        workspace_id: Annotated[UUID, APIPath()],
        entry_id: Annotated[UUID, APIPath()],
        content: UUID | None = None,
        _: UUID = Depends(authorize),
    ) -> Response:
        """Omitting `content` asks for the entry's newest."""
        async with database.session() as session:
            return await content_response(
                backend,
                session,
                await resolve_content(
                    backend, session, workspace_id, entry_id, content
                ),
            )

    @router.get("/workspaces/{workspace_id}/stream")
    async def events(workspace_id: UUID, token: str) -> StreamingResponse:
        """The token is the credential here -- EventSource cannot carry a
        header, which is why it is single-use and position-bound."""
        async with database.session() as session:
            after = await claim_token(backend, session, workspace_id, token)
        queue: asyncio.Queue[Emitted] = asyncio.Queue()

        async def subscribed() -> AsyncIterator[str]:
            _ = await backend.registry.acquire_stream(workspace_id, queue)
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

    return router
