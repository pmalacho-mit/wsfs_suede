<script lang="ts">
  /** The strip that names a panel. Shared, so the two panels agree. */
  import type { Icon } from "@lucide/svelte";

  let { label, icon: Glyph }: { label: string; icon: typeof Icon } = $props();
</script>

<div class="flex h-9 shrink-0 items-center gap-2 border-b px-3">
  <Glyph class="text-muted-foreground size-3.5" />
  <h2 class="text-muted-foreground text-[0.68rem] font-semibold tracking-[0.08em] uppercase">
    {label}
  </h2>
</div>
