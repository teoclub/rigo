module.exports = {
  name: 'legacy-cjs-plugin',
  apply(ctx) {
    ctx.logger('cjs').info('CJS plugin loaded')
    ctx.effect(() => () => ctx.logger('cjs').info('CJS plugin unloaded'))
  },
}
