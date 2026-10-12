# B 后端十五步执行状态

本次上传例外：档案浏览器收尾修正待复验；此前业务断言通过但退出时发生夹具在途请求异常，不能视为该次全项通过。原字幕浏览器本次追加复跑未开始，保留前阶段记录。按用户“先上传”交付当前代码，生产和真机门槛不变。

> 更新：2026-10-12
> 原则：只有代码、自动测试和可复核证据满足完成定义才标记完成；`DONE_LOCAL_TEST`不等于生产上线。

| 步骤 | 状态 | 当前证据 | 剩余动作 |
| --- | --- | --- | --- |
| 0 交接落点 | `DONE` | B 长期分支为`backend/v1`；`handoffBaseCommit=7b882b22bfcf535cf2677616cfa82b6bb3d8a70e`；保留用户原有未提交改动 | 无 |
| 1 B-01 决策 | `PARTIAL` | Node.js 24、TypeScript、Fastify、PostgreSQL、Redis/BullMQ、S3兼容存储、FFmpeg及可选Python Worker已写入ADR 0001/0002 | 需人工确认生产云厂商、地域、预算、域名和运维负责人 |
| 2 B-01 工程 | `DONE_LOCAL_TEST` | API/Worker、配置、Compose、健康检查、锁文件及CI已落地；Docker、PostgreSQL、Redis、对象存储和真实BullMQ消费已有历史验证；当前后端 118 项测试及类型检查通过 | 生产运行环境待步骤1决策 |
| 3 B-01 契约 | `DONE_LOCAL_TEST` | 当前 `api-contract-v2.9.0`；学习链路、学生档案及原始字幕导入/派生清单语义；OpenAPI、Schema、错误码、请求ID、幂等和示例校验通过 | 需前后端对齐发布并完成生产复验 |
| 4 B-02 数据库 | `DONE_LOCAL_TEST` | 19 条成对 migration；隔离 PostgreSQL 升级、空数据回滚和再升级通过，核验 46 个关系（含视图与 schema_migrations）；0010 历史回填保留 v1 快照，0010/0011/0012/0013 有损回滚拒绝条件通过；0016 回退保留档案事实、重新生成查询码；0008/0009 不改写 | 生产备份/PITR/跨区及迁移演练仍待确认 |
| 5 B-03 登录 | `DONE_LOCAL_TEST` | 微信code2Session适配器、显式test stub、短期JWT、refresh轮换/重放撤销、双签名密钥轮换、退出幂等、账号禁用和`/me`已实现；OpenID加密、查找HMAC及refresh摘要已验证 | 真实AppID/AppSecret、合法域名和微信环境联调需人工资料 |
| 6 B-04 内容导入 | `PARTIAL_VALIDATION_PENDING` | 管理 HTTP/MinIO 分片/7 并发 Worker/PG/前端通过 JSON/SRT/VTT 三版本，原始与派生摘要、约 9.6 MB 原字幕双分片、错误拒绝和发布/回滚；原文件保留；独立运营网页与 0017 上传恢复已本机通过 | 仍需生产网页登录、复杂格式明确转换、数百文件/总GB压测、生产并发取消/长任务接管、死信全故障矩阵；C-03/C-05关闭前不可发布 |
| 7 B-04 内容API | `DONE_LOCAL_TEST` | 已实现筛选绑定签名 cursor 的动态 works/work/manifest、元数据、测量时长、完整资源校验、版本失效和受限/下架拒绝 | CDN、正式权益和生产域名待外部条件 |
| 8 Quiz | `DONE_LOCAL_TEST` | 服务端按当前公开题库判分；账号不可变离线补传、云历史/撤回及可信 Me/报告摘要通过；`userId + attemptId`幂等；题目集合、选项和版本不符稳定拒绝；验证结果写入排行重建outbox | 真实微信环境真机联调待人工资料 |
| 9 B-06 排行规则 | `DONE_LOCAL_TEST` | `learning-points-v2`：新增有效整秒 +1、每篇首次完成 +50、每题首次确认答对 +10；无业务上限，NUMERIC/BigInt/字符串精确累加；期间积分与个人累计分开 | 默认系数待业务确认；调整需新规则版本，不改写历史快照 |
| 10 B-06 排行存储 | `DONE_LOCAL_TEST` | 不可变快照、事务 outbox 与 Worker 重建；账号级统一锁顺序和确认读取串行化；Quiz 撤回及后续答对恢复按原得分期间追加重建任务；本机并发与去重验证通过 | 生产规模压测、反作弊和调度参数待云环境 |
| 11 B-06 排行API | `DONE_LOCAL_TEST` | 排行选项、榜单、兼容旧 Quiz 明细与独立分析 API 已实现；同快照 PASSED/ALL、全量文字搜索、六字段双向排序和 50+8 分页通过；覆盖A/B、滚动7日、周/月/年、具体周/月、K～9年级、阅读级别、10人隐私门槛、同分快照和cursor分页；792种筛选组合、滚动窗口刷新、8 路并发和列表/详情快照锁定通过 | 真实账号/真机验收待人工资料 |
| 12 B-05 可观测性 | `DONE_LOCAL_TEST` | 结构化请求日志、脱敏、requestId、审计、受保护Prometheus指标、排行/队列/内容/登录指标、Grafana面板和运行手册已落地 | 告警接收人、生产阈值和监控托管平台待步骤1确认 |
| 13 安全与恢复 | `DONE_LOCAL_TEST` | Redis限流、JWT双密钥轮换、上传MIME/大小/批次限制、MinIO最小权限和生命周期、DB事实源补队列、secret scan、CI、依赖审计0漏洞、备份恢复演练通过 | 生产KMS/密钥托管、云权限复核、PITR/跨区恢复和责任人待人工确认 |
| 14 X/B联调 | `PARTIAL_PRODUCTION_PENDING` | 2026-10-12 客户端 208/208、后端 118/118、20 项 smoke、排行/档案/SRT/VTT 实际后端浏览器及正式/Demo 音频回归通过；档案期初分组、权限与原始字幕派生验真通过 | 学校同步、复杂字幕、运营扩展/规模及正式业务仍待实施；真实微信、HTTPS、体验版与 iOS/Android 真机待验收 |
| 15 交付 | `PARTIAL` | 此前 152 文件已获准上传并核验 `backend/v1@2c64344bc8fffabdaeafd10ce477b4430b88bfcf`；本地 2.5/2.6/2.7/2.8/2.9 在 `codex/student-profile-alignment-20261012`，交接文档同步更新，纳入本次 backend/v1 交付，未部署 | 仍需生产决策、微信凭据、内容权利签署、规模压测、当前客户端联调和真机证据后才能宣称上线交付 |

## 排行算法口径

排行榜主指标是服务端确认的 `learning-points-v2` 学习积分，不是“完成 Quiz 的书本数”。有效听读、首次完成、首次答对分别累加；不设业务上限，客户端不得上传或自行覆盖可信积分。完整规则与限制见 [ADR 0004](adr/0004-learning-points-v2.md)。旧 [ADR 0003](adr/0003-ranking-score-v1.md) 与 v1 快照保留为历史。

## 整组内容导入交付

2.9 整组导入已本机通过：显式清单和文件夹绑定，原子创建草稿作品/章节与批次，已有属性冲突整组回滚；IndexedDB 保存账号清单和原重试键，不保存文件或凭证。实际 HTTP/PG/MinIO/BullMQ/Edge 通过 2 部作品、20 章、140 个资源声明（45 个独立文件）、创建响应丢失恢复、中断续传、错误文件拒绝和三宽度。所有章节仅到待审核，零真实批准/发布。生产网页登录、受控授权、独立书目编辑/审批页面、数百独立文件/GB 压测、云环境故障矩阵及真机仍待完成。

当前 19 条迁移、46 个关系；前端 208/208，后端 118/118，20 项基础集成通过。以下各阶段保留当时测试数量和未完成状态，不能替代本节当前结果。

## 2026-10-12 原始字幕及上传阶段记录

本阶段字幕契约为 api-contract-v2.6.0，新增 Worker 逐行 VTT/SRT→JSON、原始/派生工件关系和实际派生清单字节，输入 100 MiB、输出 8 MiB，错误明确拒绝；不推测词义或关闭审核门槛。真实管理 HTTP、MinIO、BullMQ/ffprobe、PG 和前端通过三版本、超过 8 MiB 原字幕、双分片、错误摘要/重叠/超时长及回滚。预览补齐资源请求/取消/超时桥，SRT/VTT Edge 书库→详情→播放器与句切换、三宽度通过。

该阶段全量结果为前端 202/202、后端 110/110；17 项基础集成加上传/运营控制共 19 项，运营控制浏览器另通过，另有排行/档案/SRT/VTT 和正式/Demo 音频回归。0017 增加合并意图、对象标识和恢复幂等，该阶段共 18 条迁移、44 个关系。运营网页七文件上传、刷新续传、过期跳过分片、错误文件拒绝、合并后故障恢复及三宽度通过；仅 local/test 注册，不代替生产网页登录、跨章节批量、取消/死信及规模验收。完整状态见 [正式版对齐清单](../../docs/正式版前后端功能对齐清单-2026-10-10.md)。下方档案与积分数字保留为阶段记录。


## 2.8 运营控制与任务恢复阶段记录

0018 新增代次、清理确认和运营幂等事实，重试/取消与审计原子保存。分页、原因/次数、同键重放、入队和清理故障、等待锁时撤权、运行锁保护、Worker 实际终止后接管已本机通过；旧代次不复活取消任务，累计次数不重置，完整上传不删除。该阶段 19 项基础集成，另有运营控制及排行/档案/字幕浏览器；生产登录、跨章节批量、并发故障矩阵及正式业务仍待开发/验收。

## 2026-10-12 学生档案阶段记录

新增本人档案及运营管理员核验流程，学生和 content_admin 无管理权限。精确字符串 revision、防并发覆盖、加密幂等、账号有序锁后的撤权检查和原子审计已通过真实 HTTP/PG；页面具备核验依据与确认、失败原请求重试、换账号/离页迟到隔离和返回前台重读，不自动离线提交管理员修改。

用户确认“维持期初档案分组，下个榜单周期才生效”。已有聚合与 Worker 按窗口起点分组，本轮保留并新增转校/下一周期/滚动窗口回归，不改积分算法。0016 查询码及 revision 回退保留档案/版本/学习事实，重新升级生成新码阻止旧请求覆盖。查询码不是身份凭据，正式角色授权和学校批量同步仍待实施。

本阶段契约 api-contract-v2.5.0，16 条迁移、42 个关系。前端 194/194、后端 82/82、16 项集成、独立排行/档案真实后端浏览器及正式/Demo 音频回归通过；源码/正式/Demo 静态路由为 15/12/15，Demo 浏览器含 Quiz 分包共 16。此前 2.4 已上传 backend/v1，本轮在本地 codex 分支，未提交、推送或部署；全量业务仍未完成，详见 [正式版对齐清单](../../docs/正式版前后端功能对齐清单-2026-10-10.md)。下方数字保留为时间点历史。

## 2026-10-10 正式版全量对齐历史记录

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
