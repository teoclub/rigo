export default {
  name: 'greeter',
  apply(ctx, config) {
    ctx.logger('greeter').info('loaded with %o', config.message)
    ctx.effect(() => () => ctx.logger('greeter').info('unloaded'))
  },
}
