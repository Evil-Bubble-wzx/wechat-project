import assert from "node:assert/strict";
import test from "node:test";

import { discoverMigrations } from "../src/database/migrator.ts";

test("migration files are paired, ordered and have stable checksums", async () => {
  const migrations = await discoverMigrations();

  assert.deepEqual(
    migrations.map(({ version }) => version),
    [
      "0001_initial_schema",
      "0002_seed_campuses",
      "0003_idempotency_records",
      "0004_ingestion_control_plane",
      "0005_ranking_aggregation",
      "0006_ranking_refresh",
    ],
  );
  for (const migration of migrations) {
    assert.match(migration.checksum, /^[a-f0-9]{64}$/);
    assert.ok(migration.upSql.trim().length > 0);
    assert.ok(migration.downSql.trim().length > 0);
  }
});
