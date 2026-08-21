"""What a shared room owes the file underneath it, and the updates that settle it.

The room is a Liveblocks document; the file is wsfs. This decides which of the
two is behind and builds the Yjs update that closes the gap. Nothing here
reaches Liveblocks.
"""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Iterator, Union

from fast_diff_match_patch import diff

from pycrdt import Doc, Map, Text

CONTENT = "content"
STANDING = "standing"
BASE = "base"


@dataclass(frozen=True)
class Standing:
    """A room, as its own document reports it."""

    text: str
    base: str | None


@dataclass(frozen=True)
class Held:
    """A file, as wsfs reports it."""

    text: str
    version: str


@dataclass(frozen=True)
class Change:
    """What one writer did, between two stored versions."""

    before: str
    after: str


@dataclass(frozen=True)
class Settled:
    pass


@dataclass(frozen=True)
class Seed:
    text: str
    version: str


@dataclass(frozen=True)
class Carry:
    since: str
    version: str


Plan = Union[Settled, Seed, Carry]


# -- what a room owes ------------------------------------------------------------------


def unseeded(room: Standing) -> bool:
    """Nobody has ever filled this room.

    Asked of the base and not of the text, because a file is allowed to be
    empty and a room judged by its text would be seeded again every time.
    """
    return room.base is None


def standing_where_the_file_stands(room: Standing, file: Held) -> bool:
    return room.base == file.version


def plan(room: Standing, file: Held) -> Plan:
    if unseeded(room):
        return Seed(text=file.text, version=file.version)
    if standing_where_the_file_stands(room, file):
        return Settled()
    assert room.base is not None
    return Carry(since=room.base, version=file.version)


# -- reading and writing a room --------------------------------------------------------


def _opened(update: bytes) -> Doc:
    doc = Doc()
    doc[CONTENT] = Text()
    doc[STANDING] = Map()
    if update:
        doc.apply_update(update)
    return doc


def standing_of(update: bytes) -> Standing:
    doc = _opened(update)
    return Standing(text=str(doc[CONTENT]), base=doc[STANDING].get(BASE))


def seeded(text: str, version: str) -> bytes:
    doc = _opened(b"")
    doc[CONTENT] += text
    doc[STANDING][BASE] = version
    return doc.get_update()


def carried(live: bytes, change: Change, version: str) -> bytes:
    """An update taking the room from what it holds to what the file now says.

    Built on the room's LIVE state, because a Yjs update computed against a
    stale one is dropped without a word.
    """
    doc = _opened(live)
    was = doc.get_state()
    _carry(doc[CONTENT], change)
    doc[STANDING][BASE] = version
    return doc.get_update(was)


# -- carrying one writer's change into a room that has moved on ------------------------


@dataclass(frozen=True)
class Edit:
    """One writer's change, at a position in the text they started from."""

    at: int
    remove: int
    insert: str


def _edits(change: Change) -> Iterator[Edit]:
    """`change` as edits positioned in `change.before`.

    Both sides are stored versions, so this describes only what that writer
    did. Diffing from the room instead would call another user's unstored
    typing text to delete.
    """
    at = 0
    reached = 0
    for op, length in diff(change.before, change.after, timelimit=0, checklines=False):
        if op == "=":
            at += length
            reached += length
        elif op == "-":
            yield Edit(at=at, remove=length, insert="")
            at += length
        else:
            yield Edit(at=at, remove=0, insert=change.after[reached : reached + length])
            reached += length


def _elsewhere(before: str, live: str):
    """Where a position in `before` has ended up in `live`.

    The room has drifted from the version the change was written against, so
    the positions have to be found again rather than trusted.
    """
    blocks = SequenceMatcher(None, before, live, autojunk=False).get_matching_blocks()

    def moved(at: int) -> int:
        for starts, lands, size in blocks:
            if at < starts:
                return lands
            if at < starts + size:
                return lands + (at - starts)
        return len(live)

    return moved


def _carry(text: Text, change: Change) -> None:
    """Apply `change` to `text` as edits, latest first.

    Latest first so that earlier positions stay valid as it goes, which is the
    whole of the bookkeeping this would otherwise need.
    """
    moved = _elsewhere(change.before, str(text))
    for edit in sorted(_edits(change), key=lambda edit: edit.at, reverse=True):
        at = moved(edit.at)
        if edit.remove:
            del text[at : at + edit.remove]
        if edit.insert:
            text.insert(at, edit.insert)
