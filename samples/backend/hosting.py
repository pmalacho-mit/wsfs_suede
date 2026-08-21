"""Wiring the room keeper to the two services it stands between.

`keeper.py` names what it needs and nothing else; these are the halves that
actually reach Liveblocks and wsfs.
"""

from __future__ import annotations

from uuid import UUID

import httpx
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from wsfs_suede.release.backend.main import Backend, resolve_content

from .keeper import Keeper
from .rooms import Held


API = "https://api.liveblocks.io"


class LiveblocksRooms:
    """Liveblocks over plain HTTP, as the token mint already reaches it.

    Not through the published SDK: it asserts the shape of the secret before
    sending anything, and this host is given a placeholder that its egress
    proxy swaps for the real key on the way out.
    """

    def __init__(self, secret: str) -> None:
        self._headers = {"Authorization": f"Bearer {secret}"}

    async def create(self, room: str) -> None:
        await self._sent(
            "POST",
            "/v2/rooms?idempotent=true",
            json={"id": room, "defaultAccesses": ["room:write"]},
        )

    async def document(self, room: str) -> bytes:
        """A room nobody has written to yet reads as nothing, not as an error."""
        answer = await self._asked("GET", f"/v2/rooms/{room}/ydoc-binary")
        return answer.content if answer.status_code == 200 else b""

    async def send(self, room: str, update: bytes) -> None:
        await self._sent(
            "PUT",
            f"/v2/rooms/{room}/ydoc",
            content=update,
            headers={"content-type": "application/octet-stream"},
        )

    async def _asked(self, method: str, path: str, **carrying) -> httpx.Response:
        headers = {**self._headers, **carrying.pop("headers", {})}
        async with httpx.AsyncClient(timeout=20) as client:
            return await client.request(method, f"{API}{path}", headers=headers, **carrying)

    async def _sent(self, method: str, path: str, **carrying) -> None:
        answer = await self._asked(method, path, **carrying)
        if answer.status_code >= 400:
            raise RuntimeError(f"liveblocks {method} {path}: {answer.status_code} {answer.text}")


class WsfsFiles:
    """What wsfs says a file holds, for a keeper that knows only entries."""

    def __init__(self, backend: Backend) -> None:
        self._backend = backend

    async def now(self, entry: str) -> Held | None:
        async with self._backend.database.session() as session:
            held = await self._held(session, UUID(entry))
            if not self._is_text(held):
                return None
            return Held(text=await self._text_of(session, held), version=str(held.id))

    async def at(self, entry: str, version: str) -> str:
        async with self._backend.database.session() as session:
            held = await self._held(session, UUID(entry), UUID(version))
            if not self._is_text(held):
                return ""
            return await self._text_of(session, held)

    async def _held(self, session: AsyncSession, entry: UUID, version: UUID | None = None):
        return await resolve_content(
            self._backend, session, await self._workspace_of(session, entry), entry, version
        )

    def _is_text(self, held: object) -> bool:
        return isinstance(held, self._backend.models.text_content)

    async def _text_of(self, session: AsyncSession, held) -> str:
        return await self._backend.schema.text.at(session, held.entry_id, held.position)

    async def _workspace_of(self, session: AsyncSession, entry: UUID) -> UUID:
        """An entry belongs to exactly one workspace, so nobody need be told."""
        rows = self._backend.models.entry
        found = (await session.exec(select(rows).where(col(rows.id) == entry))).first()
        if found is None:
            raise LookupError(f"no such entry: {entry}")
        return found.workspace_id


def keeper_over(backend: Backend, secret: str) -> Keeper:
    return Keeper(liveblocks=LiveblocksRooms(secret), files=WsfsFiles(backend))
