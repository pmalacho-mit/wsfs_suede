import {
  FILE_TREE_TAG_NAME,
  FileTree,
  type FileTreeBatchOperation,
  type FileTreeGitStatusPatch,
  type FileTreeIcons,
  type FileTreeItemHandle,
  type FileTreeMoveOptions,
  type FileTreeRemoveOptions,
  type FileTreeRenderProps,
  type FileTreeResetOptions,
  type FileTreeResetPreparedOptions,
  type FileTreeScrollToPathOptions,
  type FileTreeVisibleRow,
  type GitStatusEntry,
} from "@pierre/trees";
import { Emitter, announceMutation, type Handlers, type Unsubscribe } from "./events";
import { announcing, type Options } from "./options";
import { Snapshot } from "./snapshot.svelte";

export type Path = string;

class Focus {
  readonly #tree: FileTree;
  readonly #snapshot: Snapshot;

  constructor(tree: FileTree, snapshot: Snapshot) {
    this.#tree = tree;
    this.#snapshot = snapshot;
  }

  get path(): Path | null {
    return this.#snapshot.focusedPath;
  }

  get index(): number {
    return this.#snapshot.focusedIndex;
  }

  get item(): FileTreeItemHandle | null {
    return this.#tree.getFocusedItem();
  }

  at(path: Path): void {
    this.#tree.focusPath(path);
  }

  first(): void {
    this.#tree.focusFirstItem();
  }

  last(): void {
    this.#tree.focusLastItem();
  }

  next(): void {
    this.#tree.focusNextItem();
  }

  previous(): void {
    this.#tree.focusPreviousItem();
  }

  parent(): void {
    this.#tree.focusParentItem();
  }

  nearest(path: Path | null): Path | null {
    return this.#tree.focusNearestPath(path);
  }
}

class Selection {
  readonly #tree: FileTree;
  readonly #snapshot: Snapshot;

  constructor(tree: FileTree, snapshot: Snapshot) {
    this.#tree = tree;
    this.#snapshot = snapshot;
  }

  get paths(): readonly Path[] {
    return this.#snapshot.selectedPaths;
  }

  has(path: Path): boolean {
    return this.#snapshot.selectedPaths.includes(path);
  }

  add(path: Path): void {
    this.#tree.getItem(path)?.select();
  }

  remove(path: Path): void {
    this.#tree.getItem(path)?.deselect();
  }

  toggle(path: Path): void {
    this.#tree.getItem(path)?.toggleSelect();
  }

  clear(): void {
    for (const path of [...this.paths]) this.remove(path);
  }

  only(path: Path): void {
    this.clear();
    this.add(path);
  }
}

class Search {
  readonly #tree: FileTree;
  readonly #snapshot: Snapshot;

  constructor(tree: FileTree, snapshot: Snapshot) {
    this.#tree = tree;
    this.#snapshot = snapshot;
  }

  get isOpen(): boolean {
    return this.#snapshot.searchOpen;
  }

  get value(): string {
    return this.#snapshot.searchValue;
  }

  get matches(): readonly Path[] {
    return this.#snapshot.searchMatches;
  }

  open(initialValue?: string): void {
    this.#tree.openSearch(initialValue);
  }

  close(): void {
    this.#tree.closeSearch();
  }

  set(value: string | null): void {
    this.#tree.setSearch(value);
  }

  focusNext(): void {
    this.#tree.focusNextSearchMatch();
  }

  focusPrevious(): void {
    this.#tree.focusPreviousSearchMatch();
  }
}

class Rows {
  readonly #tree: FileTree;
  readonly #snapshot: Snapshot;

  constructor(tree: FileTree, snapshot: Snapshot) {
    this.#tree = tree;
    this.#snapshot = snapshot;
  }

  get count(): number {
    return this.#snapshot.visibleCount;
  }

  /** `first` and `last` are both inclusive, and both are clamped to `count`. */
  slice(first: number, last: number): readonly FileTreeVisibleRow[] {
    return this.#tree.getVisibleRows(first, last);
  }

  all(): readonly FileTreeVisibleRow[] {
    return this.slice(0, this.count - 1);
  }

  paths(): readonly Path[] {
    return this.all().map(({ path }) => path);
  }

  names(): readonly string[] {
    return this.all().map(({ name }) => name);
  }
}

class Git {
  readonly #tree: FileTree;

  constructor(tree: FileTree) {
    this.#tree = tree;
  }

  set(entries?: readonly GitStatusEntry[]): void {
    this.#tree.setGitStatus(entries);
  }

  patch(patch: FileTreeGitStatusPatch): void {
    this.#tree.applyGitStatusPatch(patch);
  }
}

const renderTarget = (container: HTMLElement): FileTreeRenderProps =>
  container.localName === FILE_TREE_TAG_NAME
    ? { fileTreeContainer: container }
    : { containerWrapper: container };

/**
 * A `@pierre/trees` `FileTree` wearing Svelte's reactivity: every read of
 * `focus`, `selection`, `search` or `rows` is tracked, every write goes straight
 * through to the tree. `tree` is the unwrapped instance for anything not
 * mirrored here.
 */
export class Model {
  readonly tree: FileTree;
  readonly focus: Focus;
  readonly selection: Selection;
  readonly search: Search;
  readonly rows: Rows;
  readonly git: Git;

  readonly #events = new Emitter();
  readonly #snapshot = new Snapshot();
  readonly #teardown: Unsubscribe[] = [];

  constructor(options: Options) {
    this.tree = new FileTree(announcing(options, this.#events));
    this.focus = new Focus(this.tree, this.#snapshot);
    this.selection = new Selection(this.tree, this.#snapshot);
    this.search = new Search(this.tree, this.#snapshot);
    this.rows = new Rows(this.tree, this.#snapshot);
    this.git = new Git(this.tree);

    this.#teardown.push(this.tree.subscribe(() => this.#absorbChange()));
    this.#teardown.push(
      this.tree.onMutation("*", (event) =>
        announceMutation(this.#events, event),
      ),
    );
    this.#snapshot.refresh(this.tree);
  }

  subscribe(handlers: Handlers): Unsubscribe {
    return this.#events.subscribe(handlers);
  }

  item(path: Path): FileTreeItemHandle | null {
    return this.tree.getItem(path);
  }

  add(path: Path): void {
    this.tree.add(path);
  }

  remove(path: Path, options?: FileTreeRemoveOptions): void {
    this.tree.remove(path, options);
  }

  move(from: Path, to: Path, options?: FileTreeMoveOptions): void {
    this.tree.move(from, to, options);
  }

  batch(operations: readonly FileTreeBatchOperation[]): void {
    this.tree.batch(operations);
  }

  reset(paths: readonly Path[], options?: FileTreeResetOptions): void;
  reset(options: FileTreeResetPreparedOptions): void;
  reset(
    pathsOrOptions: readonly Path[] | FileTreeResetPreparedOptions,
    options?: FileTreeResetOptions,
  ): void {
    if (Array.isArray(pathsOrOptions)) this.tree.resetPaths(pathsOrOptions, options);
    else this.tree.resetPaths(pathsOrOptions as FileTreeResetPreparedOptions);
  }

  rename(path?: Path, options?: { removeIfCanceled?: boolean }): boolean {
    return this.tree.startRenaming(path, options);
  }

  scrollTo(path: Path, options?: FileTreeScrollToPathOptions): void {
    this.tree.scrollToPath(path, options);
  }

  setIcons(icons?: FileTreeIcons): void {
    this.tree.setIcons(icons);
  }

  mount(container: HTMLElement): Unsubscribe {
    this.tree.render(renderTarget(container));
    return () => this.tree.unmount();
  }

  hydrate(container: HTMLElement): Unsubscribe {
    this.tree.hydrate({ fileTreeContainer: container });
    return () => this.tree.unmount();
  }

  dispose(): void {
    for (const stop of this.#teardown.splice(0)) stop();
    this.tree.cleanUp();
  }

  #absorbChange(): void {
    const focusedBefore = this.#snapshot.focusedPath;
    this.#snapshot.refresh(this.tree);
    if (this.#snapshot.focusedPath !== focusedBefore)
      this.#events.emit("focus changed", this.#snapshot.focusedPath);
  }
}
