import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import pg from "pg";

import { loadConfig } from "../src/config.ts";
import { migrateUp, rollbackOne } from "../src/database/migrator.ts";

const { Pool } = pg;

const schema = `migration_test_${randomBytes(8).toString("hex")}`;
if (!/^migration_test_[a-f0-9]{16}$/.test(schema)) {
  throw new Error("Generated migration test schema is invalid");
}

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });

async function main(): Promise<void> {
  const setupClient = await pool.connect();
  try {
    await setupClient.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    setupClient.release();
  }

  try {
    assert.deepEqual(await migrateUp(pool, { schema }), [
      "0001_initial_schema",
      "0002_seed_campuses",
      "0003_idempotency_records",
      "0004_ingestion_control_plane",
      "0005_ranking_aggregation",
      "0006_ranking_refresh",
    ]);
    assert.deepEqual(await migrateUp(pool, { schema }), []);

    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
      [schema],
    );
    const tableNames = tables.rows.map(({ table_name }) => table_name);
    for (const requiredTable of [
      "users",
      "user_sessions",
      "campuses",
      "content_versions",
      "ingestion_batches",
      "processing_jobs",
      "quiz_attempts",
      "ranking_snapshots",
      "ranking_snapshot_entries",
      "ranking_snapshot_quizzes",
      "ranking_rebuild_events",
      "user_profile_versions",
      "audit_events",
      "idempotency_records",
      "user_roles",
    ]) {
      assert.ok(tableNames.includes(requiredTable), `missing table ${requiredTable}`);
    }

    const campuses = await pool.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM "${schema}".campuses ORDER BY id`,
    );
    assert.deepEqual(campuses.rows, [
      { id: "a", display_name: "A校区" },
      { id: "b", display_name: "B校区" },
    ]);

    const user = await pool.query<{ id: string }>(
      `INSERT INTO "${schema}".users DEFAULT VALUES RETURNING id`,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO "${schema}".user_profiles (user_id, grade)
         VALUES ($1, '10')`,
        [user.rows[0]?.id],
      ),
      /user_profiles_grade_check/i,
    );

    const indexes = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = $1",
      [schema],
    );
    const indexNames = new Set(indexes.rows.map(({ indexname }) => indexname));
    for (const requiredIndex of [
      "quiz_attempts_user_id_attempt_id_key",
      "content_assets_piece_id_content_version_asset_type_key",
      "processing_jobs_job_type_idempotency_key_key",
      "ranking_snapshots_source_uidx",
      "ingestion_batches_active_piece_version_uidx",
      "ranking_snapshot_entries_page_idx",
      "ranking_snapshot_quizzes_page_idx",
      "user_profile_versions_current_uidx",
    ]) {
      assert.ok(indexNames.has(requiredIndex), `missing uniqueness index ${requiredIndex}`);
    }

    assert.equal(await rollbackOne(pool, { schema }), "0006_ranking_refresh");
    assert.deepEqual(await migrateUp(pool, { schema }), ["0006_ranking_refresh"]);
    assert.equal(await rollbackOne(pool, { schema }), "0006_ranking_refresh");
    assert.equal(await rollbackOne(pool, { schema }), "0005_ranking_aggregation");
    assert.equal(await rollbackOne(pool, { schema }), "0004_ingestion_control_plane");
    assert.equal(await rollbackOne(pool, { schema }), "0003_idempotency_records");
    assert.equal(await rollbackOne(pool, { schema }), "0002_seed_campuses");
    assert.equal(await rollbackOne(pool, { schema }), "0001_initial_schema");

    const usersAfterRollback = await pool.query<{ relation: string | null }>(
      "SELECT to_regclass($1) AS relation",
      [`${schema}.users`],
    );
    assert.equal(usersAfterRollback.rows[0]?.relation, null);

    process.stdout.write(
      `migration.smoke.passed schema=${schema} tables=${tableNames.length}\n`,
    );
  } finally {
    const cleanupClient = await pool.connect();
    try {
      await cleanupClient.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      cleanupClient.release();
    }
  }
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
