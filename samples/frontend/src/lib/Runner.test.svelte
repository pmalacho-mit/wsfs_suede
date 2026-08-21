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
          fs: fs.readWrite({
            root: "/home/pyodide",
            get: (path) => {
              console.log({ get: path });
            },
            listDirectory: (path) => {
              console.log({ listDirectory: path });
            },
            put: (path) => {
              console.log({ put: path });
            },
          }),
          input: async (prompt) => window.prompt(prompt) ?? "",
        }),
    });
  }}
  <Sweater
    body={async ({ set }) => {
      set(new Pocket());
    }}
  >
    {#snippet vest(pocket: InstanceType<typeof Pocket>)}
      <Runner shared={pocket} kernelPool={pocket.pool} />
    {/snippet}
  </Sweater>
</Sweater>
