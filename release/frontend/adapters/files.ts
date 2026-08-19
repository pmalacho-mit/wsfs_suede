/**
 * The editor's view of the workspace.
 *
 * `FileProvider` wants paths and text and nothing else, which is most of what
 * makes it a good seam: the editor never learns that entries have ids, tokens,
 * or a queue behind them. What it does learn, promptly, is that a file changed
 * -- so imports resolve against what the tree actually holds rather than
 * against whatever was there when the editor mounted.
 */
import { textOf } from "../content";
import type { Path } from "../paths";
import type { Workspace } from "../workspace";

export type Change = { path: Path; kind: "added" | "changed" | "removed" };
export type Listener = (change: Change) => void;
export type Unsubscribe = () => void;

export type FileProvider = {
  paths: () => Iterable<Path>;
  read: (path: Path) => Promise<string>;
  write: (path: Path, text: string) => Promise<void>;
  watch: (listen: Listener) => Unsubscribe;
};

const changesBetween = (before: Set<Path>, after: Set<Path>): Change[] => [
  ...[...after].filter((path) => !before.has(path)).map(added),
  ...[...before].filter((path) => !after.has(path)).map(removed),
];

const added = (path: Path): Change => ({ path, kind: "added" });
const removed = (path: Path): Change => ({ path, kind: "removed" });

export const provider = (workspace: Workspace): FileProvider => ({
  paths: () => workspace.index().paths(),

  read: async (path) => {
    const held = await workspace.read(path);
    if (held === undefined) throw new Error(`No such file: ${path}`);
    return textOf(held);
  },

  write: (path, text) => workspace.write(path, text),

  /**
   * Only appearances and disappearances are announced. Content changes reach
   * the editor through the document it holds open, and announcing them here
   * too would ask it to reload a buffer somebody is typing into.
   */
  watch: (listen) => {
    let known = new Set(workspace.index().paths());
    return workspace.watch(() => {
      const now = new Set(workspace.index().paths());
      changesBetween(known, now).forEach(listen);
      known = now;
    });
  },
});
