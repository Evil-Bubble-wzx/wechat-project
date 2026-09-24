# B 后端十五步执行状态

> 更新：2026-09-24
> 原则：只有代码、自动测试和可复核证据满足完成定义才标记完成；`DONE_LOCAL_TEST`不等于生产上线。

| 步骤 | 状态 | 当前证据 | 剩余动作 |
| --- | --- | --- | --- |
| 0 交接落点 | `DONE` | B 长期分支为`backend/v1`；`handoffBaseCommit=7b882b22bfcf535cf2677616cfa82b6bb3d8a70e`；保留用户原有未提交改动 | 无 |
| 1 B-01 决策 | `PARTIAL` | Node.js 24、TypeScript、Fastify、PostgreSQL、Redis/BullMQ、S3兼容存储、FFmpeg及可选Python Worker已写入ADR 0001/0002 | 需人工确认生产云厂商、地域、预算、域名和运维负责人 |
| 2 B-01 工程 | `DONE_LOCAL_TEST` | API/Worker、配置、Compose、健康检查、锁文件及CI已落地；Docker、PostgreSQL、Redis、MinIO和真实BullMQ消费已验证；后端38项测试通过 | 生产运行环境待步骤1决策 |
| 3 B-01 契约 | `DONE` | `api-contract-v1.0.0`、OpenAPI 3.1、JSON Schema 2020-12、稳定错误码、请求ID、幂等和示例校验通过 | 实际提交后补B提交SHA |
| 4 B-02 数据库 | `DONE_LOCAL_TEST` | 6条成对migration、27张业务表加`schema_migrations`、A/B校区seed；空库升级、重复升级、约束、回滚/再升级及备份恢复通过；恢复结果6 migrations/28 tables/2 campuses | 生产备份保存期、PITR、跨区和负责人待步骤1确认 |
| 5 B-03 登录 | `DONE_LOCAL_TEST` | 微信code2Session适配器、显式test stub、短期JWT、refresh轮换/重放撤销、双签名密钥轮换、退出幂等、账号禁用和`/me`已实现；OpenID加密、查找HMAC及refresh摘要已验证 | 真实AppID/AppSecret、合法域名和微信环境联调需人工资料 |
| 6 B-04 内容导入 | `PARTIAL_VALIDATION_PENDING` | 管理端批次、预签名分片上传、finalize、重试、取消、Worker、FFmpeg/字幕校验、死信恢复入口、原子发布/回滚门槛已实现；Peter Rabbit 7类资产经MinIO→BullMQ→Worker→PostgreSQL通过 | 仍需数百文件/总GB压测、客户端断点续传、Worker强杀接管、全链路取消/死信演练；C-03/C-05关闭前不可发布 |
| 7 B-04 内容API | `DONE_LOCAL_TEST` | 已实现签名cursor的works/work/manifest、私有对象短期URL、版本失效和受限资源拒绝 | CDN、正式权益和生产域名待外部条件 |
| 8 Quiz | `DONE_LOCAL_TEST` | 服务端按版本化题库判分；`userId + attemptId`幂等；题目集合、选项和版本不符稳定拒绝；验证结果写入排行重建outbox | 真实微信环境真机联调待人工资料 |
| 9 B-06 排行规则 | `DONE_LOCAL_TEST` | `quiz-score-v1`已冻结：完成书本30%、词量15%、贝叶斯正确率25%、挑战度15%、成长10%、题材广度5%；输出0～1000算法分，非书本数 | 产品若改变权重需发布新规则版本，不覆盖v1快照 |
| 10 B-06 排行存储 | `DONE_LOCAL_TEST` | 已实现版本化不可变快照、来源指纹、档案时点、撤回重算、事务outbox与Worker重建；重复重算幂等，源数据变化生成新快照 | 生产规模压测和调度参数待云环境 |
| 11 B-06 排行API | `DONE_LOCAL_TEST` | 排行选项、榜单和参与者Quiz明细API已实现；覆盖A/B、滚动7日、周/月/年、具体周/月、K～9年级、阅读级别、10人隐私门槛、同分快照和cursor分页；792种筛选组合测试通过 | 真实账号/真机验收待人工资料 |
| 12 B-05 可观测性 | `DONE_LOCAL_TEST` | 结构化请求日志、脱敏、requestId、审计、受保护Prometheus指标、排行/队列/内容/登录指标、Grafana面板和运行手册已落地 | 告警接收人、生产阈值和监控托管平台待步骤1确认 |
| 13 安全与恢复 | `DONE_LOCAL_TEST` | Redis限流、JWT双密钥轮换、上传MIME/大小/批次限制、MinIO最小权限和生命周期、DB事实源补队列、secret scan、CI、依赖审计0漏洞、备份恢复演练通过 | 生产KMS/密钥托管、云权限复核、PITR/跨区恢复和责任人待人工确认 |
| 14 X/B联调 | `DONE_LOCAL_TEST` | 小程序API适配层已接入登录/刷新/退出、内容、Quiz、算法排行和明细；真实Fastify+临时PostgreSQL X/B联调覆盖登录、401刷新重试、Quiz验证/幂等/拒绝、小样本人群榜单、退出和审计；正式/Demo浏览器回归通过 | 真实微信开发者工具、体验版和iOS/Android真机仍需人工环境 |
| 15 交付 | `PARTIAL` | 交接、运行、安全恢复、可观测性、X/B联调文档及自动验证已更新 | 未创建提交；需补B提交SHA、生产决策、微信凭据、内容权利签署、规模压测和真机证据后才能宣称上线交付 |

## 排行算法口径

排行榜主指标是服务端`quiz-score-v1`算法分，不是“完成Quiz的书本数”。完成书本数只是30%的一项输入；客户端不得上传或自行覆盖算法分。完整公式、数据边界、隐私门槛和并列规则见`docs/adr/0003-ranking-score-v1.md`。

## 2026-09-24 验证记录

```text
小程序
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
