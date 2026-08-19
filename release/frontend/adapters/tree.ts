/**
 * The file tree's view of the workspace, and the workspace's view of the tree.
 *
 * Both directions are paths, which is the only vocabulary the tree has. What
 * this adds is the rule that keeps them from fighting: the workspace is
 * upstream. A gesture in the tree becomes a transaction, and the tree's own
 * shape is then whatever the effective view says -- so a refused rename snaps
 * back on its own rather than needing to be undone.
 */
import type { Path } from "../paths";
import type { Workspace } from "../workspace";

export type Paths = {
  reset: (paths: readonly Path[]) => void;
  subscribe: (handlers: {
    /** A rename is a move too: both arrive as a pair of full paths. */
    moved?: (event: { from: Path; to: Path }) => void;
    removed?: (event: { path: Path }) => void;
  }) => () => void;
};

/**
 * Mirrors the workspace into a tree and translates the tree's gestures back.
 * Returns the teardown for both directions, because leaving one attached
 * without the other is how a tree starts disagreeing with the truth.
 */
export const mirror = (workspace: Workspace, tree: Paths) => {
  const show = () => tree.reset(workspace.index().paths());

  const listening = tree.subscribe({
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
