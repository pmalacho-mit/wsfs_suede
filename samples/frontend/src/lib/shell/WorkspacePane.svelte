<script lang="ts">
  /**
   * The workspace, and anything that has to be said above it.
   *
   * A component rather than markup in the route, because the arrangement is
   * the part that broke: the notice is OPTIONAL, and a two-track grid with
   * one child puts that child in the `auto` track, which is zero high. The
   * whole workspace vanished below a header that looked perfectly fine.
   *
   * A column that grows says what is meant and does not depend on how many
   * children happen to be there. Being a component is what lets a test render
   * it both ways and measure.
   */
  import type { Faltering, Workspace as Client } from "$wsfs";
  import Workspace from "$lib/Workspace.svelte";
  import type { createClient } from "@liveblocks/client";

  let {
    workspace,
    liveblocks,
    storage,
  }: {
    workspace: Client;
    liveblocks: ReturnType<typeof createClient>;
    /** What is wrong with writing the queue down, if anything. */
    storage?: Faltering;
  } = $props();
</script>

<div class="flex h-full min-h-0 flex-col" data-region="workspace-pane">
  <!--
    A banner rather than a toast, because it is not an event: for as long as
    it says this, everything typed here is going nowhere but this tab, and a
    notice that fades would stop saying so while it was still true.
  -->
  {#if storage}
    <p
      class="bg-destructive/10 text-destructive border-destructive/30 shrink-0 border-b px-3 py-2 text-sm"
      data-region="storage-trouble"
    >
      {storage.says}.{storage.full
        ? " Free some space — until then, anything typed here only lives in this tab."
        : " Anything typed here only lives in this tab until it is sent."}
    </p>
  {/if}
  <div class="min-h-0 flex-1" data-region="workspace-body">
    <Workspace {workspace} {liveblocks} />
  </div>
</div>
