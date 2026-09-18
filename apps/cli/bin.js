#!/usr/bin/env -S node --experimental-transform-types --conditions=development
/**
 * The `rigo` executable.
 *
 * Kept to one call on purpose: everything worth testing lives in `src/index.ts`
 * so it can be imported without a side effect, and the only thing this file
 * does that a test cannot is set the exit code.
 *
 * The shebang carries `--experimental-transform-types --conditions=development`
 * so the CLI runs the workspace's TypeScript sources directly — the same two
 * flags `bun run dev` uses. That also means workspace packages resolve through
 * their `development` export condition (source, not built `lib`), so an
 * in-repo `rigo` never runs against a stale build.
 */
import { run } from './src/index.ts'

process.exitCode = await run()
