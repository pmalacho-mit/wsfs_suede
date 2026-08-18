"""Immutable bytes, named by their sha256.

Content addressing is what makes `Store` idempotent: re-uploading the same
bytes is a no-op, a mismatched hash is refused before anything is written, and
a cached blob can never be stale -- only pointers to it can.
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

SHA256 = re.compile(r"^[0-9a-f]{64}$")


def digest_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Blobs:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def holds(self, digest: str) -> bool:
        return SHA256.match(digest) is not None and self._path(digest).exists()

    def read(self, digest: str) -> bytes:
        return self._path(digest).read_bytes()

    def store(self, digest: str, data: bytes) -> bool:
        """False when the bytes are not what the name claims -- nothing written."""
        if not SHA256.match(digest) or digest_of(data) != digest:
            return False
        self._write_atomically(self._path(digest), data)
        return True

    def _path(self, digest: str) -> Path:
        if not SHA256.match(digest):
            raise ValueError(f"not a sha256: {digest!r}")
        return self.root / digest

    @staticmethod
    def _write_atomically(path: Path, data: bytes) -> None:
        staged = path.with_suffix(".staged")
        staged.write_bytes(data)
        os.replace(staged, path)
