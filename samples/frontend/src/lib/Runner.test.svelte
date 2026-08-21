<script lang="ts">
  import Sweater from "sweater-vest-suede/Sweater.svelte";
  import Runner from "./Runner.svelte";
  import { WarmPool } from "./pool";
  import { Kernel } from "wsfs_suede.python-web-kernel-suede";
  import fs from "wsfs_suede.python-web-kernel-suede/fs";
</script>

<Sweater config>
  {@const Pocket = class {
    source = $state(`print("hello world"`);
    file = {
      path: "example.py",
    };
    readonly pool = new WarmPool<Kernel>({
      create: () =>
        new Kernel({
          fs: fs.empty("/home/pyodide"),
          input: async (prompt) => window.prompt(prompt) ?? "",
        }),
    });
  }}
  <Sweater body={async () => {}}>
    {#snippet vest(pocket: InstanceType<typeof Pocket>)}
      <Runner shared={pocket} kernelPool={pocket.pool} />
    {/snippet}
  </Sweater>
</Sweater>
