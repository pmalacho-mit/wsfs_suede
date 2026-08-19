/**
 * The file tree's view of the workspace, and the workspace's view of the tree.
 *
 * Both directions are paths, which is the only vocabulary the tree has. What
 * this adds is the rule that keeps them from fighting: the workspace is
 * upstream. A gesture in the tree becomes a transaction, and the tree's own
 * shape is then whatever the effective view says -- so a refused rename snaps
 * back on its own rather than needing to be undone.
 */
import { SEPARATOR, type Index, type Path } from "../paths";
import type { Workspace } from "../workspace";

export type Paths = {
  reset: (paths: readonly Path[]) => void;
  subscribe: (handlers: {
    /** A trailing separator is how a tree says "folder"; nothing else does. */
    added?: (event: { path: Path }) => void;
    /** A rename is a move too: both arrive as a pair of full paths. */
    moved?: (event: { from: Path; to: Path }) => void;
    removed?: (event: { path: Path }) => void;
  }) => () => void;
};

const holds = (path: Path) => path.endsWith(SEPARATOR);

/**
 * A folder is a folder because the workspace says so, not because something
 * lives inside it. Paths alone cannot tell an empty folder from a file, so the
 * type is what decides, and the trailing separator is how the tree hears it.
 */
const marked = (index: Index) => (path: Path) =>
  index.at(path)?.type === "folder" ? `${path}${SEPARATOR}` : path;

const shown = (workspace: Workspace): Path[] => {
  const index = workspace.index();
  return index.paths().map(marked(index)).sort();
};

const same = (left: readonly Path[], right: readonly Path[]) =>
  left.length === right.length && left.every((path, at) => path === right[at]);

/**
 * Mirrors the workspace into a tree and translates the tree's gestures back.
 * Returns the teardown for both directions, because leaving one attached
 * without the other is how a tree starts disagreeing with the truth.
 */
export const mirror = (workspace: Workspace, tree: Paths) => {
  let showing: Path[] = [];

  /**
   * Resets only when the SHAPE moved. Most of what a workspace publishes
   * changes no path at all -- every write, every content event -- and a reset
   * costs the tree its selection, its expansion, and whatever the user was
   * halfway through typing into a rename box.
   */
  const show = () => {
    const paths = shown(workspace);
    if (same(paths, showing)) return;
    showing = paths;
    tree.reset(paths);
  };

  const listening = tree.subscribe({
    added: ({ path }) =>
      void (holds(path) ? workspace.folder(path) : workspace.create(path, "")),
    moved: ({ from, to }) => void workspace.move(from, to),
    removed: ({ path }) => void workspace.remove(path),
  });

  const watching = workspace.watch(show);
  show();

  return () => {
    listening();
    watching();
  };
};
