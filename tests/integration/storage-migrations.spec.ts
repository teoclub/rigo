import { describe, expect, it } from 'vitest'
import {
  MigrationError,
  migrationChecksum,
  runMigrations,
  SCHEMA_MIGRATIONS_TABLE_SQL,
  type AppliedMigration,
  type StorageDriver,
  type StorageMigration,
} from '@teoclub/shared-storage-sqlite-node/definition'

/**
 * Issue 007 migration framework (SPEC §3.8, §8.3): sequential SQL
 * migrations, checksummed `schema_migrations`, per-migration atomic apply,
 * consistency backup before schema changes, and hard failure on changed or
 * missing applied migrations. These engine tests run on a fake driver, so
 * they are runtime-agnostic (dual Node/Bun); the real `node:sqlite` driver
 * is exercised in storage-sqlite-node.spec.ts.
 */

/** In-memory fake driver: records calls and simulates schema_migrations. */
class FakeDriver implements StorageDriver {
  databasePath = '/fake/db.sqlite'
  execs: string[] = []
  runs: { sql: string; params: unknown[] }[] = []
  backups: string[] = []
  applied: AppliedMigration[] = []
  /** When set, exec() of SQL containing this marker throws. */
  failOn: string | undefined
  transactions = 0

  exec(sql: string): void {
    this.execs.push(sql)
    if (this.failOn !== undefined && sql.includes(this.failOn)) {
      throw new Error(`fake driver failure on ${this.failOn}`)
    }
  }

  query<T extends Record<string, unknown>>(sql: string): T[] {
    if (sql.includes('schema_migrations')) {
      return this.applied.map((row) => ({ version: row.version, applied_at: row.appliedAt, checksum: row.checksum })) as T[]
    }
    return []
  }

  run(sql: string, params: readonly unknown[]): { changes: number } {
    this.runs.push({ sql, params: [...params] })
    if (sql.includes('INSERT INTO schema_migrations')) {
      this.applied.push({
        version: params[0] as number,
        appliedAt: params[1] as string,
        checksum: params[2] as string,
      })
    }
    return { changes: 1 }
  }

  transaction<T>(fn: () => T): T {
    this.transactions += 1
    const before = this.applied.length
    try {
      return fn()
    } catch (error) {
      // Rollback: nothing the failed migration recorded may survive.
      this.applied.length = before
      throw error
    }
  }

  backup(targetPath: string): void {
    this.backups.push(targetPath)
  }

  close(): void {}
}

function migration(version: number, name: string, sql: string): StorageMigration {
  return { version, name, sql }
}

const V1 = migration(1, 'create-items', 'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)')
const V2 = migration(2, 'add-flag', 'ALTER TABLE items ADD COLUMN flag INTEGER NOT NULL DEFAULT 0')
const V3 = migration(3, 'add-index', 'CREATE INDEX items_label ON items (label)')
const V4 = migration(4, 'add-more', 'CREATE TABLE more (id INTEGER PRIMARY KEY)')

describe('storage migration engine (Issue 007)', () => {
  it('applies a fresh database sequentially and records version, applied_at and checksum', () => {
    const driver = new FakeDriver()
    const outcome = runMigrations(driver, { migrations: [V1, V2] })
    expect(outcome.applied.map((row) => row.version)).toEqual([1, 2])
    // schema_migrations is bootstrapped first.
    expect(driver.execs[0]).toContain('CREATE TABLE IF NOT EXISTS schema_migrations')
    expect(outcome.applied[0]!.checksum).toBe(migrationChecksum(V1.sql))
    expect(outcome.applied[0]!.appliedAt).toBeTruthy()
    // One short transaction per migration (SPEC §8.3).
    expect(driver.transactions).toBe(2)
  })

  it('creates a consistency backup before the first schema change of a run', () => {
    const driver = new FakeDriver()
    const outcome = runMigrations(driver, { migrations: [V1, V2] })
    expect(driver.backups).toEqual(['/fake/backups/db.v1.sqlite'])
    expect(outcome.backupPath).toBe('/fake/backups/db.v1.sqlite')
    // A no-op run creates no backup.
    const next = runMigrations(driver, { migrations: [V1, V2] })
    expect(next.applied).toEqual([])
    expect(next.backupPath).toBeUndefined()
    expect(driver.backups).toHaveLength(1)
  })

  it('upgrades consecutive opens by applying only the pending tail', () => {
    const driver = new FakeDriver()
    runMigrations(driver, { migrations: [V1, V2] })
    const upgrade = runMigrations(driver, { migrations: [V1, V2, V3, V4] })
    expect(upgrade.applied.map((row) => row.version)).toEqual([3, 4])
    expect(driver.backups.at(-1)).toBe('/fake/backups/db.v3.sqlite')
    expect(driver.transactions).toBe(4)
  })

  it('rejects an applied migration whose content changed (checksum conflict)', () => {
    const driver = new FakeDriver()
    runMigrations(driver, { migrations: [V1] })
    const tampered = migration(1, 'create-items', 'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT, hacked TEXT)')
    expect(() => runMigrations(driver, { migrations: [tampered, V2] }))
      .toThrowError(MigrationError)
    try {
      runMigrations(driver, { migrations: [tampered, V2] })
    } catch (error) {
      expect((error as MigrationError).code).toBe('CHECKSUM_MISMATCH')
      expect((error as MigrationError).message).toContain('changed since it was applied')
    }
    // Nothing new was applied.
    expect(driver.applied.map((row) => row.version)).toEqual([1])
  })

  it('rejects an applied migration missing from the migration set', () => {
    const driver = new FakeDriver()
    runMigrations(driver, { migrations: [V1, V2] })
    expect(() => runMigrations(driver, { migrations: [V1] })).toThrowError(MigrationError)
    try {
      runMigrations(driver, { migrations: [V1] })
    } catch (error) {
      expect((error as MigrationError).code).toBe('MISSING_APPLIED_MIGRATION')
    }
  })

  it('rejects duplicate versions and non-sequential gaps', () => {
    expect(() => runMigrations(new FakeDriver(), { migrations: [V1, migration(1, 'dup', 'SELECT 1')] }))
      .toThrowError(/more than once/)
    expect(() => runMigrations(new FakeDriver(), { migrations: [V1, V3] })).toThrowError(/not sequential/)
  })

  it('rolls back a failing migration and keeps the last applied version', () => {
    const driver = new FakeDriver()
    const bad = migration(2, 'add-flag', 'ALTER TABLE items ADD COLUMN flag INTEGER NOT NULL DEFAULT 0; SELECT broken_syntax')
    driver.failOn = 'broken_syntax'
    try {
      runMigrations(driver, { migrations: [V1, bad, V3] })
      throw new Error('expected APPLY_FAILED')
    } catch (error) {
      expect((error as MigrationError).code).toBe('APPLY_FAILED')
      expect((error as MigrationError).message).toContain('rolled back')
    }
    // v1 committed; v2's record was rolled back; v3 never started.
    expect(driver.applied.map((row) => row.version)).toEqual([1])
    // The engine created the backup BEFORE touching v2.
    expect(driver.backups).toEqual(['/fake/backups/db.v1.sqlite'])
  })

  it('exposes the schema_migrations DDL for the driver to bootstrap', () => {
    expect(SCHEMA_MIGRATIONS_TABLE_SQL).toContain('version INTEGER PRIMARY KEY')
    expect(SCHEMA_MIGRATIONS_TABLE_SQL).toContain('applied_at TEXT NOT NULL')
    expect(SCHEMA_MIGRATIONS_TABLE_SQL).toContain('checksum TEXT NOT NULL')
  })
})
