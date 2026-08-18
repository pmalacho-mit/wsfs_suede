"""The blob store: named by content, so every retry is free."""

import pytest

from conftest import Api, acknowledged, created, version_of
from release.backend.blobs import Blobs, digest_of

PAYLOAD = b"\x00\x01\x02 the bytes"


async def test_bytes_go_up_and_come_back_down(api: Api):
    digest = await api.store(PAYLOAD)

    response = await api.http.get(f"/blobs/{digest}")
    assert response.content == PAYLOAD


async def test_storing_the_same_bytes_twice_is_free(api: Api):
    assert await api.store(PAYLOAD) == await api.store(PAYLOAD) == digest_of(PAYLOAD)


async def test_bytes_that_are_not_what_the_name_claims_are_refused(api: Api):
    response = await api.http.put(f"/blobs/{'a' * 64}", content=PAYLOAD)

    assert response.status_code == 409
    assert response.json() == {"rejected": True, "reason": "hash mismatch"}


async def test_an_unknown_blob_is_not_found(api: Api):
    assert (await api.http.get(f"/blobs/{'b' * 64}")).status_code == 404


async def test_a_name_that_is_not_a_hash_reaches_no_file(tmp_path):
    blobs = Blobs(tmp_path)

    assert not blobs.holds("../../etc/passwd")
    assert not blobs.store("../../etc/passwd", PAYLOAD)
    with pytest.raises(ValueError, match="not a sha256"):
        blobs.read("../../etc/passwd")


async def test_a_partly_written_blob_never_becomes_visible(tmp_path):
    blobs = Blobs(tmp_path)
    blobs.store(digest_of(PAYLOAD), PAYLOAD)

    assert sorted(path.suffix for path in tmp_path.iterdir()) == [""]


async def test_the_same_bytes_back_two_entries_at_once(api: Api):
    digest = await api.store(PAYLOAD)
    for name in ("one.bin", "two.bin"):
        entry = created(await api.create(name))
        acknowledged(
            await api.write_blob(
                entry,
                await version_of(api, entry),
                hash=digest,
                size=len(PAYLOAD),
                mime="application/octet-stream",
            )
        )
        assert (await api.content(entry)).content == PAYLOAD


async def test_bytes_beyond_the_budget_are_refused_before_they_are_buffered(processes, tmp_path):
    from conftest import Api, open_workspace, serving
    from release.backend.main import create_app

    small = create_app(blob_root=tmp_path / "small", max_blob_bytes=8, grace_seconds=0.2)
    async with serving(small) as instance:
        api = Api(instance, await open_workspace(instance), user="ada@example.com")
        response = await api.http.put(f"/blobs/{digest_of(PAYLOAD)}", content=PAYLOAD)

    assert response.status_code == 413
    assert response.json() == {"rejected": True, "reason": "too large"}
