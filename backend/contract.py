"""The wire shapes, mirroring `docs/filesystem-sync-contract.ts`.

Three deliberate departures from that document, each noted where it lands:
`op` on outbox requests, `value` on the create event, and two refusal reasons
the document does not enumerate.
"""

from __future__ import annotations

import enum
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field
from pydantic_core import to_jsonable_python

from .models import Event, Type


class Operation(str, enum.Enum):
    CREATE = "create"
    DELETE = "delete"
    RENAME = "rename"
    REPARENT = "reparent"
    WRITE = "write"


class Kind(str, enum.Enum):
    TEXT = "text"
    BINARY = "binary"


# -- requests ---------------------------------------------------------------
#
# DEPARTURE: every request carries `op`. The contract's outbox union is not
# structurally discriminable -- a Reparent to the workspace root and a Delete
# are the same three fields -- so the discriminator is explicit rather than
# guessed at.


class Transacted(BaseModel):
    transaction: str


class Create(Transacted):
    op: Literal[Operation.CREATE] = Operation.CREATE
    type: Type
    name: str
    parent: UUID | None = None


class Versioned(Transacted):
    id: UUID
    version: UUID
    """The CAS token: the version this request was composed against."""


class Delete(Versioned):
    op: Literal[Operation.DELETE] = Operation.DELETE


class Rename(Versioned):
    op: Literal[Operation.RENAME] = Operation.RENAME
    name: str


class Reparent(Versioned):
    op: Literal[Operation.REPARENT] = Operation.REPARENT
    parent: UUID | None = None


class WriteText(Versioned):
    op: Literal[Operation.WRITE] = Operation.WRITE
    type: Literal[Kind.TEXT] = Kind.TEXT
    content: str


class WriteBinary(Versioned):
    op: Literal[Operation.WRITE] = Operation.WRITE
    type: Literal[Kind.BINARY] = Kind.BINARY
    hash: str
    size: int
    mime: str


Write = Annotated[WriteText | WriteBinary, Field(discriminator="type")]

Queued = Annotated[Delete | Rename | Reparent | Write, Field(discriminator="op")]
"""What may sit in a client's outbox. Creates are online-only and never queued."""

Submitted = Annotated[Create | Delete | Rename | Reparent | Write, Field(discriminator="op")]


# -- responses ---------------------------------------------------------------


class Acknowledged(BaseModel):
    rejected: Literal[False] = False


class Created(Acknowledged):
    id: UUID
    """Identity, not state: the entry itself still arrives via the stream."""


class Rejected(BaseModel):
    rejected: Literal[True] = True
    reason: str
    version: UUID | None = None
    """The entry's current version, when the refusal was a CAS conflict."""


Response = Acknowledged | Created | Rejected


class Refusal:
    """The closed set of typed failures a client may have to route on."""

    PARENT_DELETED = "parent was deleted"
    ENTRY_DELETED = "entry was deleted"
    DESTINATION_DELETED = "the destination was deleted"
    NAME_TAKEN = "entry with name already exists within destination"
    ALREADY_RENAMED = "entry was already renamed"
    ALREADY_MOVED = "entry had already been moved"
    ALREADY_WRITTEN = "content was already updated"

    # DEPARTURE: neither reason appears in the contract, and both name a
    # failure it can otherwise only answer with a lie.
    DESTINATION_INSIDE_ENTRY = "the destination is inside the entry"
    BYTES_NEVER_STORED = "content bytes were never stored"

    @staticmethod
    def modified(*, name: bool, content: bool) -> str:
        what = "content and name" if name and content else "name" if name else "content"
        return f"later versions modified the {what} of the entry"


# -- entries and events -------------------------------------------------------


class Metadata(BaseModel):
    """Pure namespace: no content descriptor ever appears here."""

    id: UUID
    version: UUID
    type: Type
    name: str
    parent: UUID | None = None
    deleted: bool | None = None


CARRIES_A_VALUE = {Event.CREATE, Event.NAME, Event.PARENT, Event.DELETE}


class StreamEvent(BaseModel):
    """DEPARTURE: a create's metadata rides in `value`, as every other event's
    payload does. The contract spreads it over the event, where its `type`
    ("file"/"folder") is shadowed by the event's own `type` ("create") and the
    client can no longer tell a file from a folder."""

    type: Event
    id: UUID
    version: UUID
    value: Metadata | str | UUID | bool | None = None
    user: UUID | None = None
    transaction: str | None = None

    def payload(self) -> dict[str, Any]:
        wire = self.model_dump(mode="json", exclude_none=True, exclude={"value"})
        if self.type in CARRIES_A_VALUE:
            # An explicit null: a parent event's value is None at the root.
            wire["value"] = to_jsonable_python(self.value, exclude_none=True)
        return wire


# -- initialize ----------------------------------------------------------------


class Rejection(BaseModel):
    transaction: str
    reason: str
    version: UUID | None = None


class InitializeRequest(BaseModel):
    outbox: list[Queued] = Field(default_factory=list)
    """In counter order. Replay depends on it."""


class InitializeResponse(BaseModel):
    """DEPARTURE: `applied` is transaction ids. The contract echoes back the
    full requests, which the client already holds and evicts by id."""

    token: str
    entries: list[Metadata]
    applied: list[str]
    rejected: list[Rejection]


class TextContentResponse(BaseModel):
    type: Literal[Kind.TEXT] = Kind.TEXT
    content: str
    version: UUID
