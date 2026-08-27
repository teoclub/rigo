import { Context } from '@teoclub/cordis'
import Loader from '@teoclub/cordis-plugin-loader'
import ConsoleLogger from '@teoclub/cordis-plugin-logger-console'
import { pathToFileURL } from 'node:url'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(ConsoleLogger, { level: 3 })
await ctx.plugin(Loader, { baseUrl: ctx.baseUrl })
await ctx.loader.create({
  name: '@teoclub/cordis-plugin-include',
  config: { path: './cordis.yml' },
})

// keep the process alive; ctrl-c to exit
setInterval(() => {}, 1 << 30)
