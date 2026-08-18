"""What the tree currently denotes.

An entry's name, parent and deletion each live in their own log, so "the
current tree" is a query, not a table: for every entry, the newest version and
the three attempts it points at.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator
from uuid import UUID

from sqlalchemy import ColumnElement, Row, true
from sqlmodel import Session, select
from sqlmodel.sql.expression import SelectOfScalar

from .contract import Metadata
from .models import Deletion, Entry, Name, Parent, Type, Version


@dataclass(frozen=True)
class Node:
    """One entry as of its newest approved version."""

    entry: Entry
    version: Version
    name: str
    parent: UUID | None
    deleted: bool

    @property
    def id(self) -> UUID:
        return self.entry.id

    @property
    def is_folder(self) -> bool:
        return self.entry.type is Type.FOLDER

    @property
    def metadata(self) -> Metadata:
        return Metadata(
            id=self.entry.id,
            version=self.version.id,
            type=self.entry.type,
            name=self.name,
            parent=self.parent,
            deleted=self.deleted or None,
        )


def _newest_versions(workspace_id: UUID) -> SelectOfScalar[UUID]:
    return (
        select(Version.id)
        .join(Entry, Entry.id == Version.entry_id)  # pyright: ignore[reportArgumentType]
        .where(Entry.workspace_id == workspace_id)
        .distinct(Version.entry_id)
        .order_by(Version.entry_id, Version.position.desc())  # pyright: ignore[reportAttributeAccessIssue]
    )


def _current(workspace_id: UUID):
    return (
        select(Entry, Version, Name, Parent, Deletion)
        .join(Version, Version.entry_id == Entry.id)  # pyright: ignore[reportArgumentType]
        .join(Name, Name.id == Version.name_id)  # pyright: ignore[reportArgumentType]
        .join(Parent, Parent.id == Version.parent_id)  # pyright: ignore[reportArgumentType]
        .join(Deletion, Deletion.id == Version.deleted_id)  # pyright: ignore[reportArgumentType]
        .where(Version.id.in_(_newest_versions(workspace_id)))  # pyright: ignore[reportAttributeAccessIssue]
    )


def _node(row: Row) -> Node:
    entry, version, name, parent, deletion = row
    return Node(
        entry=entry,
        version=version,
        name=name.name,
        parent=parent.parent_entry_id,
        deleted=deletion.deleted,
    )


def node(session: Session, workspace_id: UUID, entry_id: UUID) -> Node | None:
    row = session.exec(_current(workspace_id).where(Entry.id == entry_id)).first()
    return None if row is None else _node(row)


def nodes(session: Session, workspace_id: UUID) -> list[Node]:
    """Every entry INCLUDING tombstones -- reconciliation depends on them."""
    return [_node(row) for row in session.exec(_current(workspace_id))]


def _under(parent: UUID | None) -> ColumnElement[bool]:
    column = Parent.parent_entry_id
    return column.is_(None) if parent is None else column == parent  # pyright: ignore[reportAttributeAccessIssue]


def _other_than(entry_id: UUID | None) -> ColumnElement[bool]:
    return true() if entry_id is None else Entry.id != entry_id  # pyright: ignore[reportReturnType]


def name_taken(
    session: Session,
    workspace_id: UUID,
    *,
    parent: UUID | None,
    name: str,
    excluding: UUID | None,
) -> bool:
    """Uniqueness among LIVE siblings.

    Not a database constraint: name and parent are versioned, so no partial
    unique index can express it. What holds it up is the workspace
    controller -- one writer at a time, per workspace (invariant 11).
    """
    conflicting = _current(workspace_id).where(
        Name.name == name,
        _under(parent),
        Deletion.deleted == False,  # noqa: E712
        _other_than(excluding),
    )
    return session.exec(conflicting).first() is not None


def ancestors(session: Session, workspace_id: UUID, entry_id: UUID) -> Iterator[UUID]:
    """From the entry's parent up to the workspace root."""
    seen: set[UUID] = set()
    at = node(session, workspace_id, entry_id)
    while at is not None and at.parent is not None and at.parent not in seen:
        seen.add(at.parent)
        yield at.parent
        at = node(session, workspace_id, at.parent)


def has_deleted_ancestor(session: Session, workspace_id: UUID, entry_id: UUID) -> bool:
    """Deleting a folder tombstones the folder, not its contents. What the
    subtree loses is reachability, and that is what nothing may be added to."""
    return any(
        (holder := node(session, workspace_id, ancestor)) is None or holder.deleted
        for ancestor in ancestors(session, workspace_id, entry_id)
    )


def descends_from(
    session: Session, workspace_id: UUID, entry_id: UUID, ancestor_id: UUID
) -> bool:
    return entry_id == ancestor_id or ancestor_id in ancestors(
        session, workspace_id, entry_id
    )
