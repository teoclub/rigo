import { Context } from '@teoclub/cordis'
import Loader from '@teoclub/cordis-plugin-loader'
import { pathToFileURL } from 'node:url'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'
await ctx.plugin(Loader, { baseUrl: ctx.baseUrl })
await ctx.loader.create({
  name: '@teoclub/cordis-plugin-include',
  config: { path: './cordis.yml' },
})
await new Promise((resolve) => setTimeout(resolve, 250))
await ctx.fiber.dispose()
