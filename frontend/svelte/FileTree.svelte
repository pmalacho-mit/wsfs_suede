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

  /** The row a click landed on, if the tree drew one under it. */
  const rowUnder = (event: MouseEvent): HTMLElement | undefined =>
    event
      .composedPath()
      .find(
        (node) => node instanceof HTMLElement && node.dataset.type === "item",
      ) as HTMLElement | undefined;

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

  /** Either spelling of a path names the same row, so both are asked about. */
  const bothSpellings = (path: string) => [
    path,
    path.endsWith("/") ? path.slice(0, -1) : `${path}/`,
  ];

  /**
   * The same numbering the tree gives a draft whose name is taken, so an
   * upload that lands beside an entry of the same name reads like every other
   * duplicate here rather than like a second convention.
   */
  const numbered = (path: string, suffix: number) => {
    if (path.endsWith("/")) return `${path.slice(0, -1)}-${suffix}/`;
    const dot = path.lastIndexOf(".");
    return dot > path.lastIndexOf("/")
      ? `${path.slice(0, dot)}-${suffix}${path.slice(dot)}`
      : `${path}-${suffix}`;
  };

  const depth = (path: string) => path.split("/").length;

  /** The last segment, whichever kind of path it is. */
  const nameIn = (path: string) =>
    path.replace(/\/+$/, "").split("/").pop() ?? "";

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
    | "room"
    | "index"
    | "entries"
    | "move"
    | "folder"
    | "create"
    | "remove"
    | "watch"
    /** Downloading a copy of a file is the one thing here that READS one. */
    | "read"
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
        /**
         * A folder whose only child is another folder keeps its own row.
         *
         * The tree's default is to draw `a/b/` as one row, which reads well
         * in a diff and badly in an explorer somebody is USING: the outer
         * folder then has nothing of its own to right click, to drop onto, or
         * to drag -- so the one gesture available on it is the one that acts
         * on the inner folder instead.
         */
        flattenEmptyDirectories: false,
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
  import MenuLayer from "./MenuLayer.svelte";
  import { Button } from "./shadcn/ui/button";
  import DownloadIcon from "@lucide/svelte/icons/download";
  import UploadIcon from "@lucide/svelte/icons/upload";
  import { chosen, download, foldersFor, type Chosen } from "./transfer";

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

  /**
   * What an uploaded file holds, waiting for the tree to ask for it.
   *
   * An upload is a hand-made entry with something already in it, and this is
   * the only difference between the two. It is left here rather than passed,
   * because passing it would mean a SECOND way to create an entry -- and the
   * one below is the way that keeps the mapping, the deferred announcements
   * and the outbox in step. So the upload adds a row like a person does, and
   * `add` finds the content here when it goes to create it.
   */
  const uploading = new Map<Path, Chosen>();

  /**
   * What the create `add` last made is waiting for.
   *
   * An upload is the only thing that needs it, and it needs it badly. A
   * create names its parent by ID, and two of them sent in the same breath
   * are two requests in flight at once -- which the server is free to answer
   * in either order. Answer the child first and it names a folder that does
   * not exist yet, and it is refused, along with everything under it.
   *
   * Everywhere else these are seconds apart, because a person is typing
   * between them, and nothing has ever had to wait.
   */
  let lastSubmitted: Submitting | undefined;

  /**
   * What it is waiting for, read through a call.
   *
   * The assignment that fills it in happens inside the tree's own event, so
   * it is not one the compiler can see -- and a plain read straight after
   * clearing it is narrowed to `undefined` and refuses to have a `settled`.
   */
  const settling = (): Promise<unknown> | undefined => lastSubmitted?.settled;

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
  /**
   * Fill this file's room, once the file is one the server has heard of.
   *
   * Warming names an entry the host has to look up, and a create is an id and
   * an intention until it is accepted -- so asking straight away asks about a
   * file that does not exist yet, and is answered as such.
   *
   * NOTHING DEPENDS ON IT. Warming early only makes opening the file instant
   * later; a create that is refused, or a host that cannot be reached, costs
   * whoever opens it the second they would have waited anyway. So this is the
   * one call here that is allowed to fail quietly -- but not to fail loudly,
   * which is what it did when it was left floating.
   */
  const warmOnceMade = async (submission: Submitting & { entry: Id }) => {
    try {
      if ((await submission.settled).rejected) return;
      await warmRoom(workspace, submission.entry);
    } catch {
      /* Opening the file is slower, and only the first time. */
    }
  };

  const add = (path: string) => {
    const isFolder = path.endsWith("/");
    const carried = uploading.get(path);
    uploading.delete(path);
    const submission = submissions.trackUntilSettled(
      isFolder
        ? workspace.folder(path)
        : workspace.create(path, carried?.content ?? "", carried?.mime),
    );
    const { entry } = submission;
    lastSubmitted = submission;
    model.performAndDeferAnyAnnouncements(() => mapping.set(entry, path));
    if (isFolder) return;
    // An uploaded file is neither opened nor warmed. A person naming a file
    // is about to type into it, and one choosing forty of them is not -- and
    // forty rooms nobody has asked for is forty round trips to the host.
    if (carried !== undefined) return;
    awaiting.add(entry);
    void warmOnceMade(submission);
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
   * Keeps a copy of what is at `path` -- the file, or the folder as a zip.
   *
   * `""` is the workspace itself, which is what the buttons below and the
   * menu on the tree's own empty space both act on.
   */
  const keepACopy = (path: Path) => {
    void download(workspace, path).catch((trouble) =>
      console.error(`could not download ${path || "the workspace"}`, trouble),
    );
  };

  /**
   * A path no row in the tree is using, under either spelling -- and that
   * nothing else in the same upload has already been promised.
   */
  const vacant = (path: Path, claimed: ReadonlySet<Path>): Path => {
    const taken = (candidate: Path) =>
      bothSpellings(candidate).some(
        (spelling) => tree.item(spelling) !== null || claimed.has(spelling),
      );
    let suffix = 0;
    let candidate = path;
    while (taken(candidate)) candidate = numbered(path, ++suffix);
    return candidate;
  };

  /**
   * Where an uploaded path lands.
   *
   * Only its FIRST segment can collide with anything already here -- what is
   * below that is inside something this upload is bringing with it -- so that
   * is the only segment renamed, and every file under a folder renamed this
   * way follows it. Merging into an existing folder of the same name would be
   * the other answer, and it is the one that can overwrite somebody's work.
   */
  const placing = () => {
    const settled = new Map<string, string>();
    // Nothing in the tree yet, because nothing has been added yet -- so the
    // names this upload has already spoken for are only written down here.
    const claimed = new Set<string>();
    return (path: Path): Path => {
      const [head = "", ...rest] = path.split("/");
      const inFolder = rest.length > 0;
      const key = inFolder ? `${head}/` : head;
      let free = settled.get(key);
      if (free === undefined) {
        free = vacant(key, claimed);
        settled.set(key, free);
        for (const spelling of bothSpellings(free)) claimed.add(spelling);
      }
      return inFolder ? `${free}${rest.join("/")}` : free;
    };
  };

  /**
   * Files from a disk, added exactly as a person adds them.
   *
   * Folders first and shallowest first, because a create names its parent by
   * id and the parent has to exist before the child asks for it. Everything
   * after that is `tree.add`, which is the same call the tree makes when a
   * draft is finally named -- so the workspace, the mapping and the outbox
   * hear about these the one way they hear about anything.
   */
  const receive = async (files: readonly File[]) => {
    if (files.length === 0) return;
    const place = placing();
    const landing = (await chosen(files)).map((one) => ({
      ...one,
      path: place(one.path),
    }));

    // One at a time, and waiting: see `lastSubmitted`. The ROW appears at
    // once either way -- what is being waited for is the server's answer,
    // and only so that what goes inside has somewhere to go.
    for (const folder of foldersFor(landing.map((one) => one.path))) {
      if (tree.item(folder) !== null) continue;
      lastSubmitted = undefined;
      tree.add(folder);
      await settling();
    }

    for (const one of landing) {
      uploading.set(one.path, one);
      tree.add(one.path);
      // A row the tree declined to draw is a file that will never be created,
      // and its bytes would otherwise sit here until the page went away.
      uploading.delete(one.path);
    }
  };

  let picker = $state<HTMLInputElement>();

  const askForFiles = () => picker?.click();

  const picked = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    // Cleared before the work starts, so choosing the same file twice in a
    // row is still a change the input reports.
    input.value = "";
    void receive(files).catch((trouble) =>
      console.error("could not upload", trouble),
    );
  };

  /**
   * EVERY MENU IN THIS PANEL IS THIS ONE.
   *
   * The tree draws its own for a row, and it used to. Two things were wrong
   * with leaving it to. A right click that misses every entry gets nothing
   * from it, and the space below the last row is most of the panel. And it
   * anchors a row's menu at the pointer's VIEWPORT coordinates, which the
   * browser multiplies again by whatever the panel is zoomed to -- at 200%
   * the menu opened twice as far down the page as the click. `MenuLayer` does
   * not save it: the top layer is what stops a menu being clipped by the
   * panel it opened in, and a `position: fixed` box inside something zoomed
   * is scaled wherever it ends up painted.
   *
   * So the tree is composed without one -- no snippet, no menu -- and this
   * surface answers both, from OUTSIDE the zoomed tree. That is what makes
   * the placement plain: a row's menu hangs under that row, a click on empty
   * space hangs from the pointer, and neither has heard of the text size.
   */
  let at = $state<{ x: number; y: number } | undefined>(undefined);
  /** Whose menu is open: an entry's, or -- when nothing -- the root's. */
  let on = $state<Item | undefined>(undefined);
  let surface = $state<HTMLElement>();

  /** The gap between a row and the menu it opened. A constant, in pixels. */
  const BELOW = 4;

  const dismiss = () => ((at = undefined), (on = undefined));

  /** The entry a row stands for, spelled the way the mutations expect it. */
  const itemIn = (row: HTMLElement): Item | undefined => {
    const path = row.dataset.itemPath;
    if (path === undefined) return undefined;
    const handle = tree.item(path);
    if (handle === null) return undefined;
    return {
      kind: handle.isDirectory() ? "directory" : "file",
      name: nameIn(path),
      path,
    };
  };

  const asked = (event: MouseEvent) => {
    dismiss();
    event.preventDefault();
    const row = rowUnder(event);
    const item = row === undefined ? undefined : itemIn(row);
    /**
     * Under the row, at its bottom edge -- not at the pointer, which is
     * somewhere in the middle of a row that may be 30px tall or 75. The row
     * is what the menu is about, so the row is what it hangs from.
     */
    at = {
      x: event.clientX,
      y:
        row !== undefined && item !== undefined
          ? row.getBoundingClientRect().bottom + BELOW
          : event.clientY,
    };
    on = item;
    /** Right-clicking a row focuses it, as it did while the tree drew this. */
    if (item !== undefined) tree.focus.at(item.path);
  };

  const context = $derived.by((): Context | undefined => {
    if (!at || !surface) return undefined;
    return {
      anchorElement: surface,
      anchorRect: pointAsRect(at.x, at.y),
      close: dismiss,
      restoreFocus: () => {},
    };
  });

  /** Whichever menu this click asked for: an entry's, or the workspace's. */
  const actionsOn = (
    item: Item | undefined,
    open: Context,
  ): ContextMenu.Action[] =>
    item === undefined ? rootActions(open) : entryActions(item, open);

  /**
   * Two of the four the tree's own menu offers -- the other two need an entry
   * to act on and this menu has none -- and the two that are ABOUT the
   * workspace as a whole, which is the one thing only this menu can name.
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
      { label: "Download", divided: true, run: handOver(() => keepACopy("")) },
      { label: "Upload", run: handOver(askForFiles) },
    ];
  };

  /**
   * The tree's four, plus a copy of this entry to keep.
   *
   * Slid in ahead of the destructive one rather than appended, so Delete
   * stays where a hand already expects it: at the bottom, behind a divider.
   */
  const entryActions = (item: Item, open: Context): ContextMenu.Action[] => {
    const standard = ContextMenu.actions({ model: tree, item, context: open });
    const destructive = standard.findIndex((action) => action.danger === true);
    const keeping: ContextMenu.Action = {
      label: "Download",
      run: () => {
        open.close({ restoreFocus: false });
        keepACopy(item.path);
      },
    };
    const before = destructive < 0 ? standard.length : destructive;
    return [...standard.slice(0, before), keeping, ...standard.slice(before)];
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

<!-- Two rows: the tree, which fills what is left so the empty space below the
     last entry is still the tree's -- which is the whole point of the menu
     above -- and the strip of the two things that are about all of it. -->
<div class="explorer">
  <div
    class="tree"
    data-region="tree"
    bind:this={surface}
    oncontextmenu={asked}
    role="presentation"
  >
    <!--
      THE ONE PANEL THAT IS SCALED RATHER THAN RESIZED, and it has to be.

      Everywhere else, `--wsfs-text-scale` moves font sizes and leaves the
      layout alone. The tree cannot be asked that: it is virtualised, so its
      row positions are computed in JavaScript from an item height fixed when
      the model was built, and a stylesheet that grows the type without
      growing the rows gets text in 30px slots -- clipped, and overlapping the
      moment anything scrolls. The height is not ours to move; there is no
      setter for it, and rebuilding the model to change it would throw away
      every expansion, selection and half-typed rename in the panel.

      `zoom` moves both together, because it scales the coordinate space the
      tree does its own arithmetic in -- rows, indents, icons and type at
      once, all still consistent with each other. It is applied HERE, to the
      tree alone, and not to the region around it: the menu is drawn on that
      region and places itself from viewport coordinates, which a zoom would
      multiply a second time.

      And no `contextMenu` snippet, which is what leaves the tree composed
      without a menu at all -- see the surface above.
    -->
    <Tree.Component
      model={tree}
      style="height: 100%; zoom: var(--wsfs-text-scale, 1); {theme}"
    />

    {#if context}
      <MenuLayer anchor={context.anchorRect}>
        <!--
          The tree's palette, on a menu that is not inside the tree: it reads
          `--trees-*` for its colours, and would otherwise wear the neutral
          fallbacks while everything around it wore the theme. Its SIZE comes
          from the panel -- see the stylesheet below.
        -->
        <div class="menu" style={theme}>
          <ContextMenu.Component {context} actions={actionsOn(on, context)} />
        </div>
      </MenuLayer>
    {/if}
  </div>

  <!-- Chrome: these two are about the workspace rather than part of what the
       panel shows, so they keep their size while the tree grows. -->
  <div
    class="flex shrink-0 gap-1 border-t p-1.5"
    data-region="tree-actions"
    data-text-scale="chrome"
  >
    <Button
      variant="ghost"
      size="sm"
      class="flex-1"
      title="Download the whole workspace"
      onclick={() => keepACopy("")}
    >
      <DownloadIcon />
      Download
    </Button>
    <Button
      variant="ghost"
      size="sm"
      class="flex-1"
      title="Add files from this machine"
      onclick={askForFiles}
    >
      <UploadIcon />
      Upload
    </Button>
  </div>
</div>

<!-- Outside the tree, because the tree is where a right click means the root
     and a click landing on this would be one. Nobody ever sees it: the
     buttons and the menu both reach it by asking it to open. -->
<input
  class="picker"
  type="file"
  multiple
  bind:this={picker}
  onchange={picked}
  tabindex="-1"
  aria-hidden="true"
/>

<style>
  .explorer {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    height: 100%;
    min-height: 0;
  }

  .tree {
    position: relative;
    height: 100%;
    min-height: 0;
  }

  /*
   * THE MENU READS AT THE SIZE THE PANEL IS SET TO.
   *
   * Everything else in a scaled panel grows because `app.css` restates
   * Tailwind's sizes against `--wsfs-text-scale`; the menu is drawn by the
   * tree's own component, which names its size in `--trees-*` and has never
   * heard of any of that. So it is told here, in the one declaration it does
   * read -- and told a MULTIPLE of the size it already was, so a panel nobody
   * has touched is unchanged. An explorer turned up for a lecture theatre
   * whose menu still whispers is half a feature.
   *
   * The size only. The padding and the corners are the same as every other
   * menu in the app, which is the trade the rest of this makes too: what is
   * read grows, what holds it stays where it was.
   *
   * It reaches the menu because `MenuLayer` leaves it in the DOM where it was
   * written -- the top layer moves where a thing PAINTS, not what it
   * inherits.
   */
  .menu {
    --trees-menu-font-size: calc(0.875rem * var(--wsfs-text-scale, 1));
  }

  /* Present rather than displayed: `display: none` makes an input one some
     browsers refuse to open a picker for. */
  .picker {
    position: fixed;
    width: 0;
    height: 0;
    opacity: 0;
    pointer-events: none;
  }
</style>
