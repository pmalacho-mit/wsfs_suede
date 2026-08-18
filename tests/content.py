"""Content: what a version holds, and how text is rebuilt from its deltas."""

from sqlmodel import Session, delete, select

from conftest import Api, acknowledged, created, version_of
from release.backend.models import TextContent, TextContentCache

REVISIONS = ["one", "one two", "one two three", "two three"]


async def written(api: Api, name: str, revisions: list[str]) -> tuple[str, list[str]]:
    """An entry carrying each revision in turn, and the version each landed at."""
    entry = created(await api.create(name))
    versions = []
    for revision in revisions:
        acknowledged(await api.write(entry, await version_of(api, entry), revision))
        versions.append(await version_of(api, entry))
    return entry, versions


async def test_every_past_revision_is_still_readable(api: Api):
    entry, versions = await written(api, "notes.txt", REVISIONS)

    for revision, version in zip(REVISIONS, versions):
        assert (await api.content(entry, version)).json() == {
            "type": "text",
            "content": revision,
            "version": version,
        }


async def test_history_is_stored_as_deltas_not_as_copies(api: Api, session: Session):
    entry, _ = await written(api, "notes.txt", ["a" * 500, "a" * 500 + "!"])

    deltas = session.exec(select(TextContent.delta)).all()
    assert len(deltas) == 2
    # The second revision repeats none of the 500 characters the first stored.
    assert deltas[1] == [{"retain": 500}, {"insert": "!"}]


async def test_the_cache_is_derived_so_losing_it_costs_only_time(api: Api, session: Session):
    entry, versions = await written(api, "notes.txt", REVISIONS)

    session.exec(delete(TextContentCache))
    session.commit()

    for revision, version in zip(REVISIONS, versions):
        assert (await api.content(entry, version)).json()["content"] == revision


async def test_the_cache_anchors_the_newest_version(api: Api, session: Session):
    entry, versions = await written(api, "notes.txt", REVISIONS)

    cached = session.exec(select(TextContentCache)).one()
    assert str(cached.version_id) == versions[-1]
    assert cached.content == REVISIONS[-1]


async def test_a_binary_write_does_not_break_the_text_chain(api: Api):
    entry, _ = await written(api, "mixed", ["before"])
    digest = await api.store(b"\x00\x01\x02", mime="application/x-thing")
    acknowledged(
        await api.write_blob(
            entry, await version_of(api, entry), hash=digest, size=3, mime="application/x-thing"
        )
    )
    binary_version = await version_of(api, entry)
    acknowledged(await api.write(entry, binary_version, "after"))

    assert (await api.content(entry)).json()["content"] == "after"


async def test_binary_content_is_served_raw_with_its_hash(api: Api):
    entry = created(await api.create("blob.bin"))
    payload = b"\x89PNG\r\n\x1a\n"
    digest = await api.store(payload, mime="image/png")
    acknowledged(
        await api.write_blob(
            entry, await version_of(api, entry), hash=digest, size=len(payload), mime="image/png"
        )
    )

    response = await api.content(entry)
    assert response.content == payload
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-content-hash"] == digest
    assert response.headers["etag"] == await version_of(api, entry)


async def test_the_kind_is_whichever_pointer_the_version_carries(api: Api):
    entry, _ = await written(api, "mixed", ["text first"])
    digest = await api.store(b"bytes", mime="application/octet-stream")
    text_version = await version_of(api, entry)
    acknowledged(
        await api.write_blob(entry, text_version, hash=digest, size=5, mime="application/octet-stream")
    )

    assert (await api.content(entry, text_version)).json()["type"] == "text"
    assert (await api.content(entry)).content == b"bytes"


async def test_an_entry_with_no_content_has_none_to_fetch(api: Api):
    entry = created(await api.create("empty.txt"))

    assert (await api.content(entry)).status_code == 404


async def test_content_of_an_unknown_entry_is_not_found(api: Api):
    assert (await api.content("00000000-0000-4000-8000-000000000000")).status_code == 404
