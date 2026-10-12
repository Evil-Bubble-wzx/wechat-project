# B 后端十五步执行状态

> 更新：2026-10-10
> 原则：只有代码、自动测试和可复核证据满足完成定义才标记完成；`DONE_LOCAL_TEST`不等于生产上线。

| 步骤 | 状态 | 当前证据 | 剩余动作 |
| --- | --- | --- | --- |
| 0 交接落点 | `DONE` | B 长期分支为`backend/v1`；`handoffBaseCommit=7b882b22bfcf535cf2677616cfa82b6bb3d8a70e`；保留用户原有未提交改动 | 无 |
| 1 B-01 决策 | `PARTIAL` | Node.js 24、TypeScript、Fastify、PostgreSQL、Redis/BullMQ、S3兼容存储、FFmpeg及可选Python Worker已写入ADR 0001/0002 | 需人工确认生产云厂商、地域、预算、域名和运维负责人 |
| 2 B-01 工程 | `DONE_LOCAL_TEST` | API/Worker、配置、Compose、健康检查、锁文件及CI已落地；Docker、PostgreSQL、Redis、对象存储和真实BullMQ消费已有历史验证；当前后端 76 项测试及类型检查通过 | 生产运行环境待步骤1决策 |
| 3 B-01 契约 | `DONE_LOCAL_TEST` | 当前 `api-contract-v2.4.0`；排行积分字符串、可选快照、云收藏/生词与动态目录/元数据/同版本资源；OpenAPI、Schema、错误码、请求ID、幂等和示例校验通过 | 需前后端对齐发布并完成生产复验 |
| 4 B-02 数据库 | `DONE_LOCAL_TEST` | 15 条成对 migration；隔离 PostgreSQL 升级、空数据回滚和再升级通过，核验 42 个关系（含视图与 schema_migrations）；0010 历史回填保留 v1 快照，0010/0011/0012/0013 有损回滚拒绝条件通过；0008/0009 不改写 | 生产备份/PITR/跨区及迁移演练仍待确认 |
| 5 B-03 登录 | `DONE_LOCAL_TEST` | 微信code2Session适配器、显式test stub、短期JWT、refresh轮换/重放撤销、双签名密钥轮换、退出幂等、账号禁用和`/me`已实现；OpenID加密、查找HMAC及refresh摘要已验证 | 真实AppID/AppSecret、合法域名和微信环境联调需人工资料 |
| 6 B-04 内容导入 | `PARTIAL_VALIDATION_PENDING` | 管理端批次、预签名分片上传、finalize、重试、取消、Worker、FFmpeg/字幕校验、死信恢复入口、原子发布/回滚门槛已实现；随机新书 7 类资产、并发消费、双版本审批夹具发布/回滚，经 MinIO→BullMQ→Worker→PG→前端通过；元数据、时长和题包已投影 | 仍需数百文件/总GB压测、客户端断点续传、Worker强杀接管、全链路取消/死信演练；C-03/C-05关闭前不可发布 |
| 7 B-04 内容API | `DONE_LOCAL_TEST` | 已实现筛选绑定签名 cursor 的动态 works/work/manifest、元数据、测量时长、完整资源校验、版本失效和受限/下架拒绝 | CDN、正式权益和生产域名待外部条件 |
| 8 Quiz | `DONE_LOCAL_TEST` | 服务端按当前公开题库判分；账号不可变离线补传、云历史/撤回及可信 Me/报告摘要通过；`userId + attemptId`幂等；题目集合、选项和版本不符稳定拒绝；验证结果写入排行重建outbox | 真实微信环境真机联调待人工资料 |
| 9 B-06 排行规则 | `DONE_LOCAL_TEST` | `learning-points-v2`：新增有效整秒 +1、每篇首次完成 +50、每题首次确认答对 +10；无业务上限，NUMERIC/BigInt/字符串精确累加；期间积分与个人累计分开 | 默认系数待业务确认；调整需新规则版本，不改写历史快照 |
| 10 B-06 排行存储 | `DONE_LOCAL_TEST` | 不可变快照、事务 outbox 与 Worker 重建；账号级统一锁顺序和确认读取串行化；Quiz 撤回及后续答对恢复按原得分期间追加重建任务；本机并发与去重验证通过 | 生产规模压测、反作弊和调度参数待云环境 |
| 11 B-06 排行API | `DONE_LOCAL_TEST` | 排行选项、榜单、兼容旧 Quiz 明细与独立分析 API 已实现；同快照 PASSED/ALL、全量文字搜索、六字段双向排序和 50+8 分页通过；覆盖A/B、滚动7日、周/月/年、具体周/月、K～9年级、阅读级别、10人隐私门槛、同分快照和cursor分页；792种筛选组合、滚动窗口刷新、8 路并发和列表/详情快照锁定通过 | 真实账号/真机验收待人工资料 |
| 12 B-05 可观测性 | `DONE_LOCAL_TEST` | 结构化请求日志、脱敏、requestId、审计、受保护Prometheus指标、排行/队列/内容/登录指标、Grafana面板和运行手册已落地 | 告警接收人、生产阈值和监控托管平台待步骤1确认 |
| 13 安全与恢复 | `DONE_LOCAL_TEST` | Redis限流、JWT双密钥轮换、上传MIME/大小/批次限制、MinIO最小权限和生命周期、DB事实源补队列、secret scan、CI、依赖审计0漏洞、备份恢复演练通过 | 生产KMS/密钥托管、云权限复核、PITR/跨区恢复和责任人待人工确认 |
| 14 X/B联调 | `PARTIAL_PRODUCTION_PENDING` | 当前 X-06 接入 session/refresh、content、Quiz、ranking、local-import、progress、saved-word、累计积分及收藏/最近阅读同步；2026-10-10 客户端 184/184、后端 76/76、15 项数据库/内容全链路 smoke、独立排行真实后端浏览器和正式/Demo 音频回归通过 | 原始字幕转换、运营/规模及正式业务仍待实施；真实微信、HTTPS、体验版与 iOS/Android 真机待验收 |
| 15 交付 | `PARTIAL` | 初始后端来源为 `backend/v1@9efe8aac`，S-03 选择性接收来源为 `backend/v1@533a64e`，交接、运行、安全恢复和可观测性文档已接收 | 仍需生产决策、微信凭据、内容权利签署、规模压测、当前客户端联调和真机证据后才能宣称上线交付 |

## 排行算法口径

排行榜主指标是服务端确认的 `learning-points-v2` 学习积分，不是“完成 Quiz 的书本数”。有效听读、首次完成、首次答对分别累加；不设业务上限，客户端不得上传或自行覆盖可信积分。完整规则与限制见 [ADR 0004](adr/0004-learning-points-v2.md)。旧 [ADR 0003](adr/0003-ranking-score-v1.md) 与 v1 快照保留为历史。

## 2026-10-10 正式版全量对齐续开发

当前开发契约为 api-contract-v2.4.0，新增 0012 云收藏/最近阅读、0013 目录验证投影、0014 Quiz 历史 revision 和 0015 不可变排行分析；动态新书、资源校验、可信时长、题库与发布/回滚链路已通过本机真实依赖。滚动窗口、快照和生词同步问题已修复。Quiz 不可变补传、两客户端云历史/撤回及 Me/报告统一统计通过；未知词数保持 null，重复区间不计入有效听读。签名音频过期/报错续签已本机通过：同版本七资源身份、账号隔离、断点/倍速/循环恢复和暂停/拖动/换章竞态，真实 MinIO 403→206/字节校验与 Edge 解码回归；仍需微信真机和生产 CDN 复验。完整排行独立页、PASSED/ALL、服务器验真时间、全量文字搜索/排序、范围游标及回退重建通过；分析数量为篇章，总学习积分不按通过状态拆分。本轮为前端 184/184、后端 76/76、15 项数据库/内容全链路 smoke、独立排行实际 HTTP/PG/Edge 及正式/Demo 音频回归；下方 115/59、11 条迁移保留为此前积分专项的历史证据。全量业务尚未完成，范围、指纹和后续闭环见 [正式版对齐清单](../../docs/正式版前后端功能对齐清单-2026-10-10.md)。

## 2026-10-10 积分专项原验证记录

客户端 115/115、后端 59/59、类型检查、契约 5/5、密钥扫描通过。数据库、learning-points、ranking、ranking-page、progress-sync、s04-sync、observability、local-import、quiz 共 9 项隔离依赖 smoke 通过。积分专项覆盖历史回填、碎片整秒、去重、并发、首次完成、错题改对、混合导入、Quiz 撤回与恢复、确认读取、跨版本高水位、大整数和四种期间榜单。

正式/Demo 浏览器全套回归与真实本地 MP3 播放通过；S-04 是本机两个 HTTP 会话，不是真实两台微信设备。未部署生产服务或执行生产迁移，阶段 0 与真机门槛不变。

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
