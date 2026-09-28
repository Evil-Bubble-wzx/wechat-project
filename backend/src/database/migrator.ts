import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";

export const migrationsDirectory = fileURLToPath(
  new URL("../../migrations/", import.meta.url),
);

export type Migration = {
  version: string;
  checksum: string;
  upSql: string;
  downSql: string;
};

export type AppliedMigration = {
  version: string;
  checksum: string;
  appliedAt: Date;
};

export type MigrationOptions = {
  schema?: string;
};

const migrationFilePattern = /^(\d{4}_[a-z0-9_]+)\.(up|down)\.sql$/;
const schemaNamePattern = /^[a-z_][a-z0-9_]{0,62}$/;
const migrationLockName = "tingyue-schema-migrations-v1";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function quoteIdentifier(value: string): string {
  if (!schemaNamePattern.test(value)) {
    throw new Error(`Invalid PostgreSQL schema name: ${value}`);
  }
  return `"${value}"`;
}

async function selectSchema(client: PoolClient, schema: string): Promise<void> {
  await client.query(`SET search_path TO ${quoteIdentifier(schema)}, public`);
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum char(64) NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function acquireLock(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [migrationLockName]);
}

async function releaseLock(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_unlock(hashtext($1))", [migrationLockName]);
}

export async function discoverMigrations(
  directory: string = migrationsDirectory,
): Promise<Migration[]> {
  const fileNames = await readdir(directory);
  const filesByVersion = new Map<string, { up?: string; down?: string }>();

  for (const fileName of fileNames) {
    const match = migrationFilePattern.exec(fileName);
    if (!match) continue;
    const [, version, direction] = match;
    const pair = filesByVersion.get(version) ?? {};
    if (direction === "up") pair.up = fileName;
    if (direction === "down") pair.down = fileName;
    filesByVersion.set(version, pair);
  }

  const migrations: Migration[] = [];
  for (const [version, pair] of [...filesByVersion.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!pair.up || !pair.down) {
      throw new Error(`Migration ${version} must have matching up and down files`);
    }
    const [upSql, downSql] = await Promise.all([
      readFile(`${directory}/${pair.up}`, "utf8"),
      readFile(`${directory}/${pair.down}`, "utf8"),
    ]);
    if (!upSql.trim() || !downSql.trim()) {
      throw new Error(`Migration ${version} cannot contain an empty direction`);
    }
    migrations.push({ version, checksum: sha256(upSql), upSql, downSql });
  }

  if (migrations.length === 0) {
    throw new Error(`No migrations found in ${directory}`);
  }
  return migrations;
}

async function readAppliedMigrations(client: PoolClient): Promise<AppliedMigration[]> {
  const result = await client.query<{
    version: string;
    checksum: string;
    applied_at: Date;
  }>("SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version");
  return result.rows.map((row) => ({
    version: row.version,
    checksum: row.checksum.trim(),
    appliedAt: row.applied_at,
  }));
}

export async function getMigrationStatus(
  pool: Pool,
  options: MigrationOptions = {},
): Promise<Array<Migration & { appliedAt: Date | null }>> {
  const schema = options.schema ?? "public";
  const migrations = await discoverMigrations();
  const client = await pool.connect();
  try {
    await selectSchema(client, schema);
    await ensureMigrationTable(client);
    const applied = new Map(
      (await readAppliedMigrations(client)).map((migration) => [migration.version, migration]),
    );
    return migrations.map((migration) => ({
      ...migration,
      appliedAt: applied.get(migration.version)?.appliedAt ?? null,
    }));
  } finally {
    client.release();
  }
}

export async function migrateUp(
  pool: Pool,
  options: MigrationOptions = {},
): Promise<string[]> {
  const schema = options.schema ?? "public";
  const migrations = await discoverMigrations();
  const client = await pool.connect();
  const appliedNow: string[] = [];
  try {
    await selectSchema(client, schema);
    await ensureMigrationTable(client);
    await acquireLock(client);
    const applied = new Map(
      (await readAppliedMigrations(client)).map((migration) => [migration.version, migration]),
    );

    for (const migration of migrations) {
      const existing = applied.get(migration.version);
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new Error(
            `Applied migration ${migration.version} checksum differs from the file on disk`,
          );
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await selectSchema(client, schema);
        await client.query(migration.upSql);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [migration.version, migration.checksum],
        );
        await client.query("COMMIT");
        appliedNow.push(migration.version);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      await releaseLock(client);
    } finally {
      client.release();
    }
  }
  return appliedNow;
}

export async function rollbackOne(
  pool: Pool,
  options: MigrationOptions = {},
): Promise<string | null> {
  const schema = options.schema ?? "public";
  const migrations = await discoverMigrations();
  const migrationByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const client = await pool.connect();
  try {
    await selectSchema(client, schema);
    await ensureMigrationTable(client);
    await acquireLock(client);
    const applied = await readAppliedMigrations(client);
    const latest = applied.at(-1);
    if (!latest) return null;
    const migration = migrationByVersion.get(latest.version);
    if (!migration) {
      throw new Error(`Applied migration ${latest.version} has no rollback file on disk`);
    }
    if (migration.checksum !== latest.checksum) {
      throw new Error(
        `Applied migration ${latest.version} checksum differs from the file on disk`,
      );
    }

    await client.query("BEGIN");
    try {
      await selectSchema(client, schema);
      await client.query(migration.downSql);
      await client.query("DELETE FROM schema_migrations WHERE version = $1", [latest.version]);
      await client.query("COMMIT");
      return latest.version;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    try {
      await releaseLock(client);
    } finally {
      client.release();
    }
  }
}
