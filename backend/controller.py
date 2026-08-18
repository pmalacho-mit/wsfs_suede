"""Per-workspace controller (the actor pattern).

One controller per workspace per process. All writes -- transactional requests
AND Initialize -- flow through submit(), which serializes them and fans
committed events out to subscribed streams. Reads (Content, blobs) bypass it
entirely; MVCC handles them.

Initialize's one-consistent-view guarantee comes from that exclusion, not from
an isolation level.

TOPOLOGY: "one controller per workspace" is only true within a process, so
exactly one process may serve a workspace's writes and streams. The lease
below makes a second one fail loudly rather than silently coexist, and the
workspace row lock in service._next_position stays as the insurance under it.
"""

from __future__ import annotations

import asyncio
from typing import Callable, TypeVar
from uuid import UUID

from sqlalchemy import Engine, text

from .stream import Emitted

T = TypeVar("T")

# fn runs in a worker thread, owns its own db session, commits inside, and
# returns its result plus the events that commit produced.
SubmitFn = Callable[[], tuple[T, list[Emitted]]]


class WorkspaceServedElsewhere(RuntimeError):
    def __init__(self, workspace_id: UUID) -> None:
        super().__init__(
            f"another process holds the write lease for workspace {workspace_id}"
        )


class Lease:
    """The exclusive right to serve one workspace, as a session-level Postgres
    advisory lock on a connection held for the controller's lifetime."""

    def __init__(self, engine: Engine, workspace_id: UUID) -> None:
        self._workspace_id = workspace_id
        self._connection = engine.connect().execution_options(
            isolation_level="AUTOCOMMIT"
        )

    def claim(self) -> None:
        claimed = self._connection.execute(
            text("SELECT pg_try_advisory_lock(hashtext(:key))"),
            {"key": f"wsfs:{self._workspace_id}"},
        ).scalar_one()
        if not claimed:
            self._connection.close()
            raise WorkspaceServedElsewhere(self._workspace_id)

    def release(self) -> None:
        try:
            self._connection.execute(
                text("SELECT pg_advisory_unlock(hashtext(:key))"),
                {"key": f"wsfs:{self._workspace_id}"},
            )
        finally:
            self._connection.close()


class WorkspaceController:
    def __init__(self, workspace_id: UUID, lease: Lease) -> None:
        self.workspace_id = workspace_id
        self.lease = lease
        self._serial = asyncio.Lock()  # the queue: one write at a time
        self.streams: set[asyncio.Queue[Emitted]] = set()

    async def submit(self, fn: SubmitFn[T]) -> T:
        async with self._serial:
            result, events = await asyncio.to_thread(fn)
            # Fan out inside the lock, so stream queues observe events in
            # commit order by construction rather than by protocol.
            for event in events:
                for queue in list(self.streams):
                    queue.put_nowait(event)
            return result


class ControllerRegistry:
    """Owns controller lifecycle. One lock guards get-or-create AND release,
    with release re-checking the count inside the lock -- closing the race
    where a count hits zero, teardown starts, and a new stream grabs a dying
    controller.

    Release is grace-delayed: the client sync loop turns every network blip
    into a disconnect/reconnect pair, and count-to-zero-destroy would rebuild
    the controller (and re-take its lease) on each one.
    """

    def __init__(self, lease_engine: Engine, *, grace_seconds: float = 30.0) -> None:
        self._lease_engine = lease_engine
        self.grace_seconds = grace_seconds
        self._controllers: dict[UUID, WorkspaceController] = {}
        self._counts: dict[UUID, int] = {}
        self._pending: dict[UUID, asyncio.Task[None]] = {}
        self._lock = asyncio.Lock()

    # -- access -----------------------------------------------------------

    async def visit(self, workspace_id: UUID) -> WorkspaceController:
        """Transient access for mutations and Initialize: no pinning. Pinning
        them would buy nothing but decrement-forgetting bugs; the grace period
        already protects mid-flight work."""
        async with self._lock:
            controller = await self._get_or_create(workspace_id)
            self._schedule_release_if_idle(workspace_id)
            return controller

    async def acquire_stream(
        self, workspace_id: UUID, queue: asyncio.Queue[Emitted]
    ) -> WorkspaceController:
        async with self._lock:
            controller = await self._get_or_create(workspace_id)
            self._counts[workspace_id] = self._counts.get(workspace_id, 0) + 1
            reconnected_within_grace = self._pending.pop(workspace_id, None)
            if reconnected_within_grace:
                reconnected_within_grace.cancel()
            controller.streams.add(queue)
            return controller

    async def release_stream(
        self, workspace_id: UUID, queue: asyncio.Queue[Emitted]
    ) -> None:
        async with self._lock:
            controller = self._controllers.get(workspace_id)
            if controller is None:
                return
            controller.streams.discard(queue)
            self._counts[workspace_id] = max(0, self._counts.get(workspace_id, 0) - 1)
            self._schedule_release_if_idle(workspace_id)

    # -- lifecycle ----------------------------------------------------------

    async def _get_or_create(self, workspace_id: UUID) -> WorkspaceController:
        existing = self._controllers.get(workspace_id)
        if existing is not None:
            return existing
        lease = Lease(self._lease_engine, workspace_id)
        await asyncio.to_thread(lease.claim)
        controller = WorkspaceController(workspace_id, lease)
        self._controllers[workspace_id] = controller
        return controller

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
            self._pending.pop(workspace_id, None)
            if self._counts.get(workspace_id, 0) == 0:  # re-check INSIDE the lock
                await self._retire(workspace_id)

    async def _retire(self, workspace_id: UUID) -> None:
        controller = self._controllers.pop(workspace_id, None)
        self._counts.pop(workspace_id, None)
        if controller is not None:
            await asyncio.to_thread(controller.lease.release)

    async def shutdown(self) -> None:
        async with self._lock:
            for pending in self._pending.values():
                pending.cancel()
            self._pending.clear()
            for workspace_id in list(self._controllers):
                await self._retire(workspace_id)

    # -- introspection (tests, ops) ------------------------------------------

    def live(self, workspace_id: UUID) -> WorkspaceController | None:
        return self._controllers.get(workspace_id)

    def count(self, workspace_id: UUID) -> int:
        return self._counts.get(workspace_id, 0)
