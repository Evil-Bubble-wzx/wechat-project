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

## 内容目录投影迁移

当前新增 0013_content_catalog_projection，为 content_versions 增加 catalog_metadata，为 processing_artifacts 增加 validation。处理器保存规范化元数据、测量时长与题包验证结果；发布/回滚在同一数据库事务中更新当前版本指针、章节字数/等级和首个已发布章节的作品投影。

0013 不猜测或伪造旧数据。有任一非空元数据或验证结果时，down 拒绝执行；空模式升级、回退、再升级及有数据拒绝均已通过本机验证。生产升级前备份，已有内容另行重新验证或制定可审计的补齐方案，不能删除验证数据来强行回退。

## Quiz 历史派生迁移

0014_quiz_history 为 quiz_attempts 增加 history_seq 和 history_updated_at，用触发器跟踪验真、拒绝、撤回及恢复。按账号先锁定再分配数字序号，查询按底层数值列排序；云游标签名绑定账号和派生序列 epoch。

当前 19 条成对迁移、46 个关系。0014 的 down 只移除派生列、索引、触发器和序列，不删除 attempt 或逐题答案；重新 up 使旧游标失效，客户端完整重拉后才替换缓存。该回退及答案保留已在隔离库验证，不等于已批准生产回退。物理恢复、时间回拨或从旧备份恢复须另行评估游标与密钥失效策略，序列 OID 不是所有恢复方式的世代标识。

## 排行分析派生迁移

0015_ranking_quiz_analysis 在现有快照、参与者和记录上增加分析版本、PASSED/ALL JSON、mastery、服务端验真时间、内容版本、词数已知标记和新增答题积分，并增加索引；不新增关系。旧快照保持身份和原值，新增字段为空或版本 0，不猜测统计。

down 只移除这些派生字段与索引，保留原始 Quiz attempt、逐题答案、学习积分事件和原快照分值。再升级后旧分析请求不可直接使用；榜单刷新重新构建新身份，新迁移应用时间完整精度纳入来源指纹，避免复用已移除分析的旧快照。旧 /quizzes 端点继续兼容原快照。

空库升级/回退/再升级，以及有数据的 0015 回退/再升级、新快照重建、旧快照不覆写均已在隔离本机测试库验证。部署新应用前必须先完成该向前迁移；任何生产回退都需停写/应用版本配合、备份及人工评估，不以本机测试作为批准。

## 学生档案派生迁移

0016_student_profile_management 为 users 增加唯一 Student Code 查询码，为 user_profiles 增加 bigint revision 和变更递增触发器，不新增关系。旧档案初始 revision 为 0，新插入为 1；无变化不递增。保留原档案版本触发器、可信来源、实际生效时间及审计链，不改写 0001～0015。

down 只删除新字段、索引和 revision 触发器，保留用户、档案、版本历史、学习事件、幂等记录与审计。重新 up 会生成不同查询码并重置派生 revision，原查询码不能用于写入；客户端需从 Me 重新获取、重新查询和核验。查询码不是身份或登录凭据，不作为永久校方学号。

本机隔离库已验证空模式升级/回退/再升级和有档案数据的事实保留、旧码拒绝重放；实际应用 2.5 前需先升级至 0016。生产回退须停写、备份并配合兼容应用，不直接运行本机测试命令覆盖生产资料。

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
## 上传恢复迁移

0017_upload_recovery 增加上传对象标识、不可变合并意图与 upload_session_mutations。合并意图先提交，存储合并后用唯一会话标识确认对象；完整 SHA-256 仍由处理任务验证。变更幂等绑定管理员和请求，不保存临时 URL。

空模式升级、回退、再升级通过；存在新对象标识、合并意图或变更事实时 down 拒绝。不得删除记录强行回退；生产迁移需备份并处理未完成上传，旧会话缺少新标识时不猜测异常合并成功。
## 运营控制迁移

0018_ingestion_operations 增加代次、清理确认及幂等事实，重试/取消与审计原子保存，外部失败可重放。Worker 和恢复检查活跃锁、累计次数及代次，完整上传和旧失败队列保留。

空模式回退/再升级通过；有运营变更、非零代次或清理确认时 down 拒绝。不得删除事实强制降级。当前 19 条迁移、46 个关系，未进行生产迁移。
0018 部署前须排空或停止旧 Worker，升级 API/Worker 到同一控制面版本后再开启重试与重建；旧代码不认识代次保护，不能以混合运行代替迁移验收。

## 整组导入迁移

0019_bulk_content_import 增加 content_import_groups 和 content_import_entries 两个关系，保存账号绑定的不可变清单、幂等摘要及有序章节批次引用。草稿目录、全部章节声明和审计同一事务提交，原有目录不覆盖；任何章节冲突整组回滚。空库 down/up 已通过；有导入事实时 down 拒绝执行，不删除事实强行降级。生产须先备份并配合应用升级，本次未执行生产迁移。
