#!/usr/bin/env node

import { Context } from '@teoclub/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@teoclub/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@teoclub/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})

// Full-restart contract (HMR Bun engine, SPEC §5.4): when HMR decides a
// change cannot be applied in-process, it tears the plugin tree down and
// calls loader.exit(). Exit with a dedicated code so an outer supervisor
// (process manager, `--watch` wrapper) can distinguish a restart from a
// crash and respawn the process. Restart exit code: 51.
ctx.loader.exit = () => {
  process.exit(51)
}
