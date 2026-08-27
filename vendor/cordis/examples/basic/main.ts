import { Context } from '@teoclub/cordis'

const ctx = new Context()

const fiber = ctx.plugin({
  name: 'greeter',
  apply(c) {
    c.on('greet', (name: string) => {
      console.log(`hello, ${name}!`)
    })
    c.effect(() => () => console.log('greeter unloaded'))
  },
})

await fiber.await()
ctx.emit('greet', 'world')
await fiber.dispose()
