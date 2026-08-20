<script lang="ts">
  import { onDestroy } from "svelte";

  import Shell from "$lib/Workspace.svelte";
  import { Open, project } from "$lib/workspace.svelte";

  const USER = "ada@example.com";

  let open = $state<Open | undefined>(undefined);
  let failure = $state<string | undefined>(undefined);

  const start = async () => {
    try {
      open = new Open(await project(USER), USER);
    } catch (reason) {
      failure = reason instanceof Error ? reason.message : String(reason);
    }
  };

  void start();
  onDestroy(() => open?.dispose());
</script>

<!-- The shell fills whatever it is given, so the page is what says "all of
     it" -- a test gives it a card-sized box instead. -->
<div class="page">
  {#if failure}
    <p class="failure">{failure}</p>
  {:else if open}
    <Shell workspace={open} />
  {:else}
    <p class="waiting">Opening a workspace…</p>
  {/if}
</div>

<style>
  .page {
    height: 100dvh;
    width: 100%;
  }
  :global(body) {
    margin: 0;
  }
  .failure,
  .waiting {
    font: 0.9rem/1.5 ui-sans-serif, system-ui, sans-serif;
    padding: 1rem;
    color: var(--wsfs-muted, #6b7280);
  }
  .failure {
    color: #b91c1c;
  }
</style>
