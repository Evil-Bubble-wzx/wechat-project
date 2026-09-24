# 数据库迁移与恢复

## 迁移策略

后端使用成对的版本化 SQL：`migrations/<version>.up.sql` 与 `migrations/<version>.down.sql`。TypeScript 迁移器负责：

- 以 PostgreSQL advisory lock 阻止并发迁移；
- 每条迁移独立事务提交，失败自动回滚；
- 在 `schema_migrations` 保存版本、SHA-256 和应用时间；
- 已应用文件发生 checksum 漂移时拒绝继续；
- `up` 可重复运行且不会重复建表或重复 seed；
- `down` 每次只回滚最新一条，避免一次误退多个版本。

命令：

```powershell
npm run db:status
npm run db:migrate
npm run db:rollback
npm run test:integration:db
```

`test:integration:db` 只在随机命名的 `migration_test_<随机值>` schema 中运行，覆盖空库升级、重复升级、约束、seed、回滚和重新升级，结束后删除该临时 schema。

## 失败处理

1. 若单条 `up` 失败，该迁移事务会回滚，先修复 SQL，再重新执行 `db:migrate`。
2. 已成功应用的迁移禁止原地修改；必须新增向前修复迁移。checksum 漂移是发布阻断错误。
3. `db:rollback` 仅用于尚未承载生产数据、且 down SQL 的数据影响已经人工评估的环境。
4. `0002_seed_campuses.down.sql` 会删除 `a`、`b`；若已有 profile 外键引用，回滚会安全失败，必须先制定数据迁移方案，不能级联删除用户资料。
5. 正式环境迁移前先做数据库备份，迁移后检查 `db:status`、关键表和应用就绪状态。生产凭据不写入命令历史或文档。

## 备份与恢复模板

以下命令中的数据库名、容器名和存储位置必须按实际环境审核。恢复必须写入新建验证库，不覆盖来源库：

```powershell
docker compose exec -T postgres pg_dump -U tingyue -d tingyue -Fc -f /tmp/tingyue.dump
docker compose exec -T postgres createdb -U tingyue tingyue_restore_check
docker compose exec -T postgres pg_restore -U tingyue -d tingyue_restore_check --exit-on-error /tmp/tingyue.dump
```

核对 `schema_migrations`、核心表数量和 seed 后，才可清理明确命名的临时验证库与临时 dump。生产环境还必须配置独立备份保存期、加密和恢复负责人；这些信息待云供应商与运维负责人确认。
