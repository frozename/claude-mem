import { Database } from 'bun:sqlite';
import { spawnSync } from 'child_process';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { MigrationRunner } from './migrations/runner.js';

// SQLite configuration constants
const SQLITE_MMAP_SIZE_BYTES = 256 * 1024 * 1024; // 256MB
const SQLITE_CACHE_SIZE_PAGES = 10_000;
const MAX_SCHEMA_REPAIR_ATTEMPTS = 5;

export interface Migration {
  version: number;
  up: (db: Database) => void;
  down?: (db: Database) => void;
}

let dbInstance: Database | null = null;

/**
 * Repair malformed database schema before migrations run.
 *
 * This handles the case where a database is synced between machines running
 * different claude-mem versions. A newer version may have added columns and
 * indexes that an older version (or even the same version on a fresh install)
 * cannot process. SQLite throws "malformed database schema" when it encounters
 * an index referencing a non-existent column, which prevents ALL queries —
 * including the migrations that would fix the schema.
 *
 * The fix: use the sqlite3 CLI tool (which supports writable_schema reliably
 * across versions) to drop the orphaned schema objects, then let the migration
 * system recreate them properly. bun:sqlite doesn't allow DELETE FROM
 * sqlite_master even with writable_schema = ON, and Python's sqlite3 module
 * may block schema modifications on newer SQLite builds.
 */
function repairMalformedSchema(db: Database): void {
  try {
    // Quick test: if we can query sqlite_master, the schema is fine
    db.query('SELECT name FROM sqlite_master WHERE type = "table" LIMIT 1').all();
    return;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('malformed database schema')) {
      throw error;
    }

    logger.warn('DB', 'Detected malformed database schema, attempting repair', { error: message });

    // Extract the problematic object name from the error message
    // Format: "malformed database schema (object_name) - details"
    const match = message.match(/malformed database schema \(([^)]+)\)/);
    if (!match) {
      logger.error('DB', 'Could not parse malformed schema error, cannot auto-repair', { error: message });
      throw error;
    }

    const objectName = match[1];
    logger.info('DB', `Dropping malformed schema object: ${objectName}`);

    // Get the DB file path. For file-based DBs, we can use Python to repair.
    // For in-memory DBs, we can't shell out — just re-throw.
    const dbPath = db.filename;
    if (!dbPath || dbPath === ':memory:' || dbPath === '') {
      logger.error('DB', 'Cannot auto-repair in-memory database');
      throw error;
    }

    // Close the connection so sqlite3 CLI can safely modify the file
    db.close();

    // Use sqlite3 CLI to drop the orphaned object and reset migration versions
    // so they re-run and recreate things properly. The CLI's writable_schema
    // support works reliably across SQLite versions, unlike Python's sqlite3
    // module which may block schema modifications on newer SQLite builds.
    // bun:sqlite also doesn't support DELETE FROM sqlite_master even with writable_schema.
    //
    // Sanitize objectName to prevent SQL injection (schema object names are
    // alphanumeric + underscore only).
    const safeObjectName = objectName.replace(/[^a-zA-Z0-9_]/g, '');

    // Step 1: Drop the orphaned schema object via writable_schema
    const dropSql = [
      'PRAGMA writable_schema = ON;',
      `DELETE FROM sqlite_master WHERE name = '${safeObjectName}' AND type = 'index';`,
      'PRAGMA writable_schema = OFF;',
    ].join('\n');

    try {
      const dropResult = spawnSync('sqlite3', [dbPath], { input: dropSql, timeout: 10000 });
      if (dropResult.status !== 0) {
        const stderr = dropResult.stderr?.toString() || '';
        throw new Error(`sqlite3 CLI exited with code ${dropResult.status}: ${stderr}`);
      }

      // Step 2: Reset migration versions so affected migrations re-run.
      // schema_versions may not exist on a very fresh DB — ignore errors.
      const resetResult = spawnSync('sqlite3', [dbPath], { input: 'DELETE FROM schema_versions;', timeout: 10000 });
      if (resetResult.status !== 0) {
        const stderr = resetResult.stderr?.toString() || '';
        if (!stderr.includes('no such table')) {
          throw new Error(`Failed to reset migration versions: ${stderr}`);
        }
      }

      logger.info('DB', `Dropped orphaned schema object "${safeObjectName}" and reset migration versions via sqlite3 CLI. All migrations will re-run (they are idempotent).`);
    } catch (cliError: unknown) {
      const cliMessage = cliError instanceof Error ? cliError.message : String(cliError);
      logger.error('DB', 'sqlite3 CLI repair failed', { error: cliMessage });
      throw new Error(`Schema repair failed: ${message}. sqlite3 CLI repair error: ${cliMessage}`);
    }
  }
}

/**
 * Wrapper that handles the close/reopen cycle needed for schema repair.
 * Returns a (possibly new) Database connection.
 */
function repairMalformedSchemaWithReopen(dbPath: string, db: Database, depth: number = 0): Database {
  try {
    db.query('SELECT name FROM sqlite_master WHERE type = "table" LIMIT 1').all();
    return db;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('malformed database schema')) {
      throw error;
    }

    if (depth >= MAX_SCHEMA_REPAIR_ATTEMPTS) {
      logger.error('DB', `Schema repair exceeded ${MAX_SCHEMA_REPAIR_ATTEMPTS} attempts, giving up`, { error: message });
      throw new Error(`Schema repair failed after ${MAX_SCHEMA_REPAIR_ATTEMPTS} attempts: ${message}`);
    }

    // repairMalformedSchema closes the DB internally for Python access
    repairMalformedSchema(db);

    // Reopen and check for additional malformed objects
    const newDb = new Database(dbPath, { create: true, readwrite: true });
    return repairMalformedSchemaWithReopen(dbPath, newDb, depth + 1);
  }
}

/**
 * ClaudeMemDatabase - New entry point for the sqlite module
 *
 * Replaces SessionStore as the database coordinator.
 * Sets up bun:sqlite with optimized settings and runs all migrations.
 *
 * Usage:
 *   const db = new ClaudeMemDatabase();  // uses default DB_PATH
 *   const db = new ClaudeMemDatabase('/path/to/db.sqlite');
 *   const db = new ClaudeMemDatabase(':memory:');  // for tests
 */
export class ClaudeMemDatabase {
  public db: Database;

  constructor(dbPath: string = DB_PATH) {
    // Ensure data directory exists (skip for in-memory databases)
    if (dbPath !== ':memory:') {
      ensureDir(DATA_DIR);
    }

    // Create database connection
    this.db = new Database(dbPath, { create: true, readwrite: true });

    // Repair any malformed schema before applying settings or running migrations.
    // Must happen first — even PRAGMA calls can fail on a corrupted schema.
    // This may close and reopen the connection if repair is needed.
    this.db = repairMalformedSchemaWithReopen(dbPath, this.db);

    // Apply optimized SQLite settings
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA temp_store = memory');
    this.db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    this.db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_PAGES}`);

    // Run all migrations
    const migrationRunner = new MigrationRunner(this.db);
    migrationRunner.runAllMigrations();
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}

/**
 * SQLite Database singleton with migration support and optimized settings
 * @deprecated Use ClaudeMemDatabase instead for new code
 */
export class DatabaseManager {
  private static instance: DatabaseManager;
  private db: Database | null = null;
  private migrations: Migration[] = [];

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  /**
   * Register a migration to be run during initialization
   */
  registerMigration(migration: Migration): void {
    this.migrations.push(migration);
    // Keep migrations sorted by version
    this.migrations.sort((a, b) => a.version - b.version);
  }

  /**
   * Initialize database connection with optimized settings
   */
  async initialize(): Promise<Database> {
    if (this.db) {
      return this.db;
    }

    // Ensure the data directory exists
    ensureDir(DATA_DIR);

    this.db = new Database(DB_PATH, { create: true, readwrite: true });

    // Repair any malformed schema before applying settings or running migrations.
    // Must happen first — even PRAGMA calls can fail on a corrupted schema.
    this.db = repairMalformedSchemaWithReopen(DB_PATH, this.db);

    // Apply optimized SQLite settings
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA temp_store = memory');
    this.db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    this.db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_PAGES}`);

    // Initialize schema_versions table
    this.initializeSchemaVersions();

    // Run migrations
    await this.runMigrations();

    dbInstance = this.db;
    return this.db;
  }

  /**
   * Get the current database connection
   */
  getConnection(): Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  /**
   * Execute a function within a transaction
   */
  withTransaction<T>(fn: (db: Database) => T): T {
    const db = this.getConnection();
    const transaction = db.transaction(fn);
    return transaction(db);
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      dbInstance = null;
    }
  }

  /**
   * Initialize the schema_versions table
   */
  private initializeSchemaVersions(): void {
    if (!this.db) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
  }

  /**
   * Run all pending migrations
   */
  private async runMigrations(): Promise<void> {
    if (!this.db) return;

    const query = this.db.query('SELECT version FROM schema_versions ORDER BY version');
    const appliedVersions = query.all().map((row: any) => row.version);

    const maxApplied = appliedVersions.length > 0 ? Math.max(...appliedVersions) : 0;

    for (const migration of this.migrations) {
      if (migration.version > maxApplied) {
        logger.info('DB', `Applying migration ${migration.version}`);

        const transaction = this.db.transaction(() => {
          migration.up(this.db!);

          const insertQuery = this.db!.query('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)');
          insertQuery.run(migration.version, new Date().toISOString());
        });

        transaction();
        logger.info('DB', `Migration ${migration.version} applied successfully`);
      }
    }
  }

  /**
   * Get current schema version
   */
  getCurrentVersion(): number {
    if (!this.db) return 0;

    const query = this.db.query('SELECT MAX(version) as version FROM schema_versions');
    const result = query.get() as { version: number } | undefined;

    return result?.version || 0;
  }
}

/**
 * Get the global database instance (for compatibility)
 */
export function getDatabase(): Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call DatabaseManager.getInstance().initialize() first.');
  }
  return dbInstance;
}

/**
 * Initialize and get database manager
 */
export async function initializeDatabase(): Promise<Database> {
  const manager = DatabaseManager.getInstance();
  return await manager.initialize();
}

// Re-export bun:sqlite Database type
export { Database };

// Re-export MigrationRunner for external use
export { MigrationRunner } from './migrations/runner.js';

// Re-export all module functions for convenient imports
export * from './Sessions.js';
export * from './Observations.js';
export * from './Summaries.js';
export * from './Prompts.js';
export * from './Timeline.js';
export * from './Import.js';
export * from './transactions.js';