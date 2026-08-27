export async function safeRestart(ctx, loader, options = {}) {
    const logger = ctx.logger('hmr');
    if (options.url) {
        logger.info('module change at %C requires a full restart', options.url);
    }
    else {
        logger.info('full restart requested');
    }
    // 1. stop accepting new Fiber work: close the HMR watcher first so no
    // further change events can schedule reloads during teardown
    try {
        await ctx.hmr?._closeWatchers();
    }
    catch (error) {
        logger.warn(error);
    }
    // 2. root Fiber unload - every disposer runs (in reverse order) and the
    // unload is awaited to completion before exiting
    try {
        await ctx.root.fiber.dispose();
    }
    catch (error) {
        logger.warn(error);
    }
    // 3. signal handling and exporter flush: give hosts a final asynchronous
    // barrier (log exporters are synchronous; async exporters observe `exit`)
    try {
        await ctx.parallel('exit', 'hmr');
    }
    catch {
        // listeners are being torn down; their failures must not block exit
    }
    // 4. host hook: the bin layer exits the process; an outer supervisor
    // respawns it (documented restart contract)
    try {
        ;
        (options.exit ?? loader.exit.bind(loader))();
    }
    catch (error) {
        logger.warn(error);
    }
}
//# sourceMappingURL=bun.js.map