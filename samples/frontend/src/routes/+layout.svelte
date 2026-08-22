<script lang="ts">
  import "../app.css";
  import { ModeWatcher } from "mode-watcher";
  import { Toaster } from "$lib/components/ui/sonner";

  let { children } = $props();
</script>

<!-- The mode is settled before the first paint, so nothing flashes light on
     its way to dark. -->
<ModeWatcher />
<Toaster position="top-center" richColors closeButton />

{@render children()}
