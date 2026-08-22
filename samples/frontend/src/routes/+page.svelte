<script lang="ts">
  import { onDestroy } from "svelte";

  import Workspace from "$lib/Workspace.svelte";
  import WorkspaceFrame from "$lib/shell/WorkspaceFrame.svelte";
  import { solo } from "$lib/liveblocks";
  import {
    connect,
    http,
    keeping,
    persist,
    type Faltering,
    type Workspace as Client,
  } from "$wsfs";
  import { createClient } from "@liveblocks/client";
  import { toast } from "svelte-sonner";

  const USER = "ada@example.com";
  const BACKEND = "/wsfs";

  /** What this page is looking at. A real host reads it off the route. */
  const TITLE = "Workspace Example";
  const EVENT = "Example";
  const COURSE = "Example";

  /** The sample's stand-in for a session. A real host sends a cookie. */
  const asUser = (email: string) => async () => ({ "X-User-Email": email });

  /**
   * Collaboration is opt-in: with a key, files are shared with whoever else
   * has the workspace open; without one the editor still works and still
   * saves, it is simply the only one in the room.
   */
  const key = import.meta.env.VITE_LIVEBLOCKS_KEY as string | undefined;
  const liveblocks = key ? createClient({ publicApiKey: key }) : solo();

  let workspace = $state<Client | undefined>(undefined);
  let failure = $state<string | undefined>(undefined);

  /**
   * The two things about storage a user has to be told, and neither of them
   * is an error the app can recover from on their behalf.
   */
  let storage = $state<Faltering | undefined>(undefined);
  let unwatch: (() => void) | undefined;

  /**
   * Queued work whose bytes are gone. An event, not a state -- it happened
   * once, to particular changes -- so it is said the way this app says
   * things that happen, and it does not dismiss itself.
   */
  const cannotBeSent = (count: number) =>
    toast.error(
      count === 1 ? "A change could not be sent" : `${count} changes could not be sent`,
      {
        description:
          "They were queued here and can no longer be read back. Anything you typed and did not see arrive may need typing again.",
        duration: Number.POSITIVE_INFINITY,
      },
    );

  const project = async (email: string) => {
    const response = await fetch("/projects", {
      method: "POST",
      headers: { "X-User-Email": email },
    });
    if (!response.ok) throw new Error(`could not open a project: ${response.status}`);
    return ((await response.json()) as { id: string }).id;
  };

  const start = async () => {
    try {
      const id = await project(USER);
      /**
       * Read before anything is served. A client that started answering reads
       * and then found it had queued work would have shown a view missing its
       * own -- so the queue is restored first, and `connect` is handed it.
       */
      const held = await keeping(id);
      /**
       * Asked once, here, rather than inside `keeping` -- in some browsers it
       * prompts, and a library making a permission prompt appear as a side
       * effect of opening a queue would be deciding something that is not its
       * to decide. Not awaited for the workspace's sake: a browser that says
       * no is a browser that may clear unsent work, not a reason to refuse to
       * start.
       */
      void persist();
      unwatch = held.watch(() => (storage = held.faltering()));
      workspace = connect({
        workspace: id,
        transport: http(BACKEND, asUser(USER)),
        bytes: held.bytes,
        kept: held.kept,
        restored: held.restored,
        lost: (entries) => cannotBeSent(entries.length),
      });
    } catch (reason) {
      failure = reason instanceof Error ? reason.message : String(reason);
    }
  };

  void start();
  onDestroy(() => (unwatch?.(), workspace?.stop()));
</script>

<!-- The frame fills whatever it is given, so the page is what says "all of
     it" -- a test gives it a card-sized box instead. -->
<div class="h-dvh w-full">
  <WorkspaceFrame title={TITLE} event={EVENT} course={COURSE}>
    {#if failure}
      <p class="text-destructive p-4 text-sm">{failure}</p>
    {:else if workspace}
      <div class="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
        <!-- A banner rather than a toast, because it is not an event: for as
             long as it says this, everything typed here is going nowhere but
             this tab, and a notice that fades would stop saying so while it
             was still true. -->
        {#if storage}
          <p
            class="bg-destructive/10 text-destructive border-destructive/30 border-b px-3 py-2 text-sm"
            data-region="storage-trouble"
          >
            {storage.says}.{storage.full
              ? " Free some space \u2014 until then, anything typed here only lives in this tab."
              : " Anything typed here only lives in this tab until it is sent."}
          </p>
        {/if}
        <Workspace {workspace} {liveblocks} />
      </div>
    {:else}
      <p class="text-muted-foreground p-4 text-sm">Opening a workspace\u2026</p>
    {/if}
  </WorkspaceFrame>
</div>
