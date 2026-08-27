import { Context } from '@teoclub/cordis'
import Timer from '@teoclub/cordis-plugin-timer'
import { pathToFileURL } from 'node:url'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'
await ctx.plugin(Timer)

// disposal-aware timers: cleared automatically when the fiber unloads
const fiber = ctx.plugin({
  name: 'ticker',
  inject: ['timer'],
  apply(c) {
    c.timer.setInterval(() => {
      c.logger('ticker').info('tick')
    }, 1000)
  },
})

await fiber.await()
console.log('ticker running under', typeof process.versions.bun === 'string' ? 'Bun' : 'Node')

// dispose to clear the interval and exit cleanly
await fiber.dispose()
await ctx.fiber.dispose()
