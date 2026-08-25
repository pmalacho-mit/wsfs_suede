<script lang="ts">
  /**
   * One open file. What it is decides what shows: text goes to the editor,
   * bytes to a preview, and a `.py` file gets a terminal underneath it.
   *
   * The kind comes from the content the workspace actually holds, not from the
   * name -- the name only decides whether the file is worth running.
   */
  import type { IDockviewPanelProps } from "dockview";

  import { Editor } from "../../../wsfs_suede.python-monaco-suede";
  import History from "./History.svelte";
  import HistoryIcon from "@lucide/svelte/icons/history";
  import Preview from "./Preview.svelte";
  import ProblemHeader from "./ProblemHeader.svelte";
  import { headerFor } from "./headers";
  import Runner, { type Outcome } from "./Runner.svelte";
  import type { Workspace } from "../";
  import type { KernelPool, OpenFile } from "./Workspace.svelte";
  import type { Payload } from "../content";
  import { onDestroy, onMount } from "svelte";

  type Params = {
    opened: OpenFile;
    workspace: Workspace;
    kernelPool: KernelPool;
    onFinished: (outcome: Outcome) => void;
    /** Every run as it starts, with the promise it will finish by. */
    onRun?: (started: {
      entry: string | undefined;
      at: string;
      result: Promise<Outcome>;
    }) => void;
  };

  let { params }: IDockviewPanelProps<Params> = $props();

  let binary = $state<Extract<Payload, { kind: "binary" }>>();

  /**
   * Whether this panel is still on screen.
   *
   * A read is a round trip and a panel can be closed during one -- a tab
   * shutting, a workspace being put away, a test ending. The read then fails
   * against a workspace nobody is holding any more, and answering it would
   * be answering to nothing.
   */
  let showing = true;
  onDestroy(() => (showing = false));

  const read = () => {
    params.workspace
      .read(params.opened.path)
      .then((content) => {
        if (!showing || !content) return;
        if (content.kind === "text") params.opened.share(content.text);
        else binary = content;
      })
      /**
       * Caught, because an uncaught one is a console error that says nothing
       * anybody can act on. Nothing is lost by failing here: content is
       * re-fetchable, the panel goes on showing what it has, and the view
       * says "Opening ..." for as long as it has nothing at all.
       */
      .catch(() => undefined);
  };

  /**
   * A file that was text can stop being text.
   *
   * It used to say "shared text can't become binary" here and stop watching,
   * which is the assumption a two-browser test disproved: somebody with the
   * file closed -- another client, a script, a kernel writing an image where
   * a `.py` used to be -- can write bytes over it, and the write lands. The
   * room finds out and records it as `replaced`; this is what turns that into
   * something the person looking at the editor can see.
   */
  $effect(() => {
    const { opened, workspace } = params;
    const { id } = opened;
    return workspace.watch((changes) => {
      if (
        !changes.some(({ kind, entry }) => entry === id && kind === "written")
      )
        return;
      // A shared file only re-reads once its room says it is no longer text.
      // Otherwise every keystroke anybody stores would pull the whole file
      // back over the document that already has it.
      if (opened.sharedText && opened.sharedText.shared?.replaced === undefined)
        return;
      read();
    });
  });

  onMount(read);

  let runnable = $derived(params.opened.path.endsWith(".py"));

  /**
   * The problem this file is an answer to, for the files somebody wrote one
   * down for. Derived from the path rather than read once, so a file that is
   * renamed stops -- or starts -- carrying a header along with the name.
   */
  let problem = $derived(headerFor(params.opened.path));

  /**
   * Offered on every open file, not only when something looks wrong.
   *
   * The moment a person needs this is the moment they believe work has gone,
   * and that is the worst moment to go looking for where it lives. A line
   * that is always there costs one row and is already known when it matters.
   */
  let showingHistory = $state(false);
</script>

{#if binary}
  {#if params.opened.sharedText?.shared?.replaced}
    <p
      class="bg-destructive/10 text-destructive border-destructive/30 border-b px-3 py-2 text-sm"
      data-region="replaced"
    >
      Somebody wrote {params.opened.sharedText.shared.replaced.mime} over this file.
      What you were editing is no longer what it holds.
    </p>
  {/if}
  <Preview path={params.opened.path} held={binary} />
{:else if params.opened.sharedText}
  <button
    type="button"
    class="text-muted-foreground hover:bg-muted/60 flex w-full shrink-0 items-center gap-2 border-b px-3 py-1.5 text-left text-xs"
    data-region="history-offer"
    onclick={() => (showingHistory = true)}
  >
    <HistoryIcon class="size-3.5 shrink-0" />
    <span class="truncate">
      Missing something, or want to see how this looked before?
      <span class="underline underline-offset-2">Open this file's history</span>
    </span>
  </button>
  <History
    workspace={params.workspace}
    entry={params.opened.id}
    path={params.opened.path}
    bind:open={showingHistory}
  />
  <div class="text relative" class:runnable class:headed={problem !== undefined}>
    {#if problem !== undefined}
      <ProblemHeader content={problem} />
    {/if}
    <!--
      OVER the editor rather than above it.
      A notice that takes a row pushes every line of code down the moment it
      appears and pulls them back up when it goes -- and these come and go on
      their own schedule, not the reader's. Floating it means the thing being
      read never moves, which is the only way a transient notice is bearable.
    -->
    {#if params.opened.sharedText.shared?.trouble}
      {@const trouble = params.opened.sharedText.shared.trouble}
      <p
        class="pointer-events-none absolute top-2 right-2 z-10 rounded-md border px-2 py-1 text-xs shadow-sm {trouble.passing
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
          : 'bg-destructive/10 text-destructive border-destructive/30'}"
        data-region="trouble"
      >
        {trouble.says} — what you type is kept, and goes when it can.
      </p>
    {/if}
    <!-- `props` is everything the editor was configured with and the file is
         the one thing that differs per panel. Spreading is what makes
         `onEditor` reach anybody -- it was being carried this far and dropped. -->
    <Editor.Component
      {...params.opened.sharedText.props}
      file={params.opened.sharedText.file}
    />
    {#if runnable}
      <Runner
        kernelPool={params.kernelPool}
        shared={params.opened.sharedText}
        onFinished={params.onFinished}
        onRun={params.onRun}
      />
    {/if}
  </div>
{:else}
  <p class="text-muted-foreground p-4 text-sm">Opening {params.opened.path}…</p>
{/if}

<!--
  Both notices are SAID rather than hidden. Typing into a document that is
  reaching nobody is safe -- it is kept, and it goes when the room comes back
  -- but a person who is not told assumes their work is where everybody
  else's is. Amber for that, and destructive for a file that stopped being
  the text on screen, because only one of the two has already cost something.
-->
<style>
  .text {
    display: grid;
    grid-template-rows: 1fr;
    /* A COLUMN THAT MAY BE NARROWER THAN WHAT IS IN IT.
       The implicit column a grid makes for itself is `auto`, and `auto` will
       not go below the widest thing inside -- so one long line of code in the
       problem statement set the width of this whole panel, and dragging the
       splitter left could not take it back. The panel got smaller; the row
       did not, and the code block's buttons went out past the edge with it.
       `minmax(0, 1fr)` is the same column with permission to shrink, which
       hands the overflow back to the things built to scroll it. */
    grid-template-columns: minmax(0, 1fr);
    height: 100%;
    min-height: 0;
  }
  .text.runnable {
    grid-template-rows: 1fr minmax(7rem, 30%);
  }
  /* The header takes what it needs -- itself capped -- and the editor takes
     the rest, which is why it is a row here rather than a block above the
     grid: an editor sized to 100% of a box it no longer fills alone overflows
     the panel, and the terminal underneath goes off the bottom of it. */
  .text.headed {
    grid-template-rows: auto minmax(0, 1fr);
  }
  .text.headed.runnable {
    grid-template-rows: auto minmax(0, 1fr) minmax(7rem, 30%);
  }
</style>
