/**
 * Rigo SQLite storage provider and migration framework (Issue 007).
 *
 * Two faces:
 *   - the runtime-agnostic definition (`./definition.ts`): the
 *     `StorageDriver` contract, `StorageMigration`/`AppliedMigration` types,
 *     checksum computation and the sequential `runMigrations` engine —
 *     importable anywhere;
 *   - the Node-only driver (`./node.ts`): `node:sqlite` `DatabaseSync`
 *     wrapper with WAL / Foreign Keys / Busy Timeout, short transactions,
 *     `VACUUM INTO` consistency backups, and `openRigoStorage()`.
 *
 * @module @teoclub/shared-storage-sqlite-node
 */

export {
  MigrationError,
  migrationChecksum,
  runMigrations,
  SCHEMA_MIGRATIONS_TABLE_SQL,
  type AppliedMigration,
  type MigrationOptions,
  type MigrationOutcome,
  type StorageDriver,
  type StorageMigration,
} from './definition.ts'

export {
  NodeSqliteDriver,
  openRigoStorage,
  type NodeSqliteOptions,
  type OpenRigoStorageOptions,
  type OpenRigoStorageResult,
} from './node.ts'
