export default {
  name: 'greeter',
  apply(ctx) {
    ctx.logger('greeter').info('plugin loaded (v1)')
    ctx.effect(() => () => ctx.logger('greeter').info('plugin unloaded'))
  },
}
