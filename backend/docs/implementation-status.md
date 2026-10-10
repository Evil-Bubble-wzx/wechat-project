# B 后端十五步执行状态

2026-10-10 最新补充：本机模拟收费第一阶段完成，契约 api-contract-v2.1.0；11 条迁移。订单/固定版本权限/全额退款已验证，Peter Rabbit 免费，无真实扣款，公网网关未开放交易接口。客户端 117/117、后端 60/60。操作及边界见 [模拟收费验收](../../docs/模拟收费验收与操作-2026-10-10.md)。以下较早基线保留为历史记录。


> 更新：2026-10-10
> 原则：只有代码、自动测试和可复核证据满足完成定义才标记完成；`DONE_LOCAL_TEST`不等于生产上线。

| 步骤 | 状态 | 当前证据 | 剩余动作 |
| --- | --- | --- | --- |
| 0 交接落点 | `DONE` | B 长期分支为`backend/v1`；`handoffBaseCommit=7b882b22bfcf535cf2677616cfa82b6bb3d8a70e`；保留用户原有未提交改动 | 无 |
| 1 B-01 决策 | `PARTIAL` | Node.js 24、TypeScript、Fastify、PostgreSQL、Redis/BullMQ、S3兼容存储、FFmpeg及可选Python Worker已写入ADR 0001/0002 | 需人工确认生产云厂商、地域、预算、域名和运维负责人 |
| 2 B-01 工程 | `DONE_LOCAL_TEST` | API/Worker、配置、Compose、健康检查、锁文件及CI已落地；Docker、PostgreSQL、Redis、对象存储和真实BullMQ消费已有历史验证；当前后端 59 项测试通过 | 生产运行环境待步骤1决策 |
| 3 B-01 契约 | `DONE` | 接收基线 `api-contract-v1.0.0` 经 S-01～S-03 扩展后升级为当前 `api-contract-v2.0.0`（积分字段类型为破坏性变更）；新增 S-01、S-02 与 S-03，OpenAPI 3.1、JSON Schema 2020-12、稳定错误码、请求ID、幂等和示例校验通过 | 当前客户端按固定契约适配后复验 |
| 4 B-02 数据库 | `DONE_LOCAL_TEST` | 10 条成对 migration；0001～0010 在隔离 PostgreSQL 18 升级/回滚/再升级通过，核验 39 个表/视图条目；0008/0009 保留进度/生词，0010 增加积分和重算，已有积分时拒绝有损回滚 | 生产备份/PITR/跨区待确认；已应用 WIP 0010 的环境须另行向前迁移 |
| 5 B-03 登录 | `DONE_LOCAL_TEST` | 微信code2Session适配器、显式test stub、短期JWT、refresh轮换/重放撤销、双签名密钥轮换、退出幂等、账号禁用和`/me`已实现；OpenID加密、查找HMAC及refresh摘要已验证 | 真实AppID/AppSecret、合法域名和微信环境联调需人工资料 |
| 6 B-04 内容导入 | `PARTIAL_VALIDATION_PENDING` | 管理端批次、预签名分片上传、finalize、重试、取消、Worker、FFmpeg/字幕校验、死信恢复入口、原子发布/回滚门槛已实现；Peter Rabbit 7类资产经MinIO→BullMQ→Worker→PostgreSQL通过 | 仍需数百文件/总GB压测、客户端断点续传、Worker强杀接管、全链路取消/死信演练；C-03/C-05关闭前不可发布 |
| 7 B-04 内容API | `DONE_LOCAL_TEST` | 已实现签名cursor的works/work/manifest、私有对象短期URL、版本失效和受限资源拒绝 | CDN、正式权益和生产域名待外部条件 |
| 8 Quiz | `DONE_LOCAL_TEST` | 服务端按版本化题库判分；`userId + attemptId`幂等；题目集合、选项和版本不符稳定拒绝；验证结果写入排行重建outbox | 真实微信环境真机联调待人工资料 |
| 9 B-06 排行规则 | `DONE_LOCAL_TEST` | `learning-points-v2`：听读每满秒 1 分、篇目首次完成 50 分、同题首次确认答对 10 分；无上限精确整数，历史只进累计，跨版本不重奖 | 规则变更须升版，保留旧 v1 快照 |
| 10 B-06 排行存储 | `DONE_LOCAL_TEST` | 已实现版本化不可变快照、来源指纹、档案时点、撤回重算、事务outbox与Worker重建；重复重算幂等，源数据变化生成新快照，恢复旧事实重新激活旧快照；撤回和跨月再次答对自动重算原期间 | 生产规模、多 worker 聚合一致性和调度参数待验 |
| 11 B-06 排行API | `DONE_LOCAL_TEST` | 排行选项、榜单和参与者Quiz明细API已实现；覆盖A/B、滚动7日、周/月/年、具体周/月、K～9年级、阅读级别、10人隐私门槛、同分快照和cursor分页；792种筛选组合测试通过 | 真实账号/真机验收待人工资料 |
| 12 B-05 可观测性 | `DONE_LOCAL_TEST` | 结构化请求日志、脱敏、requestId、审计、受保护Prometheus指标、排行/队列/内容/登录指标、Grafana面板和运行手册已落地 | 告警接收人、生产阈值和监控托管平台待步骤1确认 |
| 13 安全与恢复 | `DONE_LOCAL_TEST` | Redis限流、JWT双密钥轮换、上传MIME/大小/批次限制、MinIO最小权限和生命周期、DB事实源补队列、secret scan、CI、依赖审计0漏洞、备份恢复演练通过 | 生产KMS/密钥托管、云权限复核、PITR/跨区恢复和责任人待人工确认 |
| 14 X/B联调 | `PARTIAL_PRODUCTION_PENDING` | 当前 X-06 已接入 session/refresh、content manifest、Quiz、ranking、local-import 、progress sync 与 saved-word sync；排行、S-01、S-02 和 S-03 HTTP/PostgreSQL 联调通过；客户端 115/115、后端 59/59，积分与 S-04 本机双会话验证通过 | 补真实微信、HTTPS 合法域名、体验版和 iOS/Android 真机证据 |
| 15 交付 | `PARTIAL` | 初始后端来源为 `backend/v1@9efe8aac`，S-03 选择性接收来源为 `backend/v1@533a64e`，交接、运行、安全恢复和可观测性文档已接收 | 仍需生产决策、微信凭据、内容权利签署、规模压测、当前客户端联调和真机证据后才能宣称上线交付 |

## 排行算法口径

排行榜主指标是 `learning-points-v2` 累计学习积分。有效听读每满秒 1 分、稳定篇目首次完成 50 分、同一逻辑题首次服务端确认答对 10 分；无业务上限，API 以十进制整数字符串传输。跨版本按已计分秒数最高值去重，历史回填及 S-01 旧记录只进累计；无效/撤回答案取消无有效支持的积分，并自动重算原期间。规则见 [ADR 0004](adr/0004-learning-points-v2.md)，当前测试记录见 [验收交接](../../docs/学习积分验收与交接-2026-10-10.md)。

## 2026-09-24 验证记录

```text
小程序（B 分支旧基线历史记录，不代表当前 peter）
  npm test: 62 passed, 0 failed
  npm run check: 14 routes / syntax / assets PASS
  npm run build:production: 110 files, sha256 c3419dbb96e147785db53ecb34d39134139bcc9f709767a785b4cbad73234c54
  npm run build:demo: 197 files, sha256 3a903e7f6a341c8656f5d76b0c02f2b2776467f435db92446b764b94b0cf078a
  npm run build:verify: reproducible=true
  npm run test:browser: production + Demo PASS；15 routes @ 320/390/430px；算法榜单明细PASS

后端静态/单元/契约
  npm run check: TypeScript PASS；38 passed, 0 failed
  npm run contract:check: OpenAPI / refs / requestId / idempotency / examples PASS
  npm run security:secrets: PASS
  npm audit --audit-level=moderate: 0 vulnerabilities

后端真实依赖集成
  test:integration:db: 6 migrations / 28 tables / 2 campuses PASS
  test:integration:session: login / refresh rotation / previous signing key / logout PASS
  test:integration:content: cursor / presigned manifest / restricted access PASS
  test:integration:quiz: server scoring / idempotency / stable rejection PASS
  test:integration:ranking: recompute / withdrawal / source refresh / campus isolation / cursor / detail PASS
  test:integration:observability: append-only audit / protected metrics PASS
  test:integration:security: Redis rate limit / MinIO least privilege PASS
  test:integration:ingestion: Peter Rabbit 7 assets / checksum / corrupt audio / publish gate PASS
  test:integration:xb: miniapp client -> Fastify -> PostgreSQL full path PASS
  recovery:requeue: DB source-of-truth recovery PASS

PostgreSQL备份恢复
  pg_dump custom format -> isolated restore: PASS
  restored migrations/tables/campuses: 6/28/2
```

Docker Desktop已于2026-09-24安装并在WSL 2.7.13上成功启动。MinIO使用官方Quay镜像，应用账号采用最小权限策略；`incoming`和`published`bucket已配置版本与生命周期。本地FFmpeg Essentials 9.0.1通过真实音频探测。
