/**
 * Node-only SQLite driver (SPEC §2.5, §8.3; Issue 007).
 *
 * Wraps Node 24's `node:sqlite` `DatabaseSync` with the Rigo storage
 * contract: WAL, Foreign Keys and Busy Timeout are enabled on open; writes
 * run through short `BEGIN IMMEDIATE` transactions; backups are consistent
 * snapshots via `VACUUM INTO` (the `node:sqlite` API does not expose the
 * SQLite backup API, and `VACUUM INTO` produces an identical consistent
 * copy). `node:sqlite` is Node-only — this face must not be imported from
 * Bun or browser runtimes; the runtime-agnostic definition lives in
 * `./definition.ts`.
 *
 * @module @teoclub/shared-storage-sqlite-node/node
 */

import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { runMigrations, type AppliedMigration, type StorageDriver, type StorageMigration } from './definition.ts'

export interface NodeSqliteOptions {
  /** Busy timeout in milliseconds (default 5000). */
  busyTimeoutMs?: number
}

/** The Node `node:sqlite` storage driver. */
export class NodeSqliteDriver implements StorageDriver {
  private readonly db: DatabaseSync
  readonly databasePath: string

  constructor(path: string, options: NodeSqliteOptions = {}) {
    this.databasePath = path === ':memory:' ? path : resolve(path)
    this.db = new DatabaseSync(this.databasePath)
    // SPEC §8.3: WAL, Foreign Keys, Busy Timeout. `journal_mode=WAL` on an
    // in-memory database is a no-op (SQLite reports 'memory' back).
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`)
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params as SQLInputValue[]) as T[]
  }

  run(sql: string, params: readonly unknown[] = []): { changes: number; lastInsertRowid: number | bigint | undefined } {
    const result = this.db.prepare(sql).run(...params as SQLInputValue[])
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  backup(targetPath: string): void {
    mkdirSync(dirname(targetPath), { recursive: true })
    // VACUUM INTO fails when the target already exists; a re-run backup
    // replaces the stale snapshot rather than failing the boot.
    if (existsSync(targetPath)) rmSync(targetPath)
    this.db.exec(`VACUUM INTO '${targetPath.replaceAll("'", "''")}'`)
  }

  close(): void {
    this.db.close()
  }
}

export interface OpenRigoStorageOptions extends NodeSqliteOptions {
  /** Migrations to apply before returning (SPEC §3.8: before the runtime starts). */
  migrations?: StorageMigration[]
  /** Backup policy for {@link runMigrations}. */
  backupBeforeSchemaChange?: boolean
  backupDir?: string
}

export interface OpenRigoStorageResult {
  driver: NodeSqliteDriver
  /** Migrations applied by this open. */
  applied: AppliedMigration[]
  /** Consistency backup created by this open, if any. */
  backupPath?: string
}

/**
 * Open Rigo storage: create the driver, enable WAL/FK/busy-timeout, run the
 * pending migrations, and hand back the ready handle. Rejects (and closes
 * nothing — the caller owns the driver) when migrations fail; the Agent
 * Runtime must not start in that case.
 * @param path - database path or `:memory:`.
 * @param options - driver + migration options.
 * @returns the ready driver and what this open applied.
 */
export function openRigoStorage(path: string, options: OpenRigoStorageOptions = {}): OpenRigoStorageResult {
  const driver = new NodeSqliteDriver(path, options)
  const outcome = runMigrations(driver, {
    migrations: options.migrations ?? [],
    ...(options.backupBeforeSchemaChange === undefined ? {} : { backupBeforeSchemaChange: options.backupBeforeSchemaChange }),
    ...(options.backupDir === undefined ? {} : { backupDir: options.backupDir }),
  })
  return { driver, applied: outcome.applied, ...(outcome.backupPath === undefined ? {} : { backupPath: outcome.backupPath }) }
}
