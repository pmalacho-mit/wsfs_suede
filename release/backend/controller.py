"""Per-workspace controller (the actor pattern).

One controller per workspace per process. All writes — transactional
requests AND Initialize — flow through submit(), which serializes them on an
asyncio lock and fans out committed events to subscribed streams. Reads
(Content, blobs) bypass the controller entirely; MVCC handles them.

Design rules (see ARCHITECTURE.md invariant 11 and TODO §3):
- The controller COORDINATES; Postgres remains the truth. Controller memory
  is rebuildable-from-zero: fan-out happens strictly AFTER the db commit,
  and the connect-time splice reads EventRow, so a process restart loses
  nothing.
- Only streams participate in the refcount. Mutations are transient
  visitors (visit()): pinning them buys nothing but decrement-forgetting
  bugs; the grace period protects mid-flight work.
- Release is grace-delayed (~30s): the client sync loop turns every network
  blip into a disconnect/reconnect pair, and count-to-zero-destroy would
  churn the controller on each one.
- TOPOLOGY INVARIANT: "one controller per workspace" is only true within a
  process. Exactly one process may serve a workspace's writes and streams.
  The row lock in service._commit stays as split-brain insurance; the
  Postgres advisory lock (TODO §3) makes an accidental second instance fail
  loudly instead of silently coexisting.
"""
from __future__ import annotations

import asyncio
from typing import Any, Callable, TypeVar

T = TypeVar("T")

# fn runs in a worker thread, owns its own db session, commits inside, and
# returns (result, events) where events = [(position, payload_json), ...].
SubmitFn = Callable[[], tuple[T, list[tuple[int, str]]]]


class WorkspaceController:
    def __init__(self, workspace_id: str) -> None:
        self.workspace_id = workspace_id
        self._serial = asyncio.Lock()  # the queue: one write at a time
        self.streams: set[asyncio.Queue[tuple[int, str]]] = set()

    async def submit(self, fn: SubmitFn[T]) -> T:
        async with self._serial:
            result, events = await asyncio.to_thread(fn)
            # Fan out inside the lock: stream queues observe events in
            # exactly commit order, by construction rather than by protocol.
            for position, payload in events:
                for q in list(self.streams):
                    q.put_nowait((position, payload))
            return result


class ControllerRegistry:
    """Owns controller lifecycle. One asyncio.Lock guards get-or-create AND
    release, with release re-checking the count inside the lock — closing
    the release-vs-acquire race (count hits zero, teardown starts, a new
    stream grabs a dying controller)."""

    def __init__(self, grace_seconds: float = 30.0) -> None:
        self.grace_seconds = grace_seconds
        self._controllers: dict[str, WorkspaceController] = {}
        self._counts: dict[str, int] = {}
        self._pending: dict[str, asyncio.Task[None]] = {}
        self._lock = asyncio.Lock()

    # -- access -----------------------------------------------------------

    async def visit(self, workspace_id: str) -> WorkspaceController:
        """Transient access for mutations/Initialize: no pinning."""
        async with self._lock:
            c = self._get_or_create(workspace_id)
            self._schedule_release_if_idle(workspace_id)
            return c

    async def acquire_stream(self, workspace_id: str,
                             queue: asyncio.Queue[tuple[int, str]]) -> WorkspaceController:
        async with self._lock:
            c = self._get_or_create(workspace_id)
            self._counts[workspace_id] = self._counts.get(workspace_id, 0) + 1
            pending = self._pending.pop(workspace_id, None)
            if pending:
                pending.cancel()  # reconnect within the grace window
            c.streams.add(queue)
            return c

    async def release_stream(self, workspace_id: str,
                             queue: asyncio.Queue[tuple[int, str]]) -> None:
        async with self._lock:
            c = self._controllers.get(workspace_id)
            if c is None:
                return
            c.streams.discard(queue)
            self._counts[workspace_id] = max(0, self._counts.get(workspace_id, 0) - 1)
            self._schedule_release_if_idle(workspace_id)

    # -- lifecycle ----------------------------------------------------------

    def _get_or_create(self, workspace_id: str) -> WorkspaceController:
        c = self._controllers.get(workspace_id)
        if c is None:
            c = WorkspaceController(workspace_id)
            self._controllers[workspace_id] = c
        return c

    def _schedule_release_if_idle(self, workspace_id: str) -> None:
        if (self._counts.get(workspace_id, 0) == 0
                and workspace_id not in self._pending):
            self._pending[workspace_id] = asyncio.get_running_loop().create_task(
                self._release_later(workspace_id))

    async def _release_later(self, workspace_id: str) -> None:
        try:
            await asyncio.sleep(self.grace_seconds)
        except asyncio.CancelledError:
            return
        async with self._lock:
            self._pending.pop(workspace_id, None)
            if self._counts.get(workspace_id, 0) == 0:  # re-check INSIDE the lock
                self._controllers.pop(workspace_id, None)
                self._counts.pop(workspace_id, None)

    async def shutdown(self) -> None:
        async with self._lock:
            for t in self._pending.values():
                t.cancel()
            self._pending.clear()
            self._controllers.clear()
            self._counts.clear()

    # -- introspection (tests, ops) ------------------------------------------

    def live(self, workspace_id: str) -> WorkspaceController | None:
        return self._controllers.get(workspace_id)

    def count(self, workspace_id: str) -> int:
        return self._counts.get(workspace_id, 0)
