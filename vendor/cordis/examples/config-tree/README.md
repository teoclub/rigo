# Config-tree example

Boot a plugin tree from `cordis.yml` through the loader + include plugins.

```sh
cd examples/config-tree
bun install   # or npm install
bun main.ts
```

Then edit `cordis.yml` (e.g. change the message) and watch the entry reload
with its new config.
