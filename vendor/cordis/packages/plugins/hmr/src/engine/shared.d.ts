/**
 * Runtime detection shared by the HMR engines.
 *
 * Detects Bun without importing any `bun:*` module so this file is safe to
 * load under Node (SPEC §2.2: no runtime-specific imports in shared code).
 */
export declare function isBun(): boolean;
//# sourceMappingURL=shared.d.ts.map