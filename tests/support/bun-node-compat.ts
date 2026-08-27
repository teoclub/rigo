// Bun compatibility shims for Node APIs the ported harness core relies on
// (SPEC §9.2 dual-runtime requirement). Loaded as a bunfig [test] preload so
// every spec file runs unchanged; under vitest this file is never read.
//
// `process.loadEnvFile` (app-boot `loadEnv`): parses the .env format Node
// accepts - blank lines, `#` comments, optional `export ` prefix, surrounding
// quotes stripped - and merges into process.env without overriding values
// already present, matching Node's loadEnvFile precedence. A missing file
// throws an ENOENT error so app-boot's "ambient environment wins" path keeps
// working; an unreadable target (a directory named .env) throws a non-ENOENT
// error so the labelled warn line still fires.

type PatchableProcess = typeof process & { loadEnvFile?: (path: string) => void }

const proc = process as PatchableProcess

if (typeof proc.loadEnvFile !== 'function') {
  proc.loadEnvFile = (path: string): void => {
    let text: string
    try {
      text = require('node:fs').readFileSync(path, 'utf8')
    } catch (error) {
      throw error
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line.length === 0 || line.startsWith('#')) continue
      const stripped = line.startsWith('export ') ? line.slice('export '.length).trim() : line
      const eq = stripped.indexOf('=')
      if (eq <= 0) continue
      const key = stripped.slice(0, eq).trim()
      let value = stripped.slice(eq + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)
        || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
        value = value.slice(1, -1)
      }
      if (!(key in process.env)) process.env[key] = value
    }
  }
}
