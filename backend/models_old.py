"""SQLModel tables of record.

Scaffold simplification vs. the production schema: parent is an inline
column on Entry rather than a separate FileHierarchy join table. The
adjudication logic only ever touches parent through Entry.parent_id, so
swapping the real schema back in is contained to models + queries.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlmodel import Field, SQLModel


def new_id() -> str:
    return uuid.uuid4().hex


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Workspace(SQLModel, table=True):
    id: str = Field(primary_key=True)
    # Internal per-workspace monotonic stream position. Bumped ONLY inside
    # the choke point, under the workspace row lock. Never client-visible.
    position: int = Field(default=0, nullable=False)


class Entry(SQLModel, table=True):
    """Current state of one tree node (pure namespace — no content plane)."""

    id: str = Field(default_factory=new_id, primary_key=True)
    workspace_id: str = Field(index=True, nullable=False)
    type: str = Field(nullable=False)  # "file" | "folder"
    name: str = Field(nullable=False)
    parent_id: str | None = Field(default=None, index=True)
    deleted: bool = Field(default=False, nullable=False)
    version: str = Field(nullable=False)  # id of current EntryVersion


class EntryVersion(SQLModel, table=True):
    """Immutable snapshot of an entry at one version.

    Powers (a) CAS-failure reasons (diff presented version vs. current),
    (b) Content fetch by (id, version).
    """

    id: str = Field(default_factory=new_id, primary_key=True)
    entry_id: str = Field(index=True, nullable=False)
    name: str = Field(nullable=False)
    parent_id: str | None = Field(default=None)
    deleted: bool = Field(default=False, nullable=False)
    content_id: str | None = Field(default=None)  # ContentVersion.id
    created_at: datetime = Field(default_factory=utcnow, nullable=False)


class ContentVersion(SQLModel, table=True):
    """One committed content state. Text inline; binary by hash pointer."""

    id: str = Field(default_factory=new_id, primary_key=True)
    entry_id: str = Field(index=True, nullable=False)
    kind: str = Field(nullable=False)  # "text" | "binary"
    text: str | None = Field(default=None)
    hash: str | None = Field(default=None, index=True)
    size: int = Field(default=0, nullable=False)
    mime: str = Field(default="text/plain", nullable=False)
    created_at: datetime = Field(default_factory=utcnow, nullable=False)


class TransactionRecord(SQLModel, table=True):
    """One table, three roles: audit log, dedup table, Initialize's answers.

    Retention must exceed the maximum tolerated client offline age.
    """

    id: str = Field(primary_key=True)  # client transaction id (globally unique)
    user: str = Field(nullable=False)
    workspace_id: str = Field(index=True, nullable=False)
    rejected: bool = Field(nullable=False)
    reason: str | None = Field(default=None)
    # Current version of the affected entry at rejection time (conflict UX).
    conflict_version: str | None = Field(default=None)
    # For Create acks re-served on dedup: the id that was minted.
    created_entry_id: str | None = Field(default=None)
    position: int | None = Field(default=None)
    created_at: datetime = Field(default_factory=utcnow, nullable=False)


class EventRow(SQLModel, table=True):
    """The stream, durably. Written in the same transaction as the mutation
    (transactional outbox) — generated FROM the truth, so it cannot drift.
    Retention: minutes."""

    id: int | None = Field(default=None, primary_key=True)
    workspace_id: str = Field(index=True, nullable=False)
    position: int = Field(index=True, nullable=False)
    payload: str = Field(nullable=False)  # JSON of the ServerSent.Stream event
    created_at: datetime = Field(default_factory=utcnow, nullable=False)


class StreamToken(SQLModel, table=True):
    token: str = Field(primary_key=True)
    user: str = Field(nullable=False)
    workspace_id: str = Field(nullable=False)
    position: int = Field(nullable=False)  # stream position of the Initialize snapshot
    expires: datetime = Field(nullable=False)


class BlobRecord(SQLModel, table=True):
    hash: str = Field(primary_key=True)
    size: int = Field(nullable=False)
    mime: str = Field(nullable=False)
    created_at: datetime = Field(default_factory=utcnow, nullable=False)
