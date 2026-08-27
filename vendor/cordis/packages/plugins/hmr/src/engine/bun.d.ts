import type { Context } from '@teoclub/cordis';
import type { Loader } from '@teoclub/cordis-plugin-loader';
/**
 * Bun engine (SPEC §5.4, D10): configuration refresh + controlled full
 * process restart. Bun has no equivalent of Node's `--expose-internals`
 * ESM loader, so module-graph partial reload is not available; a module
 * change that would reload plugin code triggers a safe full restart:
 *
 *   1. stop accepting new Fiber work (close the HMR watcher)
 *   2. root Fiber unload - every disposer runs and is awaited
 *   3. signal handling / exporter flush via the `exit` event
 *   4. `loader.exit()` - the host (bin layer) exits the process so an outer
 *      supervisor can respawn it. Bare `bun --hot` is NOT used (FR-HMR-004).
 */
export interface SafeRestartOptions {
    /** Changed module URL that forced the restart, for diagnostics. */
    url?: string;
    /** Host exit hook; defaults to the loader's `exit()` (no-op unless the host overrides it). */
    exit?: () => void;
}
export declare function safeRestart(ctx: Context, loader: Loader, options?: SafeRestartOptions): Promise<void>;
//# sourceMappingURL=bun.d.ts.map