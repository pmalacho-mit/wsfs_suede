<script lang="ts" module>
  import {
    ContextMenu,
    Tree,
    entries,
  } from "../../../wsfs_suede.pierre-trees-svelte-suede";
  import { WithEvents } from "../../../wsfs_suede.with-events-suede";

  type Context = ContextMenu.Props["context"];
  type Item = Tree.ContextMenu["item"];

  /** The workspace root, spelled the way the menu's mutations expect it. */
  const root: Item = { kind: "directory", name: "", path: "" };

  /** A right click landed on an entry if the tree drew one under it. */
  const onEntry = (event: MouseEvent): boolean =>
    event
      .composedPath()
      .some(
        (node) => node instanceof HTMLElement && node.dataset.type === "item",
      );

  const inMenu = (event: Event): boolean =>
    event
      .composedPath()
      .some(
        (node) =>
          node instanceof HTMLElement &&
          node.dataset.fileTreeContextMenuRoot === "true",
      );

  export type Id = string;

  /** A folder's path carries a trailing separator; the workspace's does not. */
  const sanitizeForTree = (path: string, folder: boolean) =>
    folder ? `${path}/` : path;

  const depth = (path: string) => path.split("/").length;

  /**
   * What the mapping tells the world about, so nothing else has to.
   *
   * Both directions -- a change arriving from the workspace, and a gesture
   * going the other way -- pass through the table below, and only through it.
   * Deriving the announcements from its transitions is what makes it
   * impossible for one direction to announce and the other to forget.
   */
  type Announce = {
    added: (entry: Entry) => void;
    removed: (entry: Entry) => void;
    renamed: (entry: Entry, from: Path) => void;
  };

  /**
   * Where the tree has each entry.
   *
   * The workspace speaks in entry ids and the tree in paths, and this is the
   * table between them. It records the TREE's paths, not the workspace's: a
   * folder somebody else renames moves a whole subtree here in one step,
   * which is the entire reason for holding ids rather than re-deriving every
   * path and comparing them.
   */
  class EntryMapping {
    readonly #byId = new Map<Id, Path>();
    readonly #byPath = new Map<Path, Id>();
    readonly #on: Announce;

    constructor(announce: Announce) {
      this.#on = announce;
    }

    at(entry: Id): Path | undefined {
      return this.#byId.get(entry);
    }

    of(path: Path): Id | undefined {
      return this.#byPath.get(path);
    }

    /**
     * Add or update an entry's place in the mapping.
     *
     * If `entry` already had a place in the mapping,
     * a `renamed` will be announced.
     *
     * If `entry` was never in the mapping,
     * a `added` will be announced.
     */
    set(entry: Id, path: Path): void {
      const existing = this.#byId.get(entry);
      if (existing === path) return;
      if (existing !== undefined) this.#byPath.delete(existing);
      this.#byId.set(entry, path);
      this.#byPath.set(path, entry);
      if (existing === undefined) this.#on.added({ id: entry, path });
      else this.#on.renamed({ id: entry, path }, existing);
    }

    /**
     * Drops an entry and everything the tree keeps under it.
     *
     * Each of them is announced `removed`, deepest first.
     *
     * The deletion of a folder only triggers a workspace change
     * (via `workspace.watch`) to that specific entry,
     * so we must act on its children so that a user knows
     * that a potential file they're working on was deleted.
     */
    uproot(entry: Id): void {
      const path = this.#byId.get(entry);
      if (path === undefined) return;
      for (const child of this.#under(path)) this.#remove(...child);
      this.#remove(entry, path);
    }

    /**
     * Follows a move, carrying whatever was underneath -- and announcing each
     * of them, because their paths moved too even though nothing renamed them.
     */
    carry(entry: Id, from: Path, to: Path): void {
      for (const [child, path] of this.#under(from))
        this.set(child, to + path.slice(from.length));
      this.set(entry, to);
    }

    /** Everything strictly beneath `path`, which a folder carries with it. */
    #under(path: Path): [Id, Path][] {
      const dir = path.endsWith("/") ? path : `${path}/`;
      return [...this.#byId].filter(([, held]) => held.startsWith(dir));
    }

    #remove(id: Id, path: string) {
      this.#byId.delete(id);
      this.#byPath.delete(path);
      this.#on.removed({ id, path });
    }
  }

  /**
   * Transactions this tree issued, so their echo can be ignored.
   *
   * An entry isropped once the server has answered. Nothing arrives attributed to a
   * settled transaction that this has to skip -- the event confirming it
   * announces nothing at all, and the one case that DOES arrive later, a
   * refusal restoring a value one of these asserted, is marked `retracting`
   * and applied whether or not the id is still here.
   *
   * This cannot catch the FIRST echo of a gesture, and nothing could:
   * submitting recomputes the workspace and announces the change before the
   * call that submitted it has returned, so there is no moment at which to
   * write the transaction down first. What covers that gap is the rule below
   * -- the registry is made to match the tree BEFORE the workspace is told --
   * which leaves the echo with nothing to do. This is the cheaper answer for
   * every echo after it.
   */
  const trackOwnSubmissions = () => {
    type Transaction = string;
    const transactions = new Set<Transaction>();
    const track = ({ transaction }: Submitting) =>
      transactions.add(transaction);
    const untrack = ({ transaction }: Submitting) =>
      transactions.delete(transaction);
    return {
      tracked: ({ by }: Change) => transactions.has(by),
      trackUntilSettled: <T extends Submitting>(submission: T) => {
        track(submission);
        const off = untrack.bind(null, submission);
        submission.settled.then(off, off);
        return submission;
      },
    };
  };

  type Path = string;
  /** An entry as anybody outside needs it: what it is, and where it is now. */
  export type Entry = { id: Id; path: Path };
  export type Directory = Entry & { children: Entry[] };
  export type Snapshot = Directory["children"]; // snapshot is from root

  type MinimalWorkspace = Pick<
    Workspace,
    "index" | "entries" | "move" | "folder" | "create" | "remove" | "watch"
  >;

  /**
   * The tree's filesystem, announced.
   *
   * Every announcement carries the id AND the path, because upstream needs
   * both and neither is derivable from the other in time: a tab is keyed by
   * path, and the thing that outlives a rename is the id.
   *
   * These are announced whoever caused them. A file this user deleted and a
   * file somebody else deleted both need the tab closed, and a consumer that
   * had to work out which was which would get it wrong.
   */
  export class Model extends WithEvents<{
    added: [entry: Entry];
    removed: [entry: Entry];
    renamed: [entry: Entry, from: Path];
    open: [entry: Entry];
  }> {
    readonly workspace: MinimalWorkspace;
    readonly mapping: EntryMapping;
    /** The underlying model of the `pierre-trees-svelte-suede` library*/
    readonly tree: Tree.Model;

    /** What has happened here that the workspace has not been told yet. */
    #deferredAnnouncements: (() => void)[] | undefined;
    #selecting = false;

    constructor(workspace: MinimalWorkspace) {
      super();
      this.workspace = workspace;
      this.mapping = new EntryMapping({
        added: (entry) =>
          this.enqueueAnnouncement(() => this.fire("added", entry)),
        removed: (entry) =>
          this.enqueueAnnouncement(() => this.fire("removed", entry)),
        renamed: (entry, from) =>
          this.enqueueAnnouncement(() => this.fire("renamed", entry, from)),
      });
      this.tree = new Tree.Model({
        paths: [],
        renaming: true,
        dragAndDrop: true,
      });
    }

    /**
     * Does what `act` does without saying so yet.
     *
     * A gesture has to square this model's own bookkeeping BEFORE the
     * workspace is told, because telling it recomputes and hands the change
     * straight back -- so anything still describing the world as it was gets
     * acted on. But a listener told at that moment would be told about a path
     * the workspace does not have yet, and reading at it would throw.
     *
     * So the table moves first and the news waits, until `announce`.
     *
     * Only ever called where a submission is certain to follow: deferred
     * announcements are released by the workspace changing, and one with no
     * submission behind it would wait for a change that never comes.
     */
    performAndDeferAnyAnnouncements(act: () => void): void {
      this.#deferredAnnouncements ??= [];
      act();
    }

    /** Says everything `holding` put off, now that it is true. */
    announceDeferred(): void {
      const deferred = this.#deferredAnnouncements;
      this.#deferredAnnouncements = undefined;
      deferred?.forEach((announce) => announce());
    }

    /**
     * Shows an entry as the selected one, or clears the selection.
     *
     * A row is selected because its panel is in front, and a panel is in
     * front because its row was selected -- the same fact said in two places,
     * and each has to be able to hear the other without answering back.
     * Selecting a row is how a USER asks for something to be opened, so this
     * makes the row look right without asking for anything.
     *
     * An entry the tree has never heard of leaves the selection alone: not
     * knowing where something is is not a reason to stop showing where the
     * user is.
     */
    select(entry: Id | undefined): void {
      if (entry === undefined)
        return this.#quietly(() => this.tree.selection.clear());
      const path = this.mapping.at(entry);
      if (path === undefined || this.tree.selection.has(path)) return;
      this.#quietly(() => this.tree.selection.only(path));
    }

    /**
     * Clears the selection, but only if `entry` is what it is showing.
     *
     * A panel closing hands the front to another one, which has already
     * claimed the selection -- so this has to check rather than assume, and
     * then the order the two arrive in stops mattering.
     */
    deselect(entry: Id): void {
      const path = this.mapping.at(entry);
      if (path === undefined || !this.tree.selection.has(path)) return;
      this.select(undefined);
    }

    /** Whether the selection is being set from outside rather than by hand. */
    get selecting(): boolean {
      return this.#selecting;
    }

    #quietly(act: () => void): void {
      this.#selecting = true;
      try {
        act();
      } finally {
        this.#selecting = false;
      }
    }

    enqueueAnnouncement(announcement: () => void): void {
      if (this.#deferredAnnouncements === undefined) announcement();
      else this.#deferredAnnouncements.push(announcement);
    }
  }

  export declare namespace Model {
    export { Entry };
  }

  export type Props = {
    model: Model;
  };

  /** Where the workspace says an entry belongs, spelled the tree's way. */
  const pathInWorkspace = (
    workspace: Pick<Workspace, "index" | "entries">,
    entry: Id,
  ): string | undefined => {
    const path = workspace.index().of(entry);
    if (path === undefined) return undefined;
    const isFolder = workspace.entries().get(entry)?.type === "folder";
    return sanitizeForTree(path, isFolder);
  };
</script>

<script lang="ts">
  import { warmRoom } from "./collaborator";
  import { onDestroy } from "svelte";
  import type { Change, Submitting, Workspace } from "../";
  import { themes } from "../../../wsfs_suede.pierre-trees-svelte-suede/themes";
  import { appearance } from "./appearance.svelte";
  import { pointAsRect } from "./utils";

  let { model }: Props = $props();

  /**
   * The tree's palette, which is a fetch rather than a class: its themes are
   * split out of the bundle, so the shell paints its own way for the frame or
   * two before this arrives.
   */
  let theme = $state("");

  $effect(() => {
    const name = appearance.treeTheme;
    let live = true;
    themes.css(name).then((css) => live && (theme = css));
    return () => (live = false);
  });

  const { workspace, mapping, tree } = $derived(model);
  const submissions = trackOwnSubmissions();

  /**
   * Files this tree has just named, waiting for the workspace to hold them.
   *
   * Announcing one as open before the workspace has it would hand a consumer
   * a path it cannot read. Nothing is waiting on the SERVER here -- the
   * outbox captures a create a microtask or two after `create` returns,
   * because hashing the content is async, and that is the whole delay.
   *
   * Held by id rather than by path: a rename landing in the same breath would
   * lose a path, and cannot lose an id.
   */
  const awaiting = new Set<Id>();

  const workspaceToTreeOperation = {
    removed: (entry: Id): Tree.BatchOperation | undefined => {
      const path = mapping.at(entry);
      if (path === undefined) return;
      mapping.uproot(entry);
      return { type: "remove", path, recursive: true };
    },
    modified: (entry: Id): Tree.BatchOperation | undefined => {
      const to = pathInWorkspace(workspace, entry);
      if (to === undefined) return workspaceToTreeOperation.removed(entry);
      const from = mapping.at(entry);
      if (from === undefined || from === to) return; // missing in tree mapping, will be handled by `asbent`
      mapping.carry(entry, from, to);
      return { type: "move", from, to, collision: "replace" };
    },
    /**
     * Add anything the workspace has that the tree does not.
     * Like when a folder is restored, its decendants return to the workspace,
     * but there's no change event.
     *
     * @todo If this is just to handle apperances after folders are restored,
     * should we limit the search over `workspace.workspace.entries()` for efficiency?
     */
    materialized: (): Tree.BatchOperation[] => {
      const missing: [Id, string][] = [];
      for (const { id } of workspace.entries().values()) {
        if (mapping.at(id) !== undefined) continue;
        const path = pathInWorkspace(workspace, id);
        if (path !== undefined) missing.push([id, path]);
      }
      // shallowest first so a folder is there before what lives in it.
      missing.sort(([, left], [, right]) => depth(left) - depth(right));
      const adds: Tree.BatchOperation[] = [];
      for (const [entry, path] of missing) {
        mapping.set(entry, path);
        if (tree.item(path) === null) adds.push({ type: "add", path });
      }
      return adds;
    },
  };

  const applyWorkspaceChanges = Object.assign(
    (changes: readonly Change[]) => {
      const removed = new Set<Id>();
      const kept = new Set<Id>();

      for (const change of changes) {
        const seen =
          change.retracting === undefined && submissions.tracked(change);
        if (seen || change.kind === "written") continue;
        if (change.kind === "removed" || change.kind === "vanished")
          removed.add(change.entry);
        else kept.add(change.entry);
      }
      if (removed.size === 0 && kept.size === 0) return;

      const operations = [
        ...[...removed].map(workspaceToTreeOperation.removed),
        ...[...kept].map(workspaceToTreeOperation.modified),
        ...workspaceToTreeOperation.materialized(),
      ].filter((operation) => operation !== undefined);

      if (operations.length === 0) return;

      applyWorkspaceChanges.wrap(() => tree.batch(operations));
    },
    {
      /** Are workspace changes actively being committed. */
      active: false,
      /** Execute an `fn` that constitutes workspace changes (and sets `active` accordingly)*/
      wrap: (fn: () => any) => {
        applyWorkspaceChanges.active = true;
        try {
          fn();
        } finally {
          applyWorkspaceChanges.active = false;
        }
      },
      /** Don't run the provided `fn` if workspace changes are active. */
      guard: (fn: () => any) =>
        applyWorkspaceChanges.active ? undefined : fn(),
    },
  );

  /*
   * A gesture squares the mapping and tells the workspace, in that order and
   * under `holding` -- see `Model.holding` for why it is both of those.
   *
   * A create is the one that cannot square first: its id does not exist until
   * the workspace has been asked for it. `materialized` covers that by asking
   * the TREE what is already drawn rather than asking the mapping.
   */
  const add = (path: string) => {
    const isFolder = path.endsWith("/");
    const { entry } = submissions.trackUntilSettled(
      isFolder ? workspace.folder(path) : workspace.create(path, ""),
    );
    model.performAndDeferAnyAnnouncements(() => mapping.set(entry, path));
    if (!isFolder) {
      awaiting.add(entry);
      warmRoom(entry);
    }
  };

  const move = (from: string, to: string) => {
    const entry = mapping.of(from);
    if (entry === undefined) return;
    model.performAndDeferAnyAnnouncements(() => mapping.carry(entry, from, to));
    submissions.trackUntilSettled(workspace.move(from, to));
  };

  const remove = (path: string) => {
    const entry = mapping.of(path);
    if (entry === undefined) return;
    model.performAndDeferAnyAnnouncements(() => mapping.uproot(entry));
    submissions.trackUntilSettled(workspace.remove(path));
  };

  /**
   * A file named here opens once it is real. Nothing else does: `added` also
   * arrives for the first snapshot and for everybody else's work, and opening
   * on that would fling every file in the workspace onto the screen.
   */
  const openWhatWasNamed = () => {
    for (const entry of [...awaiting]) {
      const path = pathInWorkspace(workspace, entry);
      if (path === undefined) continue;
      awaiting.delete(entry);
      model.fire("open", { id: entry, path });
    }
  };

  $effect(() => {
    const stop = [
      workspace.watch((changes) => {
        applyWorkspaceChanges(changes);
        model.announceDeferred();
        openWhatWasNamed();
      }),
      tree.subscribe({
        added: ({ path }) => applyWorkspaceChanges.guard(() => add(path)),
        moved: ({ from, to }) =>
          applyWorkspaceChanges.guard(() => move(from, to)),
        renamed: ({ sourcePath, destinationPath }) =>
          applyWorkspaceChanges.guard(() => move(sourcePath, destinationPath)),
        removed: ({ path }) => applyWorkspaceChanges.guard(() => remove(path)),
        "selection changed": ([path]) => {
          if (model.selecting) return;
          if (path === undefined || Tree.isDirectory(tree.item(path))) return;
          const entry = mapping.of(path);
          if (entry !== undefined) model.fire("open", { id: entry, path });
        },
        "rename refused": (reason) => console.error(reason),
      }),
    ];

    const planting = workspaceToTreeOperation.materialized();
    if (planting.length > 0)
      applyWorkspaceChanges.wrap(() => tree.batch(planting));

    return () => stop.forEach((end) => end());
  });

  onDestroy(() => tree.dispose());

  /**
   * The tree's own menu belongs to an entry, so a right click that misses
   * every entry gets nothing -- and the space below the last one is most of
   * the panel. That click opens this menu instead: the same surface, anchored
   * to the pointer, acting on the root.
   */
  let at = $state<{ x: number; y: number } | undefined>(undefined);
  let anchor = $state<HTMLElement>();
  let surface = $state<HTMLElement>();

  const dismiss = () => (at = undefined);

  const asked = (event: MouseEvent) => {
    dismiss();
    if (onEntry(event)) return;
    event.preventDefault();
    at = { x: event.clientX, y: event.clientY };
  };

  // The anchor is placed within the tree so the menu travels with it; the
  // rect it reports is the viewport point, which is what the menu flips on.
  const placed = $derived.by(() => {
    if (!at || !surface) return undefined;
    const box = surface.getBoundingClientRect();
    return { left: at.x - box.left, top: at.y - box.top };
  });

  const context = $derived.by((): Context | undefined => {
    if (!at || !anchor) return undefined;
    return {
      anchorElement: anchor,
      anchorRect: pointAsRect(at.x, at.y),
      close: dismiss,
      restoreFocus: () => {},
    };
  });

  /**
   * Two of the four the tree's own menu offers, because the other two need an
   * entry to act on and this menu has none.
   */
  const rootActions = (open: Context): ContextMenu.Action[] => {
    // Adding hands focus straight to the tree's rename input, which the
    // menu's usual focus restore would immediately steal back.
    const handOver = (act: () => void) => () => {
      open.close({ restoreFocus: false });
      act();
    };
    return [
      {
        label: "Add file",
        run: handOver(() => entries.add(tree, root, "file")),
      },
      {
        label: "Add folder",
        run: handOver(() => entries.add(tree, root, "folder")),
      },
    ];
  };

  $effect(() => {
    if (!at) return;
    const elsewhere = (event: Event) => void (inMenu(event) || dismiss());
    const escaped = (event: KeyboardEvent) =>
      event.key === "Escape" && dismiss();
    window.addEventListener("pointerdown", elsewhere, true);
    window.addEventListener("keydown", escaped, true);
    return () => {
      window.removeEventListener("pointerdown", elsewhere, true);
      window.removeEventListener("keydown", escaped, true);
    };
  });
</script>

<!-- The tree fills this, so the empty space below the last entry is still the
     tree's -- which is the whole point of the menu above. -->
<div
  class="tree"
  data-region="tree"
  bind:this={surface}
  oncontextmenu={asked}
  role="presentation"
>
  <Tree.Component model={tree} style="height: 100%; {theme}">
    {#snippet contextMenu(item, opened)}
      <ContextMenu.Component
        context={opened}
        actions={ContextMenu.actions({ model: tree, item, context: opened })}
      />
    {/snippet}
  </Tree.Component>

  <div
    class="anchor"
    bind:this={anchor}
    style:left="{placed?.left ?? 0}px"
    style:top="{placed?.top ?? 0}px"
  >
    {#if context}
      <ContextMenu.Component {context} actions={rootActions(context)} />
    {/if}
  </div>
</div>

<style>
  .tree {
    position: relative;
    height: 100%;
    min-height: 0;
  }

  /* Nothing of its own: a zero-sized origin at the pointer, for the menu to
     hang off exactly as it hangs off a row's. */
  .anchor {
    position: absolute;
    width: 0;
    height: 0;
    z-index: 60;
  }
</style>
