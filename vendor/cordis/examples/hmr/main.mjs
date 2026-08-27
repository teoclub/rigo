import { Context } from '@teoclub/cordis'
import Timer from '@teoclub/cordis-plugin-timer'
import ConsoleLogger from '@teoclub/cordis-plugin-logger-console'
import Loader from '@teoclub/cordis-plugin-loader'
import Hmr from '@teoclub/cordis-plugin-hmr'
import { pathToFileURL } from 'node:url'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Timer)
await ctx.plugin(ConsoleLogger, { level: 3 })
await ctx.plugin(Loader, { baseUrl: ctx.baseUrl })
await ctx.loader.create({
  name: '@teoclub/cordis-plugin-include',
  config: { path: './cordis.yml' },
})
await ctx.plugin(Hmr, { root: ['.'], debounce: 100 })

// restart contract: exit 51 so an outer supervisor can respawn
ctx.loader.exit = () => process.exit(51)

setInterval(() => {}, 1 << 30)
