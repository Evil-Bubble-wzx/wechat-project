# 听阅后端

当前目录是 B 长期分支的后端工程骨架。它将业务 API 与批量内容处理 Worker 分开，数据库只保存控制面数据，音频和字幕文件进入 S3 兼容对象存储。

## 当前范围

- Node.js 24 + TypeScript + Fastify API；
- PostgreSQL、Redis/BullMQ、通过通用 S3 SDK 访问的 MinIO/S3 兼容对象存储连接与就绪检查；
- 独立内容处理 Worker 入口；
- 微信会话、refresh 轮换、退出和当前用户接口；
- 批量内容导入控制面、S3 分片直传、BullMQ Worker、FFmpeg/字幕校验和发布门槛；
- works、work、私有 manifest 短期 URL 与服务端 Quiz 判题；
- `quiz-score-v1`排行聚合、不可变快照、outbox重建、榜单及参与者Quiz明细；
- 结构化日志、追加式审计、受保护Prometheus指标和Grafana面板；
- Redis限流、双JWT签名密钥轮换、MinIO最小权限/生命周期和数据库事实源补队列；
- `/health/live` 与 `/health/ready`；
- local/dev/test Compose 定义；
- `api-contract-v1.0.0` OpenAPI 3.1、JSON Schema、稳定错误码和示例；
- 配置、API、契约、数据库、会话、内容、Quiz、排行、可观测性、安全、队列及X/B联调测试。

排行规则已冻结为`quiz-score-v1`：完成Quiz的不同书本数、词量、贝叶斯校正正确率、挑战度、成长和题材广度共同形成0～1000算法分；完成书本数不是最终指标。数百文件压测、生产云环境、正式微信凭据、CDN/权益、生产告警和真机验收仍未完成。契约中的接口只有标记为已实现并通过对应测试后才视为可联调能力。

## API 契约

权威入口为 `contracts/openapi.json`，版本为 `contracts/VERSION` 中的 `api-contract-v1.0.0`。Schema、错误码、示例与版本规则见 `contracts/README.md`。

```powershell
npm run contract:check
```

该命令会校验 OpenAPI 外部引用、JSON Schema 示例、错误码同步、所有响应的 `X-Request-Id`，以及所有写接口的 `Idempotency-Key`。

## 数据库迁移

迁移使用成对的纯 SQL 文件和带 advisory lock/checksum 的事务迁移器。详细回滚与恢复规则见 `docs/database-migrations.md`。

```powershell
npm run db:status
npm run db:migrate
npm run test:integration:db
```

`db:rollback` 每次只回退最新一条，执行前必须评估数据影响。当前6条迁移创建27张业务表和`schema_migrations`，并幂等写入`a`、`b`两个校区。

## 本地启动

要求 Node.js 24、npm 11、Docker Desktop（或兼容的 Docker Engine + Compose）和 FFmpeg/ffprobe。

Windows 首次安装还要求 WSL 2；当前验证基线为 Docker Desktop 4.91.0、Docker Engine/CLI 29.8.0、Compose 5.5.1、WSL 2.7.13。MinIO 和 `mc` 从官方 Quay 仓库按 tag 与 digest 双重固定，避免已归档 Docker Hub 仓库和漂移标签。

当前 Windows 音频工具验证基线为 FFmpeg Essentials 9.0.1。新终端通常可直接使用 `ffprobe`；若 PATH 尚未刷新，可通过 `FFPROBE_PATH` 显式配置。

```powershell
cd backend
npm install
docker compose up -d
npm run start:api
```

另开终端启动 Worker：

```powershell
cd backend
npm run start:worker
```

检查：

```powershell
Invoke-RestMethod http://127.0.0.1:3100/health/live
Invoke-RestMethod http://127.0.0.1:3100/health/ready
npm run check
npm run contract:check
npm run db:status
npm run test:integration:db
npm run test:integration:session
npm run test:integration:content
npm run test:integration:quiz
npm run test:integration:ranking
npm run test:integration:observability
npm run test:integration:security
npm run test:integration:xb
npm run test:integration:queue
npm run recovery:requeue
npm run security:secrets
```

完整 Peter Rabbit 内容管道测试还需 PostgreSQL、Redis、MinIO 和 ffprobe：

```powershell
npm run test:integration:ingestion
```

`/health/live` 只证明 API 进程存活；`/health/ready` 同时检查 PostgreSQL、Redis 和两个 MinIO bucket。

`test:integration:queue` 要求 Redis 与 Worker 已启动；它会投递一条带唯一 ID 的 `skeleton.ping`，等待 Worker 返回并自动清理测试任务。

## 配置

变量清单见`.env.example`。代码中的默认账号、stub微信身份和本地加密密钥只允许local/test环境；`APP_ENV=prod`使用其中任一项都会拒绝启动。真实AppSecret、当前/上一把token签名密钥、身份HMAC密钥、数据加密密钥及监控令牌不得提交到Git。生产密钥轮换、KMS、PITR与告警责任见`docs/security-recovery-runbook.md`和`docs/observability-runbook.md`。

## Docker 尚不可用时

不依赖外部服务的单元测试仍可运行。依赖服务联调、就绪检查和 Worker 消费测试必须等 Docker 或等价服务可用后执行，不能把未运行的测试记录为通过。
