"""The event stream, which is the logs themselves.

One applied transaction takes exactly one workspace position, and which log
its rows landed in IS which event it was. Nothing publishes events; there is
no second write to fail independently of the first, and nothing to derive by
comparing a row against its predecessor.
"""

from __future__ import annotations

from itertools import chain, groupby
from operator import attrgetter
from typing import TypeVar, final
from uuid import UUID

from sqlalchemy import func
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from .contract import Event, Kind, Metadata, StreamEvent
from .models import (
    ContentRow,
    DeletionRow,
    EntryRow,
    Models,
    NameRow,
    ParentRow,
    TextContentRow,
    TransactionRow,
)
from .tree import Held, Node


@final
class Emitted:
    """An event and the stream position it was committed at.

    The position never reaches a client -- it exists so a stream can splice
    its replay onto its live feed without sending anything twice.
    """

    __slots__ = ("position", "event")

    def __init__(self, position: int, event: StreamEvent) -> None:
        self.position = position
        self.event = event


@final
class Positions:
    """A workspace's stream positions, handed out in order.

    Seeded from the logs when a controller takes the workspace on, and kept in
    memory after that: the controller is the workspace's only writer, so there
    is nothing else to consult. A submission that rolls back leaves a gap,
    which costs nothing -- positions have to increase, not to be dense.
    """

    def __init__(self, used: int) -> None:
        self._used = used

    @property
    def at(self) -> int:
        return self._used

    def take(self) -> int:
        self._used += 1
        return self._used


@final
class Stream:
    def __init__(self, models: Models) -> None:
        self.models = models

    @property
    def announces(self) -> dict[type[TransactionRow], Event]:
        """Which log a row landed in is which event it was."""
        return {
            self.models.name: Event.NAME,
            self.models.parent: Event.PARENT,
            self.models.deletion: Event.DELETE,
            self.models.text_content: Event.WRITE,
            self.models.blob_content: Event.WRITE,
        }

    async def _changes(
        self,
        session: AsyncSession,
        log: type[TransactionRow],
        workspace_id: UUID,
        after: int,
        through: int | None,
    ) -> list[TransactionRow]:
        entry = self.models.entry
        applied = (
            select(log)
            .join(entry, col(entry.id) == col(log.entry_id))
            .where(col(entry.workspace_id) == workspace_id, col(log.position) > after)
        )
        if through is not None:
            applied = applied.where(col(log.position) <= through)
        return list(await session.exec(applied))

    def _value(self, row: TransactionRow) -> Metadata | str | UUID | bool | None:
        """What a single-log transaction says about the entry it names."""
        if isinstance(row, NameRow):
            return row.name
        if isinstance(row, ParentRow):
            return row.parent_entry_id
        if isinstance(row, DeletionRow):
            return row.deleted
        # A write is a PURE INVALIDATION SIGNAL: cached content and its kind
        # are stale, and the next Content fetch reveals the rest.
        return None

    def _born(self, applied: list[TransactionRow], entry: EntryRow) -> Metadata:
        """A create writes every log at once, which is exactly what makes it
        recognisable: no other transaction touches more than one."""
        naming = _one(applied, NameRow)
        parentage = _one(applied, ParentRow)
        deletion = _one(applied, DeletionRow)
        content = _first(applied, ContentRow)
        return Node(
            entry=entry,
            name=naming.name,
            name_version=naming.id,
            name_position=naming.position,
            parent=parentage.parent_entry_id,
            parent_version=parentage.id,
            deleted=deletion.deleted,
            deleted_version=deletion.id,
            content=None
            if content is None
            else Held(content.id, content.position, self._kind(content)),
        ).metadata

    def _kind(self, content: ContentRow) -> Kind:
        return Kind.TEXT if isinstance(content, TextContentRow) else Kind.BINARY

    async def _event(
        self, session: AsyncSession, applied: list[TransactionRow]
    ) -> Emitted:
        caused = applied[0]
        entry = await session.get(self.models.entry, caused.entry_id)
        assert entry is not None
        created = len(applied) > 1
        return Emitted(
            position=caused.position,
            event=StreamEvent(
                type=Event.CREATE if created else self.announces[type(caused)],
                id=caused.entry_id,
                transaction=caused.id,
                value=self._born(applied, entry) if created else self._value(caused),
                user=caused.user_id,
            ),
        )

    async def _between(
        self, session: AsyncSession, workspace_id: UUID, after: int, through: int | None
    ) -> list[Emitted]:
        applied = sorted(
            chain.from_iterable(
                [
                    await self._changes(session, log, workspace_id, after, through)
                    for log in self.announces
                ]
            ),
            key=lambda row: (row.position, row.id),
        )
        # Grouped by the transaction that wrote them, which is what actually
        # makes rows one event. Position only orders the result -- so two
        # writers that somehow collided on one would produce an ugly stream,
        # never a wrong one.
        return [
            await self._event(session, list(rows))
            for _, rows in groupby(applied, key=attrgetter("id"))
        ]

    async def since(
        self, session: AsyncSession, workspace_id: UUID, position: int
    ) -> list[Emitted]:
        return await self._between(session, workspace_id, after=position, through=None)

    async def at(
        self, session: AsyncSession, workspace_id: UUID, position: int
    ) -> Emitted:
        (emitted,) = await self._between(
            session, workspace_id, after=position - 1, through=position
        )
        return emitted

    async def high_water(self, session: AsyncSession, workspace_id: UUID) -> int:
        """The last position this workspace used, read out of the logs.

        Not out of a stored counter: a counter is only as current as its last
        write, and a process that dies without ceremony would leave the next
        one re-issuing positions that are already committed. The rows cannot
        lie.
        """
        entry = self.models.entry
        used: list[int | None] = [
            (
                await session.exec(
                    select(func.max(col(log.position)))
                    .join(entry, col(entry.id) == col(log.entry_id))
                    .where(col(entry.workspace_id) == workspace_id)
                )
            ).one()
            for log in self.announces
        ]
        return max((position for position in used if position is not None), default=0)


Row = TypeVar("Row", bound=TransactionRow)


def _one(applied: list[TransactionRow], kind: type[Row]) -> Row:
    """The row a create wrote to one particular log -- there is exactly one."""
    (found,) = (row for row in applied if isinstance(row, kind))
    return found


def _first(applied: list[TransactionRow], kind: type[Row]) -> Row | None:
    """A folder is born without content, so this one may be missing."""
    return next((row for row in applied if isinstance(row, kind)), None)
