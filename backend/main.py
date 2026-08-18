"""FastAPI wiring, controller edition.

Every WRITE (transactional requests and Initialize) flows through the
workspace's controller: serialized per workspace, fan-out after commit.
READS (Content, blobs) bypass the controller — MVCC handles them.

Because Initialize runs inside the controller's serialization, it sees no
concurrent same-workspace writes: its one-consistent-view guarantee comes
from exclusion, not isolation levels (this replaced TODO's REPEATABLE READ
plan).

TOPOLOGY INVARIANT (ARCHITECTURE.md #11): exactly one process serves a
workspace's writes and streams. Deploy with max one instance, or add sticky
routing / a cross-process bus (TODO §3) before scaling out.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
from contextlib import asynccontextmanager
from datetime import timedelta, timezone
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from sqlmodel import Session, SQLModel, create_engine, select

from . import service
from .controller import ControllerRegistry
from .models import (
    BlobRecord,
    ContentVersion,
    Entry,
    EntryVersion,
    EventRow,
    StreamToken,
    Workspace,
    utcnow,
)

TOKEN_TTL = timedelta(seconds=60)


def create_app(db_url: str = "sqlite://", blob_dir: str | None = None,
               heartbeat_seconds: float = 15.0,
               grace_seconds: float = 30.0) -> FastAPI:
    engine = create_engine(
        db_url,
        connect_args={"check_same_thread": False} if db_url.startswith("sqlite") else {},
        poolclass=__import__("sqlalchemy.pool", fromlist=["StaticPool"]).StaticPool
        if db_url == "sqlite://" else None,
    )
    SQLModel.metadata.create_all(engine)

    registry = ControllerRegistry(grace_seconds=grace_seconds)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        await registry.shutdown()

    app = FastAPI(title="wsfs", lifespan=lifespan)
    app.state.engine = engine
    app.state.registry = registry
    app.state.blob_dir = Path(blob_dir or "/tmp/wsfs-blobs")
    app.state.blob_dir.mkdir(parents=True, exist_ok=True)
    app.state.heartbeat = heartbeat_seconds

    def get_session() -> AsyncIterator[Session]:  # type: ignore[misc]
        with Session(engine) as session:
            yield session

    def user(x_user: str = Header(default="anon")) -> str:
        return x_user

    def ensure_workspace(session: Session, ws: str) -> Workspace:
        w = session.get(Workspace, ws)
        if w is None:
            w = Workspace(id=ws, position=0)
            session.add(w)
            session.flush()
        return w

    # -- Initialize: the reconciliation handshake, inside the controller ------

    @app.post("/workspaces/{ws}/initialize")
    async def initialize(ws: str, body: dict, u: str = Depends(user)) -> dict[str, Any]:
        controller = await registry.visit(ws)

        def fn() -> tuple[dict[str, Any], list[tuple[int, str]]]:
            """ONE db transaction: adjudicate the outbox in order (unseen
            transactions applied now), snapshot, mint the position-bound
            token. Runs serialized by the controller, so the view is
            consistent by exclusion. Splitting this apart silently kills the
            no-flicker/no-gap guarantees (ARCHITECTURE.md invariant 2)."""
            with Session(engine) as session:
                workspace = ensure_workspace(session, ws)
                applied: list[str] = []
                rejected: list[dict[str, Any]] = []
                events: list[tuple[int, str]] = []
                for item in body.get("outbox", []):
                    outcome = service.HANDLERS[item["op"]](session, ws, u, item)
                    events.extend(outcome.events)
                    if outcome.rejected:
                        r: dict[str, Any] = {"transaction": item["transaction"],
                                             "reason": outcome.reason}
                        if outcome.conflict_version:
                            r["version"] = outcome.conflict_version
                        rejected.append(r)
                    else:
                        applied.append(item["transaction"])
                session.flush()
                entries = service.snapshot(session, ws)
                session.refresh(workspace)
                token = secrets.token_hex(16)
                session.add(StreamToken(token=token, user=u, workspace_id=ws,
                                        position=workspace.position,
                                        expires=utcnow() + TOKEN_TTL))
                session.commit()
                return ({"token": token, "entries": entries,
                         "applied": applied, "rejected": rejected}, events)

        return await controller.submit(fn)

    # -- Transactional requests ------------------------------------------------

    @app.post("/workspaces/{ws}/tx/{op}")
    async def transact(ws: str, op: str, body: dict,
                       u: str = Depends(user)) -> dict[str, Any]:
        if op not in service.HANDLERS:
            raise HTTPException(404)
        controller = await registry.visit(ws)

        def fn() -> tuple[dict[str, Any], list[tuple[int, str]]]:
            with Session(engine) as session:
                ensure_workspace(session, ws)
                outcome = service.HANDLERS[op](session, ws, u, body)
                session.commit()
                return outcome.to_response(), outcome.events

        return await controller.submit(fn)

    # -- Blobs: raw HTTP, hash-verified, idempotent — bypass the controller ----

    @app.put("/blobs/{hash_}")
    async def put_blob(hash_: str, request: Request,
                       session: Session = Depends(get_session)) -> dict[str, Any]:
        if session.get(BlobRecord, hash_) is not None:
            return {"rejected": False}  # duplicate hash: ack without storing
        body = await request.body()
        if hashlib.sha256(body).hexdigest() != hash_:
            return {"rejected": True, "reason": "hash mismatch"}
        mime = request.headers.get("content-type", "application/octet-stream")
        (app.state.blob_dir / hash_).write_bytes(body)
        session.add(BlobRecord(hash=hash_, size=len(body), mime=mime))
        session.commit()
        return {"rejected": False}

    # -- Content fetch: pure read — bypass the controller -----------------------

    @app.get("/workspaces/{ws}/entries/{entry_id}/content")
    def content(ws: str, entry_id: str, version: str | None = None,
                session: Session = Depends(get_session)) -> Response:
        entry = session.get(Entry, entry_id)
        if entry is None or entry.workspace_id != ws:
            raise HTTPException(404)
        ev = session.get(EntryVersion, version or entry.version)
        if ev is None or ev.entry_id != entry_id or ev.content_id is None:
            raise HTTPException(404)
        cv = session.get(ContentVersion, ev.content_id)
        assert cv is not None
        if cv.kind == "text":
            return Response(
                content=json.dumps({"type": "text", "content": cv.text,
                                    "version": ev.id}),
                media_type="application/json", headers={"ETag": ev.id})
        data = (app.state.blob_dir / (cv.hash or "")).read_bytes()
        return Response(content=data, media_type=cv.mime,
                        headers={"ETag": ev.id, "X-Content-Hash": cv.hash or ""})

    # -- The stream ---------------------------------------------------------------

    @app.get("/workspaces/{ws}/stream")
    async def stream(ws: str, token: str) -> StreamingResponse:
        # Claim the token atomically: single-use enforcement + lookup.
        with Session(engine) as session:
            row = session.get(StreamToken, token)
            expired = row is not None and (
                row.expires.replace(tzinfo=row.expires.tzinfo or timezone.utc) < utcnow())
            if row is None or row.workspace_id != ws or expired:
                raise HTTPException(401, "invalid or spent token")
            position = row.position
            session.delete(row)
            session.commit()

        # Subscribe FIRST (events during the replay land in the queue),
        # replay EventRow after the token's position SECOND, then follow
        # live. Overlap between the two is deduped by position.
        q: asyncio.Queue[tuple[int, str]] = asyncio.Queue()
        await registry.acquire_stream(ws, q)

        async def gen() -> AsyncIterator[str]:
            cursor = position
            try:
                with Session(engine) as s:
                    rows = s.exec(
                        select(EventRow)
                        .where(EventRow.workspace_id == ws,
                               EventRow.position > cursor)
                        .order_by(EventRow.position)
                    ).all()
                for r in rows:
                    cursor = r.position
                    yield f"data: {r.payload}\n\n"
                while True:
                    try:
                        pos, payload = await asyncio.wait_for(
                            q.get(), timeout=app.state.heartbeat)
                    except asyncio.TimeoutError:
                        yield ": hb\n\n"
                        continue
                    if pos <= cursor:
                        continue  # replay/live overlap: already sent
                    cursor = pos
                    yield f"data: {payload}\n\n"
            finally:
                await registry.release_stream(ws, q)

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache",
                                          "X-Accel-Buffering": "no"})

    return app


app = create_app()
