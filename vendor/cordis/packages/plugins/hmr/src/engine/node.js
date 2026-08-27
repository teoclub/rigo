/**
 * Node engine helpers (SPEC §5.4): module-graph partial reload support.
 * Node internals are reached through the loader's `ModuleLoader`
 * (see `@teoclub/cordis-plugin-loader/src/internal.ts`), which requires
 * Node >= 22 with `--expose-internals` or the `node-addon-require-builtin`
 * companion addon. Supported Node range: `^22.19.0 || >=24.0.0` (D6).
 */
/**
 * Recursively collect all module dependencies from a ModuleJob.
 * Skips node: builtins and node_modules to focus on user code.
 */
export async function loadDependencies(job, ignored = new Set()) {
    const dependencies = new Set();
    async function traverse(job) {
        if (ignored.has(job.url) || dependencies.has(job.url))
            return;
        if (job.url.startsWith('node:') || job.url.includes('/node_modules/'))
            return;
        dependencies.add(job.url);
        const children = await job.linked;
        await Promise.all(Array.prototype.map.call(children, traverse));
    }
    await traverse(job);
    return dependencies;
}
//# sourceMappingURL=node.js.map