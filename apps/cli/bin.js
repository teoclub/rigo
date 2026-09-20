#!/usr/bin/env -S node --experimental-transform-types
/**
 * The `rigo` executable.
 *
 * Kept to one call on purpose: everything worth testing lives in `src/index.ts`
 * so it can be imported without a side effect, and the only thing this file
 * does that a test cannot is set the exit code.
 *
 * The shebang carries `--experimental-transform-types` for THIS file's own
 * import of `./src/index.ts`, and deliberately NOT `--conditions=development`:
 * the default condition resolves workspace packages to their built `lib/`, so
 * `rigo` runs the same artifacts a release ships. Running the sources instead
 * would need a loader that understands decorators (`@teoclub/harness-llm`
 * carries `@Remote`) — Node's transform does not — which is why `bun run dev`
 * goes through tsx for that mode.
 */
import { run } from './src/index.ts'

process.exitCode = await run()
