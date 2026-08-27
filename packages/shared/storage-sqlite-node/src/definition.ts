/**
 * Rigo storage service definition — runtime-agnostic (SPEC §2.5: the SQLite
 * Provider is Node-only; its Service Definition stays runtime-independent;
 * Issue 007; SPEC §3.8, §8.3).
 *
 * This face imports nothing Node-specific: `StorageDriver` abstracts the
 * database, and `runMigrations` is the sequential migration framework:
 *
 *   - `schema_migrations(version, applied_at, checksum)` records every
 *     applied migration with a content checksum;
 *   - migrations run strictly before the Agent Runtime starts (the caller
 *     opens storage first and only boots on success — SPEC §3.8);
 *   - an applied migration whose content changed is a hard failure;
 *   - every pending migration applies atomically in its own short
 *     transaction (rollback leaves the database at the last applied
 *     version — SPEC §8.3 short-write rule);
 *   - before the first schema change of a run, a consistency backup is
 *     created (SPEC §3.8; MVP has no downgrade migrations — rollback means
 *     closing the new version and restoring the backup).
 *
 * @module @teoclub/shared-storage-sqlite-node/definition
 */

import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/** One sequential SQL migration. */
export interface StorageMigration {
  /** Sequential, 1-based version (must be exactly `lastApplied + 1`). */
  version: number
  /** Stable human-readable name (diagnostics). */
  name: string
  /** The migration script (may contain multiple statements). */
  sql: string
}

/** One recorded application in `schema_migrations`. */
export interface AppliedMigration {
  version: number
  appliedAt: string
  /** sha256 hex of the exact migration `sql` text. */
  checksum: string
}

/** A runtime-agnostic database handle the migration engine drives. */
export interface StorageDriver {
  /** Absolute database path, or `:memory:`. */
  readonly databasePath: string
  /** Execute one or more statements. */
  exec(sql: string): void
  /** Run a query returning rows as plain records. */
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[]
  /** Run a write statement. */
  run(sql: string, params?: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint | undefined }
  /** Run `fn` inside one transaction (short-lived; never awaits outside work). */
  transaction<T>(fn: () => T): T
  /** Create a consistent snapshot of the current database at `targetPath`. */
  backup(targetPath: string): void
  /** Release the handle. */
  close(): void
}

/** Compute the content checksum of a migration (exact text — any edit fails). */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

export const SCHEMA_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
)`

export interface MigrationOptions {
  /** Pending migrations, ordered by version (each must be exactly one above the previous). */
  migrations: StorageMigration[]
  /** Create a consistency backup before the first schema change of this run (default true). */
  backupBeforeSchemaChange?: boolean
  /** Directory for backups (default: `<dirname(databasePath)>/backups`; ignored for `:memory:`). */
  backupDir?: string
}

export interface MigrationOutcome {
  /** Migrations applied by THIS run (empty on a no-op run). */
  applied: AppliedMigration[]
  /** Consistency backup created before this run's schema changes, if any. */
  backupPath?: string
}

export class MigrationError extends Error {
  constructor(
    message: string,
    public readonly code: 'CHECKSUM_MISMATCH' | 'MISSING_APPLIED_MIGRATION' | 'SEQUENCE_GAP' | 'DUPLICATE_VERSION' | 'APPLY_FAILED',
  ) {
    super(message)
    this.name = 'MigrationError'
  }
}

/**
 * Apply pending migrations in order. Safe to run repeatedly: already-applied
 * migrations are verified (checksum) and skipped, so a no-op run changes
 * nothing. Throws on any violation — callers must not start the Agent
 * Runtime when this rejects.
 * @param driver - the storage handle.
 * @param options - the migration set and backup policy.
 * @returns what this run applied and the backup it created, if any.
 */
export function runMigrations(driver: StorageDriver, options: MigrationOptions): MigrationOutcome {
  const { migrations, backupBeforeSchemaChange = true, backupDir } = options
  const byVersion = new Map<number, StorageMigration>()
  for (const migration of migrations) {
    if (byVersion.has(migration.version)) {
      throw new MigrationError(`migration version ${migration.version} is declared more than once`, 'DUPLICATE_VERSION')
    }
    byVersion.set(migration.version, migration)
  }

  driver.exec(SCHEMA_MIGRATIONS_TABLE_SQL)
  const appliedRows = driver.query<{ version: number; applied_at: string; checksum: string }>(
    'SELECT version, applied_at, checksum FROM schema_migrations ORDER BY version',
  )
  const applied = appliedRows.map((row) => ({ version: row.version, appliedAt: row.applied_at, checksum: row.checksum }))

  // Every applied migration must still exist and be byte-identical.
  for (const row of applied) {
    const declared = byVersion.get(row.version)
    if (!declared) {
      throw new MigrationError(
        `applied migration ${row.version} is missing from the migration set (its content can no longer be verified)`,
        'MISSING_APPLIED_MIGRATION',
      )
    }
    if (migrationChecksum(declared.sql) !== row.checksum) {
      throw new MigrationError(
        `applied migration ${row.version} ("${declared.name}") changed since it was applied (checksum mismatch); restore the original or recover from the backup`,
        'CHECKSUM_MISMATCH',
      )
    }
  }

  // Pending = the sequential tail above the last applied version.
  const lastApplied = applied.length > 0 ? applied[applied.length - 1]!.version : 0
  const pending: StorageMigration[] = []
  for (let version = lastApplied + 1; ; version += 1) {
    const migration = byVersion.get(version)
    if (!migration) break
    pending.push(migration)
  }
  const nextExpected = lastApplied + pending.length + 1
  for (const version of byVersion.keys()) {
    if (version > nextExpected) {
      throw new MigrationError(
        `migration versions are not sequential: version ${version} is declared but ${nextExpected} is missing`,
        'SEQUENCE_GAP',
      )
    }
  }

  if (pending.length === 0) {
    return { applied: [] }
  }

  // Consistency backup before the first schema change (SPEC §3.8).
  let backupPath: string | undefined
  if (backupBeforeSchemaChange && driver.databasePath !== ':memory:') {
    const dir = backupDir ?? join(dirname(driver.databasePath), 'backups')
    const base = basename(driver.databasePath).replace(/\.sqlite(?:-wal|-shm)?$/i, '') || 'storage'
    backupPath = join(dir, `${base}.v${pending[0]!.version}.sqlite`)
    driver.backup(backupPath)
  }

  // Apply each migration atomically in its own short transaction.
  const outcome: AppliedMigration[] = []
  const now = new Date().toISOString()
  for (const migration of pending) {
    const checksum = migrationChecksum(migration.sql)
    try {
      driver.transaction(() => {
        driver.exec(migration.sql)
        driver.run('INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)', [
          migration.version, now, checksum,
        ])
      })
    } catch (error) {
      throw new MigrationError(
        `migration ${migration.version} ("${migration.name}") failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
        'APPLY_FAILED',
      )
    }
    outcome.push({ version: migration.version, appliedAt: now, checksum })
  }
  return { applied: outcome, ...(backupPath === undefined ? {} : { backupPath }) }
}
