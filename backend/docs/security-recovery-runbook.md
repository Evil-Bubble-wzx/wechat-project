# 安全、备份与回滚手册

> 本地/test 基线：2026-09-24。生产云厂商、地域、备份产品、KMS 和责任人确认前，生产仍为 `NO-GO`。

## 1. 防护基线

- 微信登录：同一来源 IP 每分钟 10 次；refresh 每分钟 30 次。
- Quiz 写入：同一服务端用户每分钟 30 次；`userId + attemptId` 与 `Idempotency-Key` 双重幂等。
- 排名读取：同一服务端用户每分钟 120 次；限流键只保存作用域与主体 SHA-256，不保存原始 IP/userId。
- 上传声明按资源类型限制 MIME 和大小：音频 5 GiB，字幕/文本/词汇/Quiz 100 MiB，封面 50 MiB，metadata 20 MiB；单批最多 100 GiB、1000 个资源、10000 个分片。
- API 不接收客户端计算的排名分，排名只从未撤回的 `server_verified` attempt 重建。
- `npm run security:secrets`、`npm audit --audit-level=moderate`、类型/单元/契约测试已进入 CI。

## 2. 密钥轮换

1. 在密钥系统生成新的 32 字节 token 签名密钥。
2. 部署时将新值放入 `TOKEN_SIGNING_KEY_BASE64`，将旧值暂放 `PREVIOUS_TOKEN_SIGNING_KEY_BASE64`。
3. 验证新 token 使用新密钥签发、旧 access token 在最长 15 分钟 TTL 内仍可验证。
4. 超过旧 token TTL 后清空 `PREVIOUS_TOKEN_SIGNING_KEY_BASE64` 并再次部署。
5. refresh token 只存摘要；疑似泄漏时撤销 token family。身份 HMAC/数据加密密钥轮换需配套数据重加密迁移，不可直接替换。
6. 对象存储凭据按“新建最小权限账号 -> 双环境验证 -> 切换 API/Worker -> 停用旧账号”执行，禁止在日志或工单中复制明文。

## 3. 对象存储保护

- 本地 MinIO 使用独立应用账号 `tingyue-app-local`，只有两个指定 bucket 的列举、读、写和 multipart 权限，无管理员权限。
- `tingyue-published` 开启版本化；保留至少 5 个非当前版本，非当前版本 90 天后清理。
- `tingyue-incoming` 当前对象 30 天后清理；未完成 multipart 由 MinIO stale-upload 机制 24 小时过期、每小时扫描。
- 生产采用等价的 S3 IAM、版本化、生命周期、服务端加密和访问日志；bucket 不允许公开访问。

## 4. 数据库备份目标

在业务负责人未给出更严格等级前，test/prod 建议目标为：

- PostgreSQL：PITR/增量备份 RPO 15 分钟；单库恢复 RTO 60 分钟；每日全量备份保留 30 天。
- 已发布对象：版本化保护，RPO 24 小时以内；误覆盖恢复 RTO 4 小时。
- Redis/BullMQ：不作为事实来源，不声明 RPO；丢失后从 PostgreSQL 重建任务。

生产值班人、备份区域、跨区副本和实际 SLA 必须由阶段 0 人工确认。

## 5. 恢复演练

本地执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/backup-restore-drill.ps1
```

脚本将当前 `tingyue` 数据库做 custom-format 备份，恢复到固定隔离数据库，核对 migration、表和 A/B 校区，然后删除隔离数据库与容器内临时备份。不得把脚本改为覆盖当前数据库。

恢复生产时先在隔离环境恢复并运行：migration checksum、外键/约束、登录、内容、Quiz、排名和发布门槛验证；验证通过后再按变更单切换连接。

## 6. 队列恢复

Redis 丢失或 Worker 中断后：

```powershell
npm run recovery:requeue
```

该命令把超过 10 分钟的数据库 `running` 任务恢复为 `queued`，并从 PostgreSQL 的 queued/retry_wait 事实记录补回缺失 BullMQ 任务；已有相同 BullMQ jobId 的任务不会重复。排名重算事件保存在 `ranking_rebuild_events`，Worker 会自动接管超过 5 分钟的 processing 事件。

## 7. 应用、数据库与内容回滚

- 应用回滚：部署上一个已验证镜像/提交；保持契约 MAJOR 兼容。先回应用，再观察健康检查和错误率。
- migration：默认向前修复。只有最新 migration 的 down 已在备份副本演练、且确认不会丢失新数据时才执行 `npm run db:rollback`。
- 内容回滚：只能调用受审计的 content-version rollback API；目标版本必须已发布且 `publishable=true`。任何 `publishable:false` 候选都不得成为 current version。
- 排名：不手工改分；从原始 attempt 重建新快照版本，旧快照保留供审计。

每次生产恢复必须记录开始/结束时间、实际 RPO/RTO、负责人、验证结果和后续修复项。
