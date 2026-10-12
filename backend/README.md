# 听阅后端

当前目录是听阅当前工作区的后端工程。它将业务 API 与批量内容处理 Worker 分开，数据库只保存控制面数据，音频和字幕文件进入 S3 兼容对象存储。

## 当前范围

- Node.js 24 + TypeScript + Fastify API；
- PostgreSQL、Redis/BullMQ、通过通用 S3 SDK 访问的 MinIO/S3 兼容对象存储连接与就绪检查；
- 独立内容处理 Worker 入口；
- 微信会话、refresh 轮换、退出和当前用户接口；
- 批量内容导入控制面、S3 分片直传、BullMQ Worker、FFmpeg/字幕校验和发布门槛；
- 动态 works/work 目录、搜索分类、同版本元数据/章节、私有 manifest 短期 URL 与服务端 Quiz 判题；客户端同版本续签、恢复断点及账号/权限校验已通过本机 MinIO/Edge，微信真机和生产 CDN 待验收；
- S-01 一次性本机导入、S-02 revision/幂等进度同步与 S-03 稳定生词双向同步；
- 账号收藏/最近阅读云同步、取消收藏墓碑、离线幂等批次与账号绑定游标；
- Quiz 不可变离线补传、云历史/撤回 revision 及 Me/报告共同使用的可信学习摘要；
- `learning-points-v2` 累计积分、期间排行、不可变快照、outbox 重建、榜单及参与者 Quiz 明细；独立分析页的同快照 PASSED/ALL、全量文字搜索与排序分页；
- 结构化日志、追加式审计、受保护Prometheus指标和Grafana面板；
- Redis限流、双JWT签名密钥轮换、MinIO最小权限/生命周期和数据库事实源补队列；
- `/health/live` 与 `/health/ready`；
- local/dev/test Compose 定义；
- `api-contract-v2.4.0` OpenAPI 3.1、JSON Schema、稳定错误码和示例；
- 配置、API、契约、数据库、会话、内容、Quiz、排行、可观测性、安全、队列及X/B联调测试。

排行采用 `learning-points-v2`：新增有效听读每满 1 秒加 1 分，每篇首次完成加 50 分，每篇同一逻辑题首次经服务端确认答对加 10 分。积分无业务上限，重复证据不重复得分，API 使用十进制整数字符串；期间榜单统计期间新增积分，个人页面显示累计积分。默认系数与边界见 [ADR 0004](docs/adr/0004-learning-points-v2.md)，旧 `quiz-score-v1` 快照保留。数百文件压测、生产云环境、正式微信凭据、CDN/权益、生产告警和真机验收仍未完成。契约中的接口只有标记为已实现并通过对应测试后才视为可联调能力。

## API 契约

权威入口为 `contracts/openapi.json`，版本为 `contracts/VERSION` 中的 `api-contract-v2.4.0`。Schema、错误码、示例与版本规则见 `contracts/README.md`。积分类型发生破坏性变更，前后端必须对齐后发布；接口路径仍使用 `/api/v1`。

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
npm run test:integration:learning-points
npm run test:integration:local-import
npm run test:integration:progress-sync
npm run test:integration:saved-word-sync
npm run test:integration:reader-library
npm run test:integration:s04-sync
```

db:rollback 每次只回退最新一条，执行前必须评估数据影响。当前有 15 条成对迁移；隔离 PostgreSQL 已核验 42 个关系（含积分视图和 schema_migrations）。0010/0011/0012/0013 有防丢积分、快照、重建任务、收藏或验证元数据的拒绝条件。0014 仅移除派生同步字段，保留逐题事实；再升级后需完整拉取历史。0015 回退只删除派生排行分析，再升级后需重建新快照；均不能直接当作生产回退方案。

## 动态新书链路验收

2026-10-10 在隔离本机依赖上通过两版本导入、审批夹具发布、动态发现、完整资源校验、Quiz 判题、进度、云收藏/最近阅读/生词和回滚。运行 `npm run test:integration:catalog-ingestion` 时必须显式配置本机 15432 的 tingyue_test 数据库、127.0.0.1 对象存储、Redis 和 ffprobe；脚本使用随机书目/章节/队列，仅清理自身测试对象和 schema。夹具审批不代表 Peter 或任何正式书目可发布。

阅读 JSON 限每份 8 MiB，字幕、上下文词条和题包需规范化，题数最多 100；原始 VTT/SRT 的自动转换、数百文件/GB 压测和运营界面待开发。已有内容版本需要验证元数据、音频时长和同版本题包，不能只升级前端就宣称兼容。

## 排行分析验收

完整详情使用 GET /api/v1/rankings/{participantId}/quiz-analysis，固定列表快照；旧 /quizzes 保持兼容。PASSED/ALL 按期间内每篇章最新验真且未撤回的结果去重，通过采用保存的 mastery；未知词数为 null，满六篇才显示早期/近期趋势。Learning Points 仍按原规则累计，详情不会重新算排名或将篇章数当积分。

本机前端 184/184、后端 76/76 与类型/契约检查、15 项隔离集成、正式/Demo 浏览器及真实 MP3 回归通过。独立排行专项还覆盖真实前端→HTTP/Fastify→PG→Edge 的 50+8 分页、服务端搜索/排序与返回筛选。测试微信身份和预览导航不代替真机证据。

先在仓库根目录运行 npm run build:production，再于 backend 中执行 npm run test:integration:ranking-browser。需本机 Edge、根目录 Playwright 依赖及显式 DATABASE_URL 指向隔离测试库；不会自动启动或迁移生产库。统计、回退和后续业务状态见 [正式版对齐清单](../docs/正式版前后端功能对齐清单-2026-10-10.md)。

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

旧版 MinIO 社区镜像如无法拉取，可先从 MinIO 官方申请 AIStor Free 许可，保存为仓库根目录的 `minio.license`（已加入 `.gitignore`，不得提交），再使用本地覆盖配置启动对象存储：

```powershell
docker compose -f compose.yaml -f compose.aistor-local.yaml up -d minio minio-init
```

该覆盖配置只读挂载许可文件，并固定官方 AIStor 服务端与客户端镜像；它不更改默认 Compose、现有数据卷或生产部署方案。许可证申请、续期和正式使用条款需由项目负责人确认。若本机 5432 端口已被其他 PostgreSQL 占用，不要停止已有数据库；联调可使用独立测试端口并设置 `DATABASE_URL`。

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
