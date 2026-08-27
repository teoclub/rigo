import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MigrationError, type StorageMigration } from '@teoclub/shared-storage-sqlite-node/definition'

/**
 * Issue 007 Node driver (SPEC §2.5, §8.3): `node:sqlite` is Node-only, so
 * this suite is skipped under Bun — and because the import itself cannot
 * resolve there, every `node:sqlite`-dependent import is lazy (inside the
 * tests, which never run under Bun). Covers WAL/Foreign Keys/Busy Timeout
 * on open, fresh + consecutive + checksum-conflict migration runs against
 * real SQLite, failure rollback, and consistency backups.
 */

const isBun = typeof Bun !== 'undefined'

type NodeFace = typeof import('@teoclub/shared-storage-sqlite-node/node')

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rigo-storage-'))
  return { dir, path: join(dir, 'rigo.sqlite') }
}

const V1: StorageMigration = {
  version: 1,
  name: 'create-items',
  sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)',
}
const V2: StorageMigration = {
  version: 2,
  name: 'add-flag',
  sql: 'ALTER TABLE items ADD COLUMN flag INTEGER NOT NULL DEFAULT 0',
}
const V3: StorageMigration = {
  version: 3,
  name: 'add-index',
  sql: 'CREATE INDEX items_label ON items (label)',
}

describe.skipIf(isBun)('storage sqlite node driver (Issue 007)', () => {
  it('enables WAL, Foreign Keys and Busy Timeout on open', async () => {
    const { NodeSqliteDriver } = await import('@teoclub/shared-storage-sqlite-node/node') as NodeFace
    const { dir, path } = tempDb()
    try {
      const driver = new NodeSqliteDriver(path)
      expect(driver.query<{ journal_mode: string }>('PRAGMA journal_mode')).toEqual([{ journal_mode: 'wal' }])
      expect(driver.query<{ foreign_keys: number }>('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }])
      expect(driver.query<{ timeout: number }>('PRAGMA busy_timeout')).toEqual([{ timeout: 5000 }])
      driver.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('applies migrations on a fresh database and upgrades consecutive opens', async () => {
    const { openRigoStorage } = await import('@teoclub/shared-storage-sqlite-node/node') as NodeFace
    const { dir, path } = tempDb()
    try {
      const first = openRigoStorage(path, { migrations: [V1, V2] })
      expect(first.applied.map((row) => row.version)).toEqual([1, 2])
      expect(first.driver.query<{ label: string }>('SELECT label FROM items')).toEqual([])
      first.driver.run('INSERT INTO items (label) VALUES (?)', ['hello'])
      first.driver.close()

      const second = openRigoStorage(path, { migrations: [V1, V2, V3] })
      expect(second.applied.map((row) => row.version)).toEqual([3])
      expect(second.driver.query<{ label: string }>('SELECT label FROM items')).toEqual([{ label: 'hello' }])
      second.driver.close()

      const third = openRigoStorage(path, { migrations: [V1, V2, V3] })
      expect(third.applied).toEqual([])
      third.driver.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails the open when an applied migration changed (checksum conflict)', async () => {
    const { openRigoStorage } = await import('@teoclub/shared-storage-sqlite-node/node') as NodeFace
    const { dir, path } = tempDb()
    try {
      openRigoStorage(path, { migrations: [V1] }).driver.close()
      const tampered: StorageMigration = {
        version: 1,
        name: 'create-items',
        sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, hacked TEXT)',
      }
      expect(() => openRigoStorage(path, { migrations: [tampered, V2] }))
        .toThrowError(MigrationError)
      // The database is untouched: a fresh open with the correct migration works.
      const retry = openRigoStorage(path, { migrations: [V1, V2] })
      expect(retry.applied.map((row) => row.version)).toEqual([2])
      retry.driver.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rolls back a failing migration and leaves the last applied version intact', async () => {
    const { openRigoStorage } = await import('@teoclub/shared-storage-sqlite-node/node') as NodeFace
    const { dir, path } = tempDb()
    try {
      const bad: StorageMigration = {
        version: 2,
        name: 'add-flag',
        sql: 'ALTER TABLE items ADD COLUMN flag INTEGER NOT NULL DEFAULT 0; CREATE TABLE orphan (id INTEGER PRIMARY KEY); SELECT broken_syntax',
      }
      expect(() => openRigoStorage(path, { migrations: [V1, bad] })).toThrowError(MigrationError)
      // Reopen with the good migration set: only v2 is pending, no orphan table.
      const retry = openRigoStorage(path, { migrations: [V1, V2] })
      expect(retry.applied.map((row) => row.version)).toEqual([2])
      expect(() => retry.driver.query('SELECT * FROM orphan')).toThrow()
      retry.driver.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates a consistency backup before schema changes; the backup holds the pre-change state', async () => {
    const { openRigoStorage } = await import('@teoclub/shared-storage-sqlite-node/node') as NodeFace
    const { DatabaseSync } = await import('node:sqlite') as typeof import('node:sqlite')
    const { dir, path } = tempDb()
    try {
      const first = openRigoStorage(path, { migrations: [V1] })
      first.driver.close()
      const second = openRigoStorage(path, { migrations: [V1, V2, V3] })
      expect(second.backupPath).toBeTruthy()
      expect(existsSync(second.backupPath!)).toBe(true)
      second.driver.close()

      // The backup predates v2/v3: it contains only v1, no flag column.
      const backup = new DatabaseSync(second.backupPath!)
      const versions = backup.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
        .map((row) => row.version)
      expect(versions).toEqual([1])
      const columns = backup.prepare('PRAGMA table_info(items)').all()
        .map((row) => row.name)
      expect(columns).toEqual(['id', 'label'])
      backup.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('supports in-memory databases (WAL pragma degrades to a no-op)', async () => {
    const { NodeSqliteDriver } = await import('@teoclub/shared-storage-sqlite-node/node') as NodeFace
    const driver = new NodeSqliteDriver(':memory:')
    driver.exec('CREATE TABLE t (a TEXT)')
    driver.run('INSERT INTO t (a) VALUES (?)', ['x'])
    expect(driver.query<{ a: string }>('SELECT a FROM t')).toEqual([{ a: 'x' }])
    driver.close()
  })

  it('honors a custom busy timeout', async () => {
    const { NodeSqliteDriver } = await import('@teoclub/shared-storage-sqlite-node/node') as NodeFace
    const { dir, path } = tempDb()
    try {
      const driver = new NodeSqliteDriver(path, { busyTimeoutMs: 123 })
      expect(driver.query<{ timeout: number }>('PRAGMA busy_timeout')).toEqual([{ timeout: 123 }])
      driver.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
