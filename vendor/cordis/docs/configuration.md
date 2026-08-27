# Configuration

Cordis boots from a YAML or JSON file (`cordis.yml` by default) through the
loader and include plugins:

```sh
npx cordis              # loads ./cordis.yml from the current directory
```

## Entry tree

```yaml
# cordis.yml
- id: timer
  name: '@teoclub/cordis-plugin-timer'
- id: app
  name: ./plugins/app          # relative specifiers resolve against baseUrl
  config:
    message: hello
- id: grouped
  name: '@teoclub/cordis-plugin-group'
  config:
    entries:
      - id: nested
        name: ./plugins/nested
- id: off
  name: ./plugins/optional
  disabled: true
```

Each row becomes a loader entry and its own fiber with its own validated
config. Removing a row disposes its fiber; editing `config` reloads it
through the `internal/update` waterfall (vetoable).

## Patches

The include plugin applies runtime patches after reading the file.
Patches apply **in order**, and a later patch may
target a row inserted by an earlier one:

```ts
await ctx.plugin(Include, {
  path: './cordis.yml',
  patches: [
    { op: 'insert', value: { id: 'extra', name: './plugins/extra' } },
    { op: 'replace', id: 'app', path: 'config.message', value: 'patched' },
  ],
})
```

A patch whose `id` matches no entry is skipped with a `WARN` log (it does
not throw). Patch inputs are deep-copied to prevent pollution, and removing
a patch restores the original value from the immutable file content.

## Write-back

When entries change at runtime (create/update/remove), the include plugin
persists the tree back to the file atomically: write a temp file, `fsync`,
then `rename` over the original. On Windows, transient `EACCES`/`EBUSY`/
`EPERM` rename failures retry with bounded backoff (50/150/450 ms, up to 3
attempts); a terminal failure leaves the original file intact and throws
with stage information.

## `!!js` expressions

Entry fields may use the `!!js` YAML expression dialect (inherited from
upstream Cordis). Expressions evaluate **in the host process** when the
entry loads - treat every config file as trusted code (see the
[security notes](../packages/plugins/include/README.md#security--trust-model)).
Only the entry root's `config` and `disabled` are interpolated; child
plugin configs resolve in their own fibers.

## `CORDIS_SHARED`

`process.env.CORDIS_SHARED` seeds the loader's shared environment data
(`envData`, e.g. `startTime`) across process restarts. The value must be
valid JSON matching the declared schema; a parse failure is reported with
the raw value and the expected format. The variable is read only by the
loader package - it is not part of core.

## Programmatic use

```ts
import { Context } from '@teoclub/cordis'
import Loader from '@teoclub/cordis-plugin-loader'
import Include from '@teoclub/cordis-plugin-include'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'
await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@teoclub/cordis-plugin-include',
  config: { path: './cordis.yml' },
})
```
