/**
 * The one workspace this page is looking at.
 *
 * Svelte's reactivity is all this adds: the client already says when the
 * effective view changed, and `$state` turns that into a re-render.
 */
import { Kernel } from "wsfs_suede.python-web-kernel-suede";
import fs from "wsfs_suede.python-web-kernel-suede/fs";
import { Editor } from "wsfs_suede.python-monaco-suede";

import {
  connect,
  filesystem,
  http,
  inMemory,
  provider,
  type Workspace,
} from "$wsfs";
import { Buffers } from "$lib/documents";

const BACKEND = "/wsfs";
const ROOT = "/home/pyodide";

/** The sample's stand-in for a session. A real host sends a cookie. */
const asUser = (email: string) => async () => ({ "X-User-Email": email });

export class Open {
  readonly workspace: Workspace;
  /** Open text files, and the answer to who to trust while one is open. */
  readonly buffers: Buffers;
  paths = $state<string[]>([]);
  /**
   * Ticks on every effective change, path-shaped or not. `paths` says which
   * files exist; this says that something about them moved -- which is what a
   * reader waiting for content has to watch.
   */
  revision = $state(0);
  readonly #stop: () => void;
  #kernel: Kernel | undefined;

  /**
   * `provides` registers this workspace's files with the editor, which keeps
   * ONE filesystem for the whole page -- so a second workspace open at the
   * same time must not, or the two race to register the same paths and the
   * loser is told the file it is adding is already a directory.
   */
  constructor(id: string, user: string, { provides = true } = {}) {
    this.workspace = connect({
      workspace: id,
      transport: http(BACKEND, asUser(user)),
      bytes: inMemory(),
    });
    this.buffers = new Buffers(this.workspace);
    this.#stop = this.workspace.watch(() => {
      this.paths = [...this.workspace.index().paths()].sort();
      this.revision += 1;
    });
    if (provides)
      Editor.provideFiles(provider(this.workspace), { searchRoot: "" });
  }

  edit(path: string) {
    return this.buffers.open(path);
  }

  close(path: string) {
    this.buffers.close(path);
  }

  /**
   * Built once, and given the same filesystem the editor writes through -- so
   * `import sibling` finds what is on screen rather than what was last saved.
   */
  kernel(): Kernel {
    // An open buffer beats the last accepted write, so running the file you
    // are looking at runs what is on the screen. The client cannot make that
    // rule -- it does not know a buffer exists -- so it is made here.
    const trusting: Workspace = {
      ...this.workspace,
      holding: (path) =>
        this.buffers.holding(path) ?? this.workspace.holding(path),
    };
    this.#kernel ??= new Kernel({
      fs: fs.readWrite({ ...filesystem(trusting), root: ROOT }),
      input: async (prompt) => window.prompt(prompt) ?? "",
    });
    return this.#kernel;
  }

  dispose() {
    this.#stop();
    this.buffers.dispose();
    this.workspace.stop();
  }
}

export const project = async (user: string): Promise<string> => {
  const response = await fetch("/projects", {
    method: "POST",
    headers: { "X-User-Email": user },
  });
  if (!response.ok)
    throw new Error(`could not open a project: ${response.status}`);
  return ((await response.json()) as { id: string }).id;
};
