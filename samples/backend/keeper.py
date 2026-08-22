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
    Rebase,
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
        self._base: dict[str, str] = {}
        """The version each room's text is believed to descend from.

        THE WHOLE POINT OF KEEPING IT HERE. Every client with a file open asks
        this host to settle its room each time anybody writes -- so if
        answering that meant reading the collaboration server, one person
        typing would cost a round trip per collaborator per save. Held here,
        the answer is almost always "nothing to do" and costs nothing.

        Lost on restart, which costs one read per room the first time it is
        asked about, and nothing after.
        """

    async def ensure(self, entry: str) -> str | None:
        """Make this room say what the file says, and answer where it stands.

        Free when there is nothing to do: the common case by a wide margin,
        because the common reason to ask is that somebody just saved and every
        other client heard about it.
        """
        file = await self._files.now(entry)
        if file is None:
            return None
        if self._base.get(entry) == file.version:
            return file.version
        async with self._alone_with(entry):
            if self._base.get(entry) == file.version:
                return file.version
            await self._created_once(entry)
            await self._settle(entry, file)
        return self._base.get(entry)

    async def stored(self, entry: str, version: str) -> None:
        """A room member wrote the file, so the room already holds its text.

        Nothing is sent anywhere. This is the whole saving: the alternative is
        every client that hears about the write asking the collaboration
        server what the room contains, which it already knows.
        """
        self._base[entry] = version

    async def hand_over(self, entry: str, update: bytes) -> None:
        """Put one client's own update into the room on its behalf.

        For a client that can reach THIS server but not the collaboration one.
        Its work would otherwise sit on its machine until that connection came
        back, which can be a long time and is not a good enough reason for
        nobody else to see it.

        Forwarded rather than interpreted. The update carries its own
        identities, so it merges exactly once however many routes it arrives
        by -- including the client's own connection when that returns.
        """
        async with self._alone_with(entry):
            await self._created_once(entry)
            await self._liveblocks.send(entry, update)

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

    async def _settle(self, entry: str, file: Held) -> None:
        room = standing_of(await self._liveblocks.document(entry), self._base.get(entry))
        await self._act(entry, plan(room, file))
        self._base[entry] = file.version

    async def _act(self, entry: str, wanted: Plan) -> None:
        if isinstance(wanted, Settled):
            return
        if isinstance(wanted, Seed):
            await self._liveblocks.send(entry, seeded(wanted.text))
            return
        if isinstance(wanted, Rebase):
            return  # the room already says it; only this host had to be told
        await self._carry(entry, wanted)

    async def _carry(self, entry: str, wanted: Carry) -> None:
        """Built on the room as it stands NOW, re-read rather than remembered.

        A Yjs update computed against a stale document is dropped without a
        word, so the read that decided this cannot be the read it is built on.
        """
        now = await self._files.now(entry)
        if now is None:
            return
        change = Change(
            before=await self._files.at(entry, wanted.since),
            after=now.text,
        )
        live = await self._liveblocks.document(entry)
        update = self._closing(live, change)
        if update is not None:
            await self._liveblocks.send(entry, update)

    def _closing(self, live: bytes, change: Change) -> bytes | None:
        """What to send, decided against the read it is built on.

        The decision was taken on an EARLIER read, and a room that caught up in
        between already holds what this was going to insert. Inserting it again
        is the doubling the whole design exists to prevent, and a CRDT cannot
        notice that two inserts say the same thing -- so the question is asked
        once more, here, where the answer cannot go stale.
        """
        if standing_of(live, None).text == change.after:
            return None
        return carried(live, change)
