"""Keeping each entry's Liveblocks room in step with its file.

The seeding race the browsers used to run among themselves, moved to the one
place that has a lock to settle it with.
"""

from __future__ import annotations

import asyncio
from typing import Protocol

from .rooms import (
    Carry,
    Change,
    Held,
    Plan,
    Seed,
    Settled,
    carried,
    plan,
    seeded,
    standing_of,
)


class Liveblocks(Protocol):
    async def create(self, room: str) -> None: ...
    async def document(self, room: str) -> bytes: ...
    async def send(self, room: str, update: bytes) -> None: ...


class Files(Protocol):
    async def now(self, entry: str) -> Held | None:
        """What the file says, or None when it is not text a room can hold."""

    async def at(self, entry: str, version: str) -> str: ...


class Keeper:
    def __init__(self, *, liveblocks: Liveblocks, files: Files) -> None:
        self._liveblocks = liveblocks
        self._files = files
        self._alone: dict[str, asyncio.Lock] = {}
        self._created: set[str] = set()

    async def ensure(self, entry: str) -> None:
        async with self._alone_with(entry):
            await self._created_once(entry)
            await self._settle(entry)

    def _alone_with(self, entry: str) -> asyncio.Lock:
        """One entry at a time, and only against itself.

        A registry-wide lock would put every first open behind one round trip
        to Liveblocks.
        """
        return self._alone.setdefault(entry, asyncio.Lock())

    async def _created_once(self, entry: str) -> None:
        if entry in self._created:
            return
        await self._liveblocks.create(entry)
        self._created.add(entry)

    async def _settle(self, entry: str) -> None:
        file = await self._files.now(entry)
        if file is None:
            return
        room = standing_of(await self._liveblocks.document(entry))
        await self._act(entry, plan(room, file))

    async def _act(self, entry: str, wanted: Plan) -> None:
        if isinstance(wanted, Settled):
            return
        if isinstance(wanted, Seed):
            await self._liveblocks.send(entry, seeded(wanted.text, wanted.version))
            return
        await self._carry(entry, wanted)

    async def _carry(self, entry: str, wanted: Carry) -> None:
        """Built on the room as it stands NOW, re-read rather than remembered.

        A Yjs update computed against a stale document is dropped without a
        word, so the read that decided this is not the read that may build it.
        """
        now = await self._files.now(entry)
        if now is None:
            return
        change = Change(
            before=await self._files.at(entry, wanted.since),
            after=now.text,
        )
        live = await self._liveblocks.document(entry)
        await self._liveblocks.send(entry, carried(live, change, wanted.version))
