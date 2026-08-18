"""The event stream, derived from the version log.

One approved mutation appends exactly one version, so the versions of a
workspace in position order ARE its event stream. Nothing publishes events;
there is no second write to fail independently of the first.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import Row
from sqlmodel import Session, select

from .contract import StreamEvent
from .models import (
    BlobContent,
    Deletion,
    Entry,
    Event,
    Name,
    Parent,
    TextContent,
    Transaction,
    Version,
)
from .tree import Node


@dataclass(frozen=True)
class Emitted:
    """An event and the stream position it was committed at.

    The position never reaches a client -- it exists so a stream can splice
    its replay onto its live feed without sending anything twice.
    """

    position: int
    event: StreamEvent


def _versions():
    return (
        select(Version, Entry, Name, Parent, Deletion, TextContent, BlobContent)
        .join(Entry, Entry.id == Version.entry_id)  # pyright: ignore[reportArgumentType]
        .join(Name, Name.id == Version.name_id)  # pyright: ignore[reportArgumentType]
        .join(Parent, Parent.id == Version.parent_id)  # pyright: ignore[reportArgumentType]
        .join(Deletion, Deletion.id == Version.deleted_id)  # pyright: ignore[reportArgumentType]
        .outerjoin(TextContent, TextContent.id == Version.text_content_id)  # pyright: ignore[reportArgumentType]
        .outerjoin(BlobContent, BlobContent.id == Version.blob_content_id)  # pyright: ignore[reportArgumentType]
    )


def _caused_by(version: Version, row: Row) -> Transaction:
    """The attempt this version was the approval of."""
    _, _, name, parent, deletion, text_content, blob_content = row
    cause = {
        Event.CREATE: name,
        Event.NAME: name,
        Event.PARENT: parent,
        Event.DELETE: deletion,
        Event.WRITE: text_content or blob_content,
    }[version.event]
    if cause is None:
        raise ValueError(f"version {version.id} records a write with no content")
    return cause


def _value(event: Event, node: Node):
    """What the event says about the entry it names."""
    return {
        Event.CREATE: node.metadata,
        Event.NAME: node.name,
        Event.PARENT: node.parent,
        Event.DELETE: node.deleted,
        # A write is a PURE INVALIDATION SIGNAL: cached content and its kind
        # are stale, and the next Content fetch reveals the rest.
        Event.WRITE: None,
    }[event]


def _event(row: Row) -> Emitted:
    version, entry, name, parent, deletion, _, _ = row
    node = Node(
        entry=entry,
        version=version,
        name=name.name,
        parent=parent.parent_entry_id,
        deleted=deletion.deleted,
    )
    value = _value(version.event, node)
    cause = _caused_by(version, row)
    return Emitted(
        position=version.position,
        event=StreamEvent(
            type=version.event,
            id=version.entry_id,
            version=version.id,
            value=value,
            user=cause.user_id,
            transaction=cause.transaction,
        ),
    )


def since(session: Session, workspace_id: UUID, position: int) -> list[Emitted]:
    rows = session.exec(
        _versions()
        .where(Entry.workspace_id == workspace_id, Version.position > position)
        .order_by(Version.position)  # pyright: ignore[reportArgumentType]
    )
    return [_event(row) for row in rows]


def of(session: Session, version_id: UUID) -> Emitted:
    return _event(session.exec(_versions().where(Version.id == version_id)).one())
