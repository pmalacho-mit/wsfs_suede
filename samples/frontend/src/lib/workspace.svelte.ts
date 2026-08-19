/**
 * The one workspace this page is looking at.
 *
 * Svelte's reactivity is all this adds: the client already says when the
 * effective view changed, and `$state` turns that into a re-render.
 */
import { Kernel } from "wsfs_suede.python-web-kernel-suede";
import fs from "wsfs_suede.python-web-kernel-suede/fs";
import { Editor } from "wsfs_suede.python-monaco-suede";

import { connect, filesystem, http, inMemory, provider, type Workspace } from "$wsfs";

const BACKEND = "/wsfs";
const ROOT = "/home/pyodide";

/** The sample's stand-in for a session. A real host sends a cookie. */
const asUser = (email: string) => async () => ({ "X-User-Email": email });

export class Open {
  workspace: Workspace;
  paths = $state<string[]>([]);
  #stop: () => void;
  #kernel: Kernel | undefined;

  constructor(id: string, user: string) {
    this.workspace = connect({
      workspace: id,
      transport: http(BACKEND, asUser(user)),
      bytes: inMemory(),
    });
    this.#stop = this.workspace.watch(() => {
      this.paths = [...this.workspace.index().paths()].sort();
    });
    void Editor.provideFiles(provider(this.workspace), { searchRoot: "" });
  }

  edit(path: string) {
    return this.workspace.edit(path);
  }

  close(path: string) {
    return this.workspace.close(path);
  }

  /**
   * Built once, and given the same filesystem the editor writes through -- so
   * `import sibling` finds what is on screen rather than what was last saved.
   */
  kernel(): Kernel {
    this.#kernel ??= new Kernel({
      fs: fs.readWrite({ ...filesystem(this.workspace), root: ROOT }),
      input: async (prompt) => window.prompt(prompt) ?? "",
    });
    return this.#kernel;
  }

  dispose() {
    this.#stop();
    this.workspace.stop();
  }
}

export const project = async (user: string): Promise<string> => {
  const response = await fetch("/projects", {
    method: "POST",
    headers: { "X-User-Email": user },
  });
  if (!response.ok) throw new Error(`could not open a project: ${response.status}`);
  return ((await response.json()) as { id: string }).id;
};
