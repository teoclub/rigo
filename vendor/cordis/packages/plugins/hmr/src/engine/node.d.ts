import type { ModuleJob } from '@teoclub/cordis-plugin-loader';
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
export declare function loadDependencies(job: ModuleJob, ignored?: Set<string>): Promise<Set<string>>;
export type { ModuleJob };
//# sourceMappingURL=node.d.ts.map