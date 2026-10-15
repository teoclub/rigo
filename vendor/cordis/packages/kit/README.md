# @teoclub/kit

[![npm](https://img.shields.io/npm/v/@teoclub/kit?style=flat-square)](https://www.npmjs.com/package/@teoclub/kit)

A collection of common utilities. Runtime-agnostic: no `node:*` imports, no
I/O, and no dependencies.

This package continues [cosmokit](https://www.npmjs.com/package/cosmokit)
under the TEO Club scope with identical public exports. It is maintained by
TEO Club and is not affiliated with cordiverse.

## Usage

### Node.js

```sh
npm install @teoclub/kit
```

```ts
import * as kit from '@teoclub/kit'
```

### Deno

```ts
import * as kit from 'npm:@teoclub/kit@latest'
```

## Config references

`Volatile<T>` exposes `get()` for immutable data snapshots. `createVolatile()` copies and freezes validated data; framework-owned `updateVolatile()` transfers a candidate snapshot into an existing reference. Framework-owned `volatileEntries()` enumerates references and their paths through plain config containers, stopping at snapshots and opaque objects. The shared symbol protocol recognizes references across ESM/CJS copies. Plugin consumers import the type from Cordis and retain the reference rather than caching values between operations.

`deepEqual()` treats two volatile references as equal regardless of their snapshots. Strict comparisons distinguish null from undefined recursively, compare URLs by normalized `href` and other opaque objects by identity, and treat distinct cyclic structures as unequal. Array comparison visits every index and treats holes as undefined. Snapshot-change detection must compare `.get()` results separately.
