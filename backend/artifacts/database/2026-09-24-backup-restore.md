# PostgreSQL 备份与恢复演练记录

- 日期：2026-09-24
- 来源：本地 Docker PostgreSQL 16，数据库 `tingyue`
- 迁移：`0001_initial_schema`、`0002_seed_campuses`、`0003_idempotency_records`、`0004_ingestion_control_plane`、`0005_ranking_aggregation`、`0006_ranking_refresh`
- 最新临时恢复库：由`backup-restore-drill.ps1`随机创建并在验收后删除
- 备份格式：`pg_dump -Fc`

## 结果

1. `pg_dump` 成功生成临时 custom-format dump。
2. 新建独立验证库成功，未覆盖来源库。
3. `pg_restore --exit-on-error` 成功。
4. 最新恢复库核验结果：迁移记录`6`、public表`28`、校区seed`2`。
5. 临时恢复库已删除，再查询结果为 `0`。
6. 容器内临时 dump 已删除；该文件是一次性演练产物，不可恢复。
7. 来源库再次执行`db:status`，六条迁移仍为`applied`。

结论：本地开发基线的 schema、迁移记录与 seed 可以通过 PostgreSQL custom-format 备份恢复。该记录不代替未来云环境的加密、保存期、PITR、跨区和负责人验收。
