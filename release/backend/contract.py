"""The wire shapes, mirroring `docs/filesystem-sync-contract.ts`.

Identity is client-minted throughout. A transaction id is chosen by the client
before it sends anything, and after the server applies it that same id is the
CAS token for the property it changed -- so a client knows, at mint time and
without a round trip, what token its own work will produce. That is what lets
an outbox chain: each queued item presents the id of the item before it.

Mint with a platform CSPRNG (`crypto.randomUUID()`), never `Math.random()`;
UUIDv7 is preferred for index locality on append-only tables. Mint once and
reuse the same id on every retry -- that is what makes a retry free.
"""

from __future__ import annotations

import enum
import unicodedata
from datetime import datetime
from typing import Annotated, Any, Literal, final
from uuid import UUID

from pydantic import AfterValidator, BaseModel, Field, model_validator
from pydantic_core import to_jsonable_python

from .models import Type


class Operation(str, enum.Enum):
    CREATE = "create"
    DELETE = "delete"
    RENAME = "rename"
    REPARENT = "reparent"
    MOVE = "move"
    WRITE = "write"


class Kind(str, enum.Enum):
    TEXT = "text"
    BINARY = "binary"


class Event(str, enum.Enum):
    CREATE = "create"
    NAME = "name"
    PARENT = "parent"
    MOVE = "move"
    DELETE = "delete"
    WRITE = "write"


def to_nfc(name: str) -> str:
    """Unicode normalisation belongs at the door, and only here.

    A macOS client's NFD `café` and a Linux client's NFC `café` must
    not become two siblings a user cannot tell apart, and the controller is the
    only participant that sees both.
    """
    return unicodedata.normalize("NFC", name)


EntryName = Annotated[str, AfterValidator(to_nfc)]


# -- requests ---------------------------------------------------------------
#
# DEPARTURE: every request carries `op`. The contract's outbox union is not
# structurally discriminable, so the discriminator is explicit rather than
# guessed at.


FURTHEST_FROM_UTC = 24 * 60 - 1
"""Minutes. Real zones reach UTC-12:00 and UTC+14:00; this only refuses the
values that cannot be a clock at all."""

Offset = Annotated[int, Field(ge=-FURTHEST_FROM_UTC, le=FURTHEST_FROM_UTC)]
"""Minutes EAST of UTC, as `-new Date().getTimezoneOffset()` reports them:
Berlin in summer is +120, Los Angeles is -420."""


class Transacted(BaseModel):
    transaction: UUID
    """Client-minted. Becomes the primary key of the row this applies, and the
    CAS token the next mutation of that property must present.

    A v7 also says WHEN the client minted it, which is when the user acted --
    so the client-side time of every transaction is already here, and
    `minted.minted_at` reads it back out. See that module for what it is worth
    and what it is not.
    """

    id: UUID
    """The entry. Client-minted too, so a create needs no round trip."""

    offset: Offset | None = None
    """The client's offset from UTC when it minted this, in minutes.

    ON THE TRANSACTION, not on the connection, and that is the whole point. An
    outbox composed over a week offline is replayed in ONE Initialize, and the
    client that replays it may be in a different zone from the client that
    filled it -- somebody works in Los Angeles on Monday and lands in London on
    Tuesday. A per-connection offset would stamp Tuesday's zone onto Monday's
    work; a per-transaction one keeps each item's own.

    Null means the client said nothing, which is all a server can conclude: the
    id's instant is still known, so the transaction can be shown in the
    READER's zone, just not in the one it was made in.
    """


class TextBody(BaseModel):
    type: Literal[Kind.TEXT] = Kind.TEXT
    content: str


class BinaryBody(BaseModel):
    type: Literal[Kind.BINARY] = Kind.BINARY
    hash: str
    size: int
    mime: str


Body = Annotated[TextBody | BinaryBody, Field(discriminator="type")]


class Create(Transacted):
    op: Literal[Operation.CREATE] = Operation.CREATE
    type: Type
    name: EntryName
    """What the entry is created as. If a sibling already holds it, the create
    still lands under this name and the controller immediately renames it --
    so the settled name arrives as an ordinary `name` event rather than as a
    surprise inside the create."""
    parent: UUID | None = None
    content: Body | None
    """A file is born with its content; a folder is born with none.

    Required either way, so "empty file" is something a client says
    (`{"type": "text", "content": ""}`) rather than something it omits. An
    entry therefore never exists in a contentless state, which is what lets
    every write present a content token that is really there.
    """

    @model_validator(mode="after")
    def content_belongs_to_files(self) -> "Create":
        if (self.content is None) is (self.type is Type.FILE):
            raise ValueError("a file is created with content, a folder without")
        return self


class Rename(Transacted):
    op: Literal[Operation.RENAME] = Operation.RENAME
    name: EntryName
    name_version: UUID


class Reparent(Transacted):
    op: Literal[Operation.REPARENT] = Operation.REPARENT
    parent: UUID | None = None
    parent_version: UUID


class Seen(BaseModel):
    """Every token of the entry a delete was looking at.

    Delete is the destructive operation, and the question worth asking is not
    "has the deleted flag moved" -- it almost never has -- but "is this still
    the thing I was told to destroy".
    """

    name_version: UUID
    parent_version: UUID
    deleted_version: UUID
    content_version: UUID | None
    """Required, and null for a folder, which holds none."""


class Delete(Transacted):
    op: Literal[Operation.DELETE] = Operation.DELETE
    seen: Seen


class Move(Transacted):
    """A rename and a reparent as one transaction.

    A filesystem `mv` changes where an entry lives and what it is called at
    once, and doing that as two transactions can half-succeed: the rename
    lands, the reparent is refused, and the entry ends up somewhere nobody
    asked for. This presents both tokens and takes both positions or neither.
    """

    op: Literal[Operation.MOVE] = Operation.MOVE
    name: EntryName
    name_version: UUID
    parent: UUID | None = None
    parent_version: UUID


class Write(Transacted):
    op: Literal[Operation.WRITE] = Operation.WRITE
    content_version: UUID
    """Never null: a file is born with content, so there is always a token to
    present. A folder has none, and a write to one is refused for being a
    folder before its token is ever considered."""
    content: Body
    """Carried exactly as a create carries it -- one spelling of content, not
    two. Nesting it also keeps this union flat, which is what lets the schema
    express `op` as a discriminator and a client generate itself from it."""


Submitted = Annotated[
    Create | Delete | Rename | Reparent | Move | Write, Field(discriminator="op")
]
"""Everything a client can submit -- and everything it can queue. Creates are
no longer online-only, because the client already knows the id."""


# -- responses ---------------------------------------------------------------


class Acknowledged(BaseModel):
    rejected: Literal[False] = False


class Rejected(BaseModel):
    rejected: Literal[True] = True
    reason: str
    version: UUID | None = None
    """The property's current token, when the refusal was a lost race: what a
    client rebases onto before retrying."""


Response = Acknowledged | Rejected


@final
class Refusal:
    """The closed set of typed failures a client may have to route on."""

    PARENT_DELETED = "parent was deleted"
    ENTRY_DELETED = "entry was deleted"
    DESTINATION_DELETED = "the destination was deleted"
    NAME_TAKEN = "entry with name already exists within destination"
    ALREADY_RENAMED = "entry was already renamed"
    ALREADY_MOVED = "entry had already been moved"
    ALREADY_WRITTEN = "content was already updated"

    # Failures the contract does not enumerate, each naming something it could
    # otherwise only answer with a lie.
    PARENT_UNKNOWN = "no such parent"
    DESTINATION_UNKNOWN = "no such destination"
    """A folder that never existed is not a folder that was deleted.

    Under server-minted ids the first was impossible, so the contract has no
    word for it. A client that mints its own can name a folder nobody ever
    created -- which is exactly what every create queued behind a REFUSED
    create does -- and answering that with "parent was deleted" would be the
    server describing a deletion that never happened.
    """

    PARENT_NOT_A_FOLDER = "that parent is not a folder"
    DESTINATION_NOT_A_FOLDER = "that destination is not a folder"
    DESTINATION_INSIDE_ENTRY = "the destination is inside the entry"
    BYTES_NEVER_STORED = "content bytes were never stored"
    ENTRY_UNKNOWN = "no such entry"
    ID_TAKEN = "that id is already in use"
    NOT_A_FILE = "content cannot be written to a folder"
    NAME_INVALID = "that name is not permitted"
    TOO_DEEP = "that destination is nested too deeply"
    FOLDER_FULL = "that folder already holds too many entries"
    CREATE_REFUSED = "the create this depends on was refused"

    UNKNOWN_VERSION = "the version presented was never issued"
    """A different CLASS of failure from the rest. A token is current (accept),
    superseded (an ordinary conflict -- rebase and retry), or was never issued
    at all, which means the client's state is unsound and its only sound move
    is to discard it and re-Initialize. Answering the third as an ordinary
    conflict sends a client into a retry loop it cannot win."""

    @staticmethod
    def modified(*, name: bool, content: bool) -> str:
        what = "content and name" if name and content else "name" if name else "content"
        return f"later versions modified the {what} of the entry"


# -- entries and events -------------------------------------------------------


class Occurrence(BaseModel):
    """When one transaction happened, in both clocks that saw it.

    Two clocks because they answer different questions and disagree for honest
    reasons. `minted` is the client's, and it is when the USER acted -- which,
    after a week offline, is the only one that means anything to them. `accepted`
    is this server's, and it is when the change entered the workspace and became
    something other clients could see. An offline session makes the gap between
    them days wide, and neither number is the other's approximation.
    """

    minted: datetime | None = None
    """UTC, read out of the transaction's UUIDv7 -- see `minted.minted_at`. Null
    when the id is not a v7, which is a client saying nothing about when it
    acted. Client-reported either way, so it is only as good as their clock."""

    offset: Offset | None = None
    """The client's minutes east of UTC as it acted, so `minted` can be shown on
    the clock they were actually looking at. Null when they did not say."""

    accepted: datetime | None = None
    """UTC, from this server's clock, at the moment the transaction was applied.
    The trustworthy half of the pair, and the one to reconcile against when a
    client's clock is plainly wrong.

    Null in exactly one place, and never from the server: a client's own
    optimistic overlay, describing work it has queued and nobody has accepted
    yet. A row in the database was accepted by definition."""


class Metadata(BaseModel):
    """Pure namespace, plus the four tokens the next mutation must present.

    No content descriptor ever appears here: `content_version` names the write
    to fetch, not what it holds.
    """

    id: UUID
    type: Type
    name: str
    parent: UUID | None = None
    deleted: bool | None = None
    name_version: UUID
    parent_version: UUID
    deleted_version: UUID
    content_version: UUID | None = None
    modified: Occurrence
    """When the newest of the four rows above landed -- the entry's mtime.

    Only the newest, and deliberately: every token here IS a transaction id, so
    a client that wants the client-side time of any ONE property reads it out of
    that token itself, with nothing sent. What it cannot derive is the offset
    the client held and the moment this server accepted the work, so that is
    what this carries.
    """


class Moved(BaseModel):
    """Where an entry went, and what it is called now."""

    name: str
    parent: UUID | None = None


CARRIES_A_VALUE = {
    Event.CREATE,
    Event.NAME,
    Event.PARENT,
    Event.MOVE,
    Event.DELETE,
}


class StreamEvent(BaseModel):
    """DEPARTURE: a create's metadata rides in `value`, as every other event's
    payload does. The contract spreads it over the event, where its `type`
    ("file"/"folder") is shadowed by the event's own `type` ("create") and the
    client can no longer tell a file from a folder.

    `transaction` does the job the old `version` field did as well: it is the
    id of the transaction this event announces, which IS the new token for the
    property it changed. On an event for property P, set the value and set P's
    token to `transaction`.
    """

    type: Event
    id: UUID
    transaction: UUID
    value: Metadata | Moved | str | UUID | bool | None = None
    user: UUID | None = None
    at: Occurrence
    """When the transaction this announces happened. A create's `value` carries
    the same pair as the entry's `modified`, because at a birth they are the
    same transaction."""

    def payload(self) -> dict[str, Any]:
        wire = self.model_dump(mode="json", exclude_none=True, exclude={"value"})
        if self.type in CARRIES_A_VALUE:
            # An explicit null: a parent event's value is None at the root.
            wire["value"] = to_jsonable_python(self.value, exclude_none=True)
        return wire


# -- initialize ----------------------------------------------------------------


class Rejection(BaseModel):
    transaction: UUID
    reason: str
    version: UUID | None = None


MOST_TRANSACTIONS_PER_INITIALIZE = 10_000
"""An outbox composed offline can be long; it cannot be unbounded."""


class InitializeRequest(BaseModel):
    outbox: list[Submitted] = Field(
        default_factory=list, max_length=MOST_TRANSACTIONS_PER_INITIALIZE
    )
    """In counter order. Replay depends on it."""


class InitializeResponse(BaseModel):
    """DEPARTURE: `applied` is transaction ids. The contract echoes back the
    full requests, which the client already holds and evicts by id."""

    token: str
    entries: list[Metadata]
    applied: list[UUID]
    rejected: list[Rejection]


class TextContentResponse(BaseModel):
    type: Literal[Kind.TEXT] = Kind.TEXT
    content: str
    version: UUID
    """The content token this text was fetched at."""
