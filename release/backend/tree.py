"""What the tree currently denotes.

An entry's name, parent, deletion and content each live in their own log, so
"the current tree" is a query, not a table: for every entry, the newest row in
each of those logs.

Every query here is a query over ONE schema, which is why this is a class
rather than a module of functions -- the schema is the thing they all share,
and it is not known until a host says which tables its users and workspaces
live in.
"""

from __future__ import annotations

from dataclasses import dataclass
from collections.abc import AsyncIterator
from typing import Any, NamedTuple, final
from uuid import UUID

from sqlalchemy import ColumnElement, Row, func, literal, true, union_all
from sqlalchemy.orm import aliased
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from .contract import Kind, Metadata
from .models import (
    ContentRow,
    DeletionRow,
    EntryRow,
    Models,
    NameRow,
    ParentRow,
    TransactionRow,
    Type,
)

BEFORE_ANY_POSITION = 0


@final
@dataclass(frozen=True)
class Held:
    """Which write currently holds an entry's content, and where it landed."""

    version: UUID
    position: int
    kind: Kind


@final
@dataclass(frozen=True)
class Node:
    """One entry as of the newest row in each of its logs."""

    entry: EntryRow
    name: str
    name_version: UUID
    name_position: int
    parent: UUID | None
    parent_version: UUID
    deleted: bool
    deleted_version: UUID
    content: Held | None

    @property
    def id(self) -> UUID:
        return self.entry.id

    @property
    def is_folder(self) -> bool:
        return self.entry.type is Type.FOLDER

    @property
    def content_version(self) -> UUID | None:
        return None if self.content is None else self.content.version

    @property
    def content_position(self) -> int:
        return BEFORE_ANY_POSITION if self.content is None else self.content.position

    @property
    def metadata(self) -> Metadata:
        return Metadata(
            id=self.entry.id,
            type=self.entry.type,
            name=self.name,
            parent=self.parent,
            deleted=self.deleted or None,
            name_version=self.name_version,
            parent_version=self.parent_version,
            deleted_version=self.deleted_version,
            content_version=self.content_version,
        )


class Namespace(NamedTuple):
    """Every entry of a workspace, joined to the rows that place it."""

    statement: Any
    name: type[NameRow]
    parent: type[ParentRow]
    deletion: type[DeletionRow]


def node_of(row: Row[Any]) -> Node:
    entry, name, parent, deletion, version, position, kind = row
    return Node(
        entry=entry,
        name=name.name,
        name_version=name.id,
        name_position=name.position,
        parent=parent.parent_entry_id,
        parent_version=parent.id,
        deleted=deletion.deleted,
        deleted_version=deletion.id,
        content=None if version is None else Held(version, position, Kind(kind)),
    )


@final
class Tree:
    def __init__(self, models: Models) -> None:
        self.models = models

    # -- the shapes every query below is built from --------------------------

    def _newest(self, log: type[TransactionRow], workspace_id: UUID) -> Any:
        """Each entry's most recent change to one property."""
        entry = self.models.entry
        return aliased(
            log,
            (
                select(log)
                .join(entry, col(entry.id) == col(log.entry_id))
                .where(col(entry.workspace_id) == workspace_id)
                .distinct(col(log.entry_id))
                .order_by(col(log.entry_id), col(log.position).desc())
                .subquery()
            ),
        )

    def _namespace(self, workspace_id: UUID) -> Namespace:
        entry = self.models.entry
        name, parent, deletion = (
            self._newest(log, workspace_id)
            for log in (self.models.name, self.models.parent, self.models.deletion)
        )
        return Namespace(
            statement=(
                select(entry, name, parent, deletion)
                .join(name, col(name.entry_id) == col(entry.id))
                .join(parent, col(parent.entry_id) == col(entry.id))
                .join(deletion, col(deletion.entry_id) == col(entry.id))
                .where(col(entry.workspace_id) == workspace_id)
            ),
            name=name,
            parent=parent,
            deletion=deletion,
        )

    def _newest_content(self, workspace_id: UUID) -> Any:
        """Content lives in two logs, and the newer row is the entry's kind:
        there is no kind field anywhere, so there is none to fall out of step."""
        entry = self.models.entry

        def written(log: type[ContentRow], kind: Kind):
            return (
                select(
                    col(log.entry_id).label("entry_id"),
                    col(log.id).label("version"),
                    col(log.position).label("position"),
                    literal(kind.value).label("kind"),
                )
                .join(entry, col(entry.id) == col(log.entry_id))
                .where(col(entry.workspace_id) == workspace_id)
            )

        both = union_all(
            written(self.models.text_content, Kind.TEXT),
            written(self.models.blob_content, Kind.BINARY),
        ).subquery()
        return (
            select(both.c.entry_id, both.c.version, both.c.position, both.c.kind)
            .distinct(both.c.entry_id)
            .order_by(both.c.entry_id, both.c.position.desc())
            .subquery()
        )

    def _current(self, workspace_id: UUID):
        placed = self._namespace(workspace_id)
        content = self._newest_content(workspace_id)
        return placed.statement.add_columns(
            content.c.version, content.c.position, content.c.kind
        ).outerjoin(content, content.c.entry_id == self.models.entry.id)

    # -- reading it ------------------------------------------------------------

    async def node(
        self, session: AsyncSession, workspace_id: UUID, entry_id: UUID
    ) -> Node | None:
        row = (
            await session.exec(
                self._current(workspace_id).where(col(self.models.entry.id) == entry_id)
            )
        ).first()
        return None if row is None else node_of(row)

    async def nodes(self, session: AsyncSession, workspace_id: UUID) -> list[Node]:
        """Every entry INCLUDING tombstones -- reconciliation depends on them,
        so tombstones must outlive the longest offline session a client has."""
        return [node_of(row) for row in await session.exec(self._current(workspace_id))]

    def _live_children(self, workspace_id: UUID, holder: UUID | None):
        placed = self._namespace(workspace_id)
        return placed, placed.statement.where(
            _under(placed.parent, holder),
            col(placed.deletion.deleted) == False,  # noqa: E712
        )

    async def name_taken(
        self,
        session: AsyncSession,
        workspace_id: UUID,
        *,
        parent: UUID | None,
        name: str,
        excluding: UUID | None,
    ) -> bool:
        """Uniqueness among LIVE siblings, case-sensitively.

        Case-sensitive because the tree is read by a Linux-shaped runtime
        where `Foo.py` and `foo.py` are two importable modules. Changing this
        later means reconciling workspaces that already hold colliding pairs.

        Not a database constraint: name and parent are versioned, so no
        partial unique index can express it. What holds it up is the workspace
        controller -- one writer at a time, per workspace.
        """
        placed, siblings = self._live_children(workspace_id, parent)
        conflicting = siblings.where(
            col(placed.name.name) == name, self._other_than(excluding)
        )
        return (await session.exec(conflicting)).first() is not None

    async def claimed_first(
        self,
        session: AsyncSession,
        workspace_id: UUID,
        *,
        parent: UUID | None,
        name: str,
        before: int,
        excluding: UUID,
    ) -> bool:
        """Whether a live sibling took this name earlier than `before`.

        First claim wins, so two entries that arrive holding one name are
        settled in the order they arrived rather than the order they are
        looked at.
        """
        placed, siblings = self._live_children(workspace_id, parent)
        earlier = siblings.where(
            col(placed.name.name) == name,
            col(placed.name.position) < before,
            col(self.models.entry.id) != excluding,
        )
        return (await session.exec(earlier)).first() is not None

    async def children(
        self, session: AsyncSession, workspace_id: UUID, parent: UUID | None
    ) -> int:
        _, siblings = self._live_children(workspace_id, parent)
        return (
            await session.exec(select(func.count()).select_from(siblings.subquery()))
        ).one()

    def _other_than(self, entry_id: UUID | None) -> ColumnElement[bool]:
        return true() if entry_id is None else col(self.models.entry.id) != entry_id

    # -- walking it -------------------------------------------------------------

    async def ancestors(
        self, session: AsyncSession, workspace_id: UUID, entry_id: UUID
    ) -> AsyncIterator[UUID]:
        """From the entry's parent up to the workspace root."""
        seen: set[UUID] = set()
        at = await self.node(session, workspace_id, entry_id)
        while at is not None and at.parent is not None and at.parent not in seen:
            seen.add(at.parent)
            yield at.parent
            at = await self.node(session, workspace_id, at.parent)

    async def lineage(
        self, session: AsyncSession, workspace_id: UUID, entry_id: UUID
    ) -> Lineage:
        """Deleting a folder tombstones the folder, not its contents. What the
        subtree loses is reachability, and that is what nothing may be added to."""
        walked: list[UUID] = []
        interrupted = False
        async for ancestor in self.ancestors(session, workspace_id, entry_id):
            walked.append(ancestor)
            holder = await self.node(session, workspace_id, ancestor)
            interrupted = interrupted or holder is None or holder.deleted
        return Lineage(ancestors=tuple(walked), interrupted=interrupted)

    async def descends_from(
        self, session: AsyncSession, workspace_id: UUID, entry_id: UUID, ancestor_id: UUID
    ) -> bool:
        return entry_id == ancestor_id or (
            await self.lineage(session, workspace_id, entry_id)
        ).under(ancestor_id)


def _under(parent: type[ParentRow], holder: UUID | None) -> ColumnElement[bool]:
    at = col(parent.parent_entry_id)
    return at.is_(None) if holder is None else at == holder


@final
@dataclass(frozen=True)
class Lineage:
    """One walk from an entry up to the workspace root, answering everything
    the walk can answer: how deep it sits, what encloses it, and whether
    anything on the way up has been deleted."""

    ancestors: tuple[UUID, ...]
    interrupted: bool

    @property
    def depth(self) -> int:
        return len(self.ancestors)

    def under(self, ancestor_id: UUID) -> bool:
        return ancestor_id in self.ancestors
