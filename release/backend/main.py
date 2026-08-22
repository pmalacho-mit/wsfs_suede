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
from sqlmodel import col, desc, select
from sqlmodel.ext.asyncio.session import AsyncSession

from ...wsfs_suede__sqlmodel_utils_suede.associations import now
from ...wsfs_suede__sqlmodel_utils_suede.postgres.db import Database

from . import reconstruct, refusals, service
from .blobs import Blobs
from .contract import (
    Clearing,
    Create,
    InitializeRequest,
    InitializeResponse,
    ReconstructionRequest,
    ReconstructionResponse,
    Refusal,
    Rejected,
    Rejection,
    Stranded,
    StrandedDrafts,
    StreamEvent,
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


async def _never_attempted(
    submission: service.Submission, request: Submitted
) -> service.Outcome:
    """Refused without being judged -- and recorded all the same.

    This is the one refusal that never reaches `adjudicate`, and for a while
    it was therefore the one that kept nothing. That was the worst possible
    place to lose work: replay is the path a queue comes home by, so a single
    refused create silently discarded every keystroke queued behind it.
    """
    return await service.declined(submission, request, Refusal.CREATE_REFUSED)


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
            await _never_attempted(submission, request)
            if request in stillborn
            else await service.adjudicate(submission, request)
        )
        stillborn.note(request, outcome)
        reconciliation.record(request.transaction, outcome)
    return reconciliation


async def mint_token(
    backend: Backend, session: AsyncSession, submission: service.Submission
) -> str:
    """Bound to the position this snapshot was taken at, so the stream that
    claims it replays exactly the changes the snapshot does not show.

    Read out of the LOGS, in this transaction, rather than off the
    controller's counter. The counter is the next number to hand out and it
    moves before a submission commits, so a submission that rolls back leaves
    it above anything committed. That costs the stream nothing -- positions
    have to increase, not to be dense -- but a token is a promise about what
    has already happened, and one bound to a number no row carries would tell
    a stream to skip the row that eventually takes it.

    The rows this transaction has flushed are visible to this session, so this
    is exactly what the snapshot alongside it shows: no gap, no repeat.
    """
    token = secrets.token_hex(nbytes=16)
    session.add(
        backend.models.token(
            token=token,
            user_id=submission.user,
            workspace_id=submission.workspace,
            position=await backend.schema.stream.high_water(
                session, submission.workspace
            ),
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
        token=await mint_token(backend, session, submission),
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
) -> Any:
    """The write a content token names.

    A client holds `content_version` in its metadata and fetches with it
    directly -- the token IS the write, so there is nothing to translate.
    """
    entry = await session.get(backend.models.entry, entry_id)
    known = entry is not None and entry.workspace_id == workspace_id

    held = None
    if known:
        held = (
            await _newest_write(backend, session, workspace_id, entry_id)
            if content_id is None
            else await _written(backend, session, content_id)
        )
        if held is not None and held.entry_id != entry_id:
            held = None

    if held is None and content_id is not None:
        held = await _refused_write(backend, session, workspace_id, entry_id, content_id)

    if held is None:
        raise HTTPException(404, "no such entry" if not known else "entry has no such content")
    return held


async def _written(
    backend: Backend, session: AsyncSession, content_id: UUID
) -> TextContentRow | BlobContentRow | None:
    return await session.get(
        backend.models.text_content, content_id
    ) or await session.get(backend.models.blob_content, content_id)


async def _refused_write(
    backend: Backend,
    session: AsyncSession,
    workspace_id: UUID,
    entry_id: UUID,
    content_id: UUID,
) -> Any | None:
    """A write this server declined, asked for by the transaction that sent it.

    Answered at the same address as an accepted one, because a client holding
    a transaction id should not have to know which way the answer went to ask
    what it said -- and the reason it is asking is usually that it does not.

    Newest of its transaction, which matters only for a request re-sent after
    a dropped connection: refused twice, two rows, and the one this client was
    holding when it gave up is the later.
    """
    models = backend.models
    for refused in models.refused_content:
        found = (
            await session.exec(
                select(refused)
                .where(
                    col(refused.workspace_id) == workspace_id,
                    col(refused.transaction) == content_id,
                    col(refused.entry_id) == entry_id,
                )
                .order_by(desc(col(refused.timestamp)))
            )
        ).first()
        if found is not None:
            return found
    return None


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
    """The same answer whether this write landed or not.

    The version a refused write reports is its TRANSACTION, not the surrogate
    key of the row keeping it: the transaction is the only name the client
    ever knew it by, and a refusal never became a token anyone can present.
    """
    models = backend.models
    if isinstance(held, models.refused_text):
        body = TextContentResponse(
            content=await refusals.text_of(
                session, models, backend.schema.text, held
            ),
            version=held.transaction,
        )
        return JSONResponse(
            body.model_dump(mode="json"), headers={"ETag": str(held.transaction)}
        )
    if isinstance(held, models.refused_blob):
        return Response(
            content=await backend.blobs.read(held.hash),
            media_type=held.mime,
            headers={"ETag": str(held.transaction), "X-Content-Hash": held.hash},
        )
    if isinstance(held, models.text_content):
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


async def referenced_by(
    backend: Backend, session: AsyncSession, workspace_id: UUID, digest: str
) -> bool:
    """Whether any write in this workspace points at these bytes.

    The blob store is shared across the deployment, so this -- not the store
    -- is what scopes a read to a workspace. `hash` is indexed, and the join
    to entries is what makes the answer this workspace's rather than anyone's.
    """
    written, entry = backend.models.blob_content, backend.models.entry
    referencing = (
        select(written)
        .join(entry, col(entry.id) == col(written.entry_id))
        .where(col(entry.workspace_id) == workspace_id, col(written.hash) == digest)
    )
    if (await session.exec(referencing)).first() is not None:
        return True

    # A write that was REFUSED names these bytes too, and they are the only
    # copy of what somebody uploaded. Reachable through `content` by its
    # transaction already; this is the other door onto the same bytes, and the
    # two disagreeing is how one of them ends up serving a 404 for something
    # the other hands over.
    refused = backend.models.refused_blob
    named = select(refused).where(
        col(refused.workspace_id) == workspace_id, col(refused.hash) == digest
    )
    return (await session.exec(named)).first() is not None


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

    @router.put("/workspaces/{workspace_id}/blobs/{digest}")
    async def store(
        digest: str,
        request: Request,
        _: UUID = Depends(authorize),
    ) -> Response:
        """Under a workspace because that is the only question a host's
        `authorize` can answer -- which is also why the id appears in the path
        and not in this signature: the host's dependency is what reads it. The
        bytes themselves are stored once for the deployment and named by their
        hash -- two workspaces holding the same file hold one copy -- but
        somebody who may reach no workspace at all may not fill the
        deployment's disk either."""
        if await backend.blobs.holds(digest):
            return JSONResponse({"rejected": False})  # idempotent by construction
        size = declared_size(request)
        if size is None or size > backend.max_blob_bytes:
            return JSONResponse({"rejected": True, "reason": "too large"}, 413)
        if not await backend.blobs.store(digest, await request.body()):
            return JSONResponse({"rejected": True, "reason": "hash mismatch"}, 409)
        return JSONResponse({"rejected": False})

    @router.get("/workspaces/{workspace_id}/blobs/{digest}")
    async def fetch_blob(
        workspace_id: Annotated[UUID, APIPath()],
        digest: str,
        _: UUID = Depends(authorize),
    ) -> Response:
        """Served only to a workspace that WRITES these bytes somewhere.

        A hash is not a secret: it travels in `X-Content-Hash`, in every
        `BinaryBody`, and through any client that ever held the file. So
        knowing one buys nothing here -- the caller has to be someone the host
        lets into a workspace whose own content log names it.
        """
        async with database.session() as session:
            referenced = await referenced_by(backend, session, workspace_id, digest)
        if not (referenced and await backend.blobs.holds(digest)):
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

    @router.get("/workspaces/{workspace_id}/drafts")
    async def stranded_drafts(
        workspace_id: Annotated[UUID, APIPath()],
        _: UUID = Depends(authorize),
    ) -> StrandedDrafts:
        """Work that is still only where it was typed.

        Uncleared drafts, which is the one question a client cannot answer for
        itself: the case worth reporting is the machine that never came back,
        and its own record of what it was holding went with it.
        """
        async with database.session() as session:
            return StrandedDrafts(drafts=await refusals.stranded(
                session, backend.models, workspace_id
            ))

    @router.post("/workspaces/{workspace_id}/drafts/cleared", status_code=204)
    async def clear_drafts(
        workspace_id: Annotated[UUID, APIPath()],
        body: Clearing,
        _: UUID = Depends(authorize),
    ) -> None:
        """These drafts' work has since reached everybody else.

        Cleared, not deleted. The row is still what that client had, and a
        snapshot may still name it.
        """
        async with database.session() as session:
            await refusals.clear(session, backend.models, workspace_id, body.transactions)
            await session.commit()

    @router.post("/workspaces/{workspace_id}/reconstruction")
    async def reconstruction(
        workspace_id: Annotated[UUID, APIPath()],
        body: ReconstructionRequest,
        _: UUID = Depends(authorize),
    ) -> ReconstructionResponse:
        """What a client was looking at, from the transactions it wrote down.

        A POST because the question is a list, and a long one -- a snapshot of
        a whole workspace names four tokens per entry. Nothing is mutated.

        The work is `reconstruct.reconstructed`, which anything inside this
        process can call directly. An assistant assembling the files a user
        could see when they asked a question wants the same answer this
        returns, and should not have to make an HTTP request to itself for it.
        """
        async with database.session() as session:
            return ReconstructionResponse(
                entries=await reconstruct.reconstructed(
                    session,
                    backend.models,
                    backend.schema.text,
                    workspace_id,
                    body.entries,
                )
            )

    @router.get(
        "/workspaces/{workspace_id}/stream",
        response_class=StreamingResponse,
        responses={
            200: {
                "model": StreamEvent,
                "content": {"text/event-stream": {}},
                "description": (
                    "One `data:` line per event, in position order, and a"
                    " `: hb` comment every heartbeat. Declared here because"
                    " this payload is what a client's confirmed map is"
                    " mutated by -- an undeclared one could not be generated."
                ),
            }
        },
    )
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
