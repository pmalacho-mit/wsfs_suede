"""An entry's text at a version, reconstructed from its chain of deltas.

The chain is anchored by `TextContentCache`, which holds the text at the
newest version: reading current content folds nothing, and reading an older
version walks backwards by inverting the few deltas in between.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlmodel import Session, select

from .diff import Delta, apply_deltas, recover_base
from .models import Event, TextContent, TextContentCache, Version

BEFORE_ANY_VERSION = -1


@dataclass(frozen=True)
class _Anchor:
    text: str
    position: int


def _anchor(session: Session, entry_id: UUID) -> _Anchor:
    cached = session.exec(
        select(TextContentCache, Version)
        .join(Version, Version.id == TextContentCache.version_id)  # pyright: ignore[reportArgumentType]
        .where(TextContentCache.entry_id == entry_id)
    ).first()
    if cached is None:
        return _Anchor(text="", position=BEFORE_ANY_VERSION)
    cache, version = cached
    return _Anchor(text=cache.content, position=version.position)


def _deltas(session: Session, entry_id: UUID, *, after: int, through: int) -> list[Delta]:
    """Every text delta this entry gained in (after, through], oldest first.

    Binary writes in that span introduce none: an entry's text chain runs
    through its text writes only.
    """
    written = (
        select(TextContent.delta)
        .join(Version, Version.text_content_id == TextContent.id)  # pyright: ignore[reportArgumentType]
        .where(
            Version.entry_id == entry_id,
            Version.event == Event.WRITE,
            Version.position > after,
            Version.position <= through,
        )
        .order_by(Version.position)  # pyright: ignore[reportArgumentType]
    )
    return [delta for delta in session.exec(written) if delta is not None]


def at(session: Session, version: Version) -> str:
    """The entry's text as of `version` -- empty if it never held any."""
    anchor = _anchor(session, version.entry_id)
    if version.position >= anchor.position:
        forwards = _deltas(
            session, version.entry_id, after=anchor.position, through=version.position
        )
        return apply_deltas(anchor.text, forwards)
    undone = _deltas(
        session, version.entry_id, after=version.position, through=anchor.position
    )
    return recover_base(anchor.text, undone)


def remember(session: Session, version: Version, content: str) -> None:
    """Re-anchor the chain at `version`, which must be the entry's newest."""
    cache = session.exec(
        select(TextContentCache).where(TextContentCache.entry_id == version.entry_id)
    ).first()
    if cache is None:
        session.add(
            TextContentCache(
                entry_id=version.entry_id, version_id=version.id, content=content
            )
        )
        return
    cache.version_id = version.id
    cache.content = content
    session.add(cache)
