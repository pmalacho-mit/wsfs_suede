<script lang="ts">
  import { ModeWatcher } from "mode-watcher";
  import { Toaster } from "./shadcn/ui/sonner";
</script>

<!-- The mode is settled before the first paint, so nothing flashes light on
     its way to dark. -->
<ModeWatcher />
<Toaster position="top-center" richColors closeButton />
