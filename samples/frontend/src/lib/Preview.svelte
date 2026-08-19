<script lang="ts">
  import type { Held } from "$wsfs";

  let { path, held }: { path: string; held: Held } = $props();

  const binary = $derived(held.kind === "binary" ? held : undefined);

  /**
   * Revoked when the panel goes away, because an object URL outlives the
   * component that made it and holds its bytes alive with it.
   */
  const source = $derived.by(() => {
    if (!binary) return undefined;
    const copied = new Uint8Array(binary.bytes);
    const url = URL.createObjectURL(new Blob([copied], { type: binary.mime }));
    return url;
  });

  $effect(() => () => {
    if (source) URL.revokeObjectURL(source);
  });

  const shows = $derived(binary?.mime.startsWith("image/") ?? false);
</script>

<div class="preview">
  {#if !binary}
    <p class="note">Nothing to preview.</p>
  {:else if shows && source}
    <img src={source} alt={path} />
  {:else}
    <p class="note">
      {binary.mime} · {binary.bytes.byteLength} bytes
      {#if source}<a href={source} download={path}>Download</a>{/if}
    </p>
  {/if}
</div>

<style>
  .preview {
    display: grid;
    place-items: center;
    height: 100%;
    padding: 1rem;
    overflow: auto;
  }
  img {
    max-width: 100%;
    max-height: 100%;
    image-rendering: auto;
  }
  .note {
    font: 0.85rem/1.6 ui-sans-serif, system-ui, sans-serif;
    color: var(--wsfs-muted, #6b7280);
  }
</style>
