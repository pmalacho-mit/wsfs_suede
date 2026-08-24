"""Regenerate the client's view of the backend contract.

    python3 release/frontend/generate.py

Writes `openapi.generated.json` and `schema.generated.d.ts` beside this file.
Both are outputs: the `.generated` in their names is there so that a hand edit
announces itself as something the next run will discard.

The router has a schema only once a host has mounted it, so this mounts one --
a stub, declared below, that exists for no other reason. The document is a
function of the declared shapes, so the stub's user and workspace tables never
appear in it and its dependency is never called. Nothing is served, nothing
connects to a database, and nothing here is meant to be imported.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
from typing import TYPE_CHECKING, Any, cast
from uuid import UUID

if TYPE_CHECKING:
    from fastapi import FastAPI

HERE = pathlib.Path(__file__).resolve().parent
PACKAGE = HERE.parents[1]
DOCUMENT = HERE / "openapi.generated.json"
TYPES = HERE / "schema.generated.d.ts"

sys.path.insert(0, str(PACKAGE.parent))

from wsfs_suede.release.backend.blobs import Blobs  # noqa: E402
from wsfs_suede.release.backend.collaboration import ICollaboration  # noqa: E402
from wsfs_suede.release.backend.main import Backend, create_router  # noqa: E402
from wsfs_suede.release.backend.models import build_models  # noqa: E402
from wsfs_suede.release.backend.tutor import ITutor  # noqa: E402
from wsfs_suede.wsfs_suede__sqlmodel_utils_suede.postgres.db import Database  # noqa: E402


_absent: Any = None
"""What the stub is handed where a running host would hand a real thing."""


def _stub() -> "FastAPI":
    from fastapi import FastAPI

    async def never_asked() -> UUID:
        raise NotImplementedError("a schema is not a request")

    app = FastAPI(title="wsfs schema stub")
    app.include_router(
        create_router(
            backend=Backend.over(
                build_models(user_table="users", workspace_table="workspaces"),
                # Neither is reached: describing an endpoint never runs it, and
                # requiring a database driver to emit a type file would be a
                # tax on every consumer who only wants the types.
                cast(Database, _absent),
                cast(Blobs, _absent),
                heartbeat_seconds=15.0,
                grace_seconds=30.0,
                max_blob_bytes=0,
                # Nor this: the collaboration server is reached when a room is
                # filled, and describing an endpoint never fills one.
                liveblocks=cast(ICollaboration, _absent),
                # Nor this: a schema says what an answer looks like, and
                # describing that never asks anybody for one.
                tutor=cast(ITutor, _absent),
            ),
            authorize=never_asked,
        )
    )
    return app


def typed(document: pathlib.Path, into: pathlib.Path) -> None:
    _ = subprocess.run(
        ["npx", "--yes", "openapi-typescript@7", str(document), "-o", str(into)],
        check=True,
        cwd=PACKAGE,
    )


def main() -> None:
    _ = DOCUMENT.write_text(json.dumps(_stub().openapi(), indent=2) + "\n")
    typed(DOCUMENT, TYPES)
    print(f"wrote {DOCUMENT.name} and {TYPES.name}")


if __name__ == "__main__":
    main()
