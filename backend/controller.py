"""Per-workspace controller (the actor pattern).

One controller per workspace per process. All writes -- transactional requests
AND Initialize -- flow through submit(), which serializes them and fans
committed events out to subscribed streams. Reads (Content, blobs) bypass it
entirely; MVCC handles them.

Initialize's one-consistent-view guarantee comes from that exclusion, not from
an isolation level.

TOPOLOGY: "one controller per workspace" is only true within a process, and
stream positions are counted in that process's memory -- so exactly one
process may serve a workspace's writes, and nothing here enforces it. That is
deliberately the operator's promise (ARCHITECTURE.md invariant 11): the
database holds no lock, no lease and no connection on a workspace's behalf,
which is what makes a live workspace cost nothing to keep.

What keeps a second writer from changing the MEANING of a stream, rather than
merely making it ugly, is that events are grouped by the transaction that
caused them rather than by the position they landed at.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Awaitable
from contextlib import asynccontextmanager
from typing import Callable, TypeVar, final
from uuid import UUID

from .stream import Emitted, Positions, Stream
from ...wsfs_suede__sqlmodel_utils_suede.postgres.db import Database

T = TypeVar("T")

# fn owns its own db session, commits inside, and returns its result plus the
# events that commit produced.
SubmitFn = Callable[[], Awaitable[tuple[T, list[Emitted]]]]


@final
class WorkspaceController:
    def __init__(self, workspace_id: UUID, positions: Positions) -> None:
        self.workspace_id = workspace_id
        self.positions = positions
        self._serial = asyncio.Lock()  # the queue: one write at a time
        self.streams: set[asyncio.Queue[Emitted]] = set()

    async def submit(self, fn: SubmitFn[T]) -> T:
        async with self._serial:
            result, events = await fn()
            # Fan out inside the lock, so stream queues observe events in
            # commit order by construction rather than by protocol.
            for event in events:
                for queue in list(self.streams):
                    queue.put_nowait(event)
            return result


@final
class ControllerRegistry:
    """Owns controller lifecycle. One lock guards get-or-create AND release,
    with release re-checking the count inside the lock -- closing the race
    where a count hits zero, teardown starts, and a new stream grabs a dying
    controller.

    Release is grace-delayed: the client sync loop turns every network blip
    into a disconnect/reconnect pair, and count-to-zero-destroy would rebuild
    the controller (and re-read its position) on each one.
    """

    def __init__(
        self, database: Database, stream: Stream, *, grace_seconds: float = 30.0
    ) -> None:
        self._database = database
        self._stream = stream
        self.grace_seconds = grace_seconds
        self._controllers: dict[UUID, WorkspaceController] = {}
        self._counts: dict[UUID, int] = {}
        self._pending: dict[UUID, asyncio.Task[None]] = {}
        self._lock = asyncio.Lock()

    # -- access -----------------------------------------------------------

    @asynccontextmanager
    async def visiting(self, workspace_id: UUID) -> AsyncGenerator[WorkspaceController]:
        """Access for one mutation or Initialize, held for its duration.

        Held, not transient, because the controller carries the workspace's
        position counter: retiring it while a submission is in flight would
        let its successor re-seed from rows that have not committed yet, and
        hand out a position that is about to be taken.
        """
        controller = await self._enter(workspace_id)
        try:
            yield controller
        finally:
            await self._leave(workspace_id)

    async def acquire_stream(
        self, workspace_id: UUID, queue: asyncio.Queue[Emitted]
    ) -> WorkspaceController:
        controller = await self._enter(workspace_id)
        async with self._lock:
            controller.streams.add(queue)
        return controller

    async def release_stream(
        self, workspace_id: UUID, queue: asyncio.Queue[Emitted]
    ) -> None:
        async with self._lock:
            controller = self._controllers.get(workspace_id)
            if controller is not None:
                controller.streams.discard(queue)
        await self._leave(workspace_id)

    async def _enter(self, workspace_id: UUID) -> WorkspaceController:
        async with self._lock:
            controller = await self._get_or_create(workspace_id)
            self._counts[workspace_id] = self._counts.get(workspace_id, 0) + 1
            returned_within_grace = self._pending.pop(workspace_id, None)
            if returned_within_grace:
                _ = returned_within_grace.cancel()
            return controller

    async def _leave(self, workspace_id: UUID) -> None:
        async with self._lock:
            self._counts[workspace_id] = max(0, self._counts.get(workspace_id, 0) - 1)
            self._schedule_release_if_idle(workspace_id)

    # -- lifecycle ----------------------------------------------------------

    async def _get_or_create(self, workspace_id: UUID) -> WorkspaceController:
        existing = self._controllers.get(workspace_id)
        if existing is not None:
            return existing
        controller = WorkspaceController(
            workspace_id, Positions(await self._used_positions(workspace_id))
        )
        self._controllers[workspace_id] = controller
        return controller

    async def _used_positions(self, workspace_id: UUID) -> int:
        async with self._database.session() as session:
            return await self._stream.high_water(session, workspace_id)

    def _schedule_release_if_idle(self, workspace_id: UUID) -> None:
        idle = self._counts.get(workspace_id, 0) == 0
        if idle and workspace_id not in self._pending:
            self._pending[workspace_id] = asyncio.get_running_loop().create_task(
                self._release_later(workspace_id)
            )

    async def _release_later(self, workspace_id: UUID) -> None:
        try:
            await asyncio.sleep(self.grace_seconds)
        except asyncio.CancelledError:
            return
        async with self._lock:
            _ = self._pending.pop(workspace_id, None)
            if self._counts.get(workspace_id, 0) == 0:  # re-check INSIDE the lock
                self._retire(workspace_id)

    def _retire(self, workspace_id: UUID) -> None:
        """Nothing to hand back: the position counter is rebuilt from the logs
        by whichever controller takes the workspace on next."""
        _ = self._counts.pop(workspace_id, None)
        _ = self._controllers.pop(workspace_id, None)

    async def shutdown(self) -> None:
        async with self._lock:
            for pending in self._pending.values():
                _ = pending.cancel()
            self._pending.clear()
            for workspace_id in list(self._controllers):
                self._retire(workspace_id)

    # -- introspection (tests, ops) ------------------------------------------

    def live(self, workspace_id: UUID) -> WorkspaceController | None:
        return self._controllers.get(workspace_id)

    def count(self, workspace_id: UUID) -> int:
        return self._counts.get(workspace_id, 0)
