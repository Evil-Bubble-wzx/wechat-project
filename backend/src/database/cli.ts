import pg from "pg";

import { loadConfig } from "../config.ts";
import { getMigrationStatus, migrateUp, rollbackOne } from "./migrator.ts";

const { Pool } = pg;

async function main(): Promise<void> {
  const action = process.argv[2] ?? "up";
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });

  try {
    if (action === "up") {
      const applied = await migrateUp(pool);
      process.stdout.write(
        applied.length > 0
          ? `Applied migrations: ${applied.join(", ")}\n`
          : "Database is already at the latest migration.\n",
      );
      return;
    }

    if (action === "down") {
      const rolledBack = await rollbackOne(pool);
      process.stdout.write(
        rolledBack ? `Rolled back migration: ${rolledBack}\n` : "No migration to roll back.\n",
      );
      return;
    }

    if (action === "status") {
      const status = await getMigrationStatus(pool);
      for (const migration of status) {
        process.stdout.write(
          `${migration.appliedAt ? "applied" : "pending"} ${migration.version}\n`,
        );
      }
      return;
    }

    throw new Error("Usage: npm run db:migrate | db:rollback | db:status");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown migration error";
  process.stderr.write(`Migration command failed: ${message}\n`);
  process.exitCode = 1;
});
