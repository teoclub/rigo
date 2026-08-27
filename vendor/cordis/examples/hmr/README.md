# HMR example

Hot reload under both runtimes.

## Node (module-graph partial reload)

```sh
cd examples/hmr
bun install
node --expose-internals main.mjs
# edit plugin.mjs and save: only that plugin reloads in-process
```

## Bun (config refresh + safe restart)

```sh
bun main.mjs
# editing cordis.yml refreshes the entry in-process;
# editing plugin.mjs triggers a safe full restart (exit code 51):
while true; do bun main.mjs; [ $? -ne 51 ] && break; done
```
