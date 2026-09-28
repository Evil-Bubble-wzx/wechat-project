$ErrorActionPreference = "Stop"

$drillDatabase = "tingyue_restore_drill_20260924"
$containerDump = "/tmp/tingyue-restore-drill-20260924.dump"

try {
  docker compose exec -T postgres pg_dump -U tingyue -d tingyue -Fc -f $containerDump
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }

  docker compose exec -T postgres dropdb -U tingyue --if-exists $drillDatabase
  if ($LASTEXITCODE -ne 0) { throw "dropdb preparation failed" }
  docker compose exec -T postgres createdb -U tingyue $drillDatabase
  if ($LASTEXITCODE -ne 0) { throw "createdb failed" }
  docker compose exec -T postgres pg_restore -U tingyue -d $drillDatabase $containerDump
  if ($LASTEXITCODE -ne 0) { throw "pg_restore failed" }

  $migrationCount = docker compose exec -T postgres psql -U tingyue -d $drillDatabase -Atc "SELECT count(*) FROM schema_migrations"
  $tableCount = docker compose exec -T postgres psql -U tingyue -d $drillDatabase -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"
  $campusCount = docker compose exec -T postgres psql -U tingyue -d $drillDatabase -Atc "SELECT count(*) FROM campuses"

  if ([int]$migrationCount -lt 6) { throw "restored migration count is too small: $migrationCount" }
  if ([int]$tableCount -lt 28) { throw "restored table count is too small: $tableCount" }
  if ([int]$campusCount -ne 2) { throw "restored campus count is invalid: $campusCount" }

  Write-Output "recovery.restore.passed database=$drillDatabase migrations=$migrationCount tables=$tableCount campuses=$campusCount"
}
finally {
  docker compose exec -T postgres dropdb -U tingyue --if-exists $drillDatabase | Out-Null
  docker compose exec -T postgres sh -c "rm -f /tmp/tingyue-restore-drill-20260924.dump" | Out-Null
}
