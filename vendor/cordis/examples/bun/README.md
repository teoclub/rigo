# Bun-specific example

The same Cordis application running under Bun. Config changes hot-apply;
module changes trigger the safe-restart contract (see ../../docs/hmr.md).

```sh
cd examples/bun
bun install
bun main.ts
```
