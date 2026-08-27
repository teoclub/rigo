# @teoclub/cordis-plugin-include

File-backed loader tree for Cordis. The include plugin reads a YAML or JSON
file, turns it into loader entries, and writes updates back when the file is
writable.

## Usage

```ts
import { Context } from '@teoclub/cordis'
import Loader from '@teoclub/cordis-plugin-loader'
import Include from '@teoclub/cordis-plugin-include'

const root = new Context()
await root.plugin(Loader, { baseUrl: import.meta.url })
await root.plugin(Include, {
  path: './cordis.yml',
  initial: [],
  enableLogs: true,
})
```

Example `cordis.yml`:

```yaml
- id: timer
  name: '@teoclub/cordis-plugin-timer'
- id: app
  name: ./plugins/app
  config:
    message: hello
```

## Config

| Field | Description |
| --- | --- |
| `path` | YAML or JSON file path resolved from `ctx.baseUrl`. |
| `initial` | Entry list written when the file is missing. |
| `patches` | Runtime patches applied after reading the file. |
| `enableLogs` | Enables loader apply, reload, and unload logs. |

Patches can insert entries or override fields on entries with a matching `id`.

## Security / Trust Model

Entry-list files may use a `!!js` YAML expression dialect (carried over
from upstream Cordis) in entry fields such as `config` or `disabled`.
Expressions are evaluated as JavaScript **in the host process** when the
entry is loaded. Treat every file read by this plugin (and every patch
source) as trusted code - never point `path` at untrusted input. There is
no sandbox and no opt-out flag in this release; the trust boundary is the
file system.
