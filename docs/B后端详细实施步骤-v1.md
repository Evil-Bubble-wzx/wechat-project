# 听阅 B 后端详细实施步骤 v1

> 日期：2026-09-24
> 状态：后端执行清单
> 适用范围：`B-01`～`B-06`
> 当前发布结论：阶段 0 `NO-GO`；只允许 local/dev/test，不得启用真实生产交易或发布未获批准内容

## 1. 执行原则

- 每一步都必须留下代码、契约、测试或验收记录，不能只口头说明完成。
- B 分支中的 OpenAPI 3.1、JSON Schema、错误码、数据库迁移和契约测试是后端权威来源。
- X 客户端只接固定契约版本和固定 B 分支提交 SHA，不跟随“最新版本”。
- Peter Rabbit 当前保持 `publishable:false`；后端不得绕过 C-03/C-05 发布门槛。
- 排行只使用服务端可信数据。客户端本机分数、时长、校区、年级和级别都不能直接作为服务端事实。
- 密钥、AppSecret、token 原文、openid、手机号和用户答案不得写入 Git 或普通日志。

## 2. 总体执行顺序

| 步骤 | 任务 | 要做什么 | 主要产物 | 完成条件 |
| --- | --- | --- | --- | --- |
| 0 | 交接落点 | 创建 B 长期分支并固定交接基线 | 分支名、`handoffBaseCommit` | 能从同一提交复现 X 契约输入 |
| 1 | B-01 决策 | 冻结 API、数据库、对象存储、队列、Worker、云、地域和环境 | ADR、环境矩阵 | 双方签字或在文档中确认 |
| 2 | B-01 工程 | 建立 `backend/` API/Worker、配置、CI和健康检查 | 可启动后端骨架 | local/dev/test 可重复启动 |
| 3 | B-01 契约 | 建立 OpenAPI、Schema、错误码和版本机制 | `api-contract-v1.0.0` | 契约校验和示例请求通过 |
| 4 | B-02 数据库 | 建表、索引、约束、迁移和种子 | migrations | 空库可升级、可回滚、可恢复 |
| 5 | B-03 登录 | 接入 `wx.login` code 换取会话 | session API | 过期、撤销、重放测试通过 |
| 6 | B-04 内容导入 | 建立直传、分片、队列和批量处理流水线，再导入候选内容 | test 内容记录与导入批次 | 保持 `publishable:false`，失败可重试 |
| 7 | B-04 内容API | 实现 works、work、manifest与资源鉴权 | 内容读取接口 | 未授权不能绕过API读取受限资源 |
| 8 | Quiz | 实现服务端判题和 attempt 幂等 | Quiz API | 客户端不能伪造可信分数 |
| 9 | B-06 排行规则 | 冻结校区、周期、年级、级别和指标 | 排名规则 ADR | 周/月/年边界无歧义 |
| 10 | B-06 排行存储 | 建立校区、用户分组和聚合结构 | migration/聚合任务 | 可重算且不信任客户端结果 |
| 11 | B-06 排行API | 实现筛选选项和榜单读取 | ranking APIs | A/B及全部筛选组合通过契约测试 |
| 12 | B-05 可观测性 | 日志、指标、审计、告警 | dashboard/runbook | 故障可定位、敏感信息不泄露 |
| 13 | 安全与恢复 | 限流、备份、恢复、回滚 | 演练记录 | 恢复目标和回滚步骤验证通过 |
| 14 | X/B联调 | 客户端接入固定契约版本 | 联调记录 | 正常、失败、过期、重试均通过 |
| 15 | 交付 | 固定版本、SHA、变更记录和已知限制 | 后端交付包 | X可独立复现和验收 |

## 3. 步骤 0：建立后端分支和交接基线

### 操作

1. 获取最新版 `peter` 分支。
2. 记录当前提交 SHA，写入 `handoffBaseCommit`。
3. 从该提交创建长期 B 分支；分支名称由团队确认，不复用旧实验分支。
4. 在仓库根目录创建 `backend/`，不修改 X 客户端历史来伪装后端已经存在。
5. 把分支名称、基线 SHA、负责人和日期填入交接文档确认表。

### 验收

- B 分支能指出唯一 `handoffBaseCommit`。
- 后端同事和客户端负责人使用的是同一版交接文档。
- 工作区没有真实密钥、私钥或生产配置。

## 4. 步骤 1：完成 B-01 技术与环境决策

### 必须确认

1. 后端语言、框架和运行时版本。
2. 关系型数据库产品和版本；数据库只存元数据，不存音频文件本体。
3. 队列、任务重试、死信和独立内容处理 Worker 的实现。
4. 对象存储、分片直传、预签名、CDN和私有资源签名方式；API 不代理整文件。
5. FFmpeg/ffprobe 版本与参数；需要 ASR/强制对齐时的 Python Worker 边界。
6. 云供应商、中国大陆目标地域和预算上限。
7. local/dev/test/prod 的账号、网络和数据隔离。
8. API域名、资源域名和微信合法域名。
9. 密钥管理、轮换和吊销方式。
10. CI、部署、数据库迁移和回滚工具。
11. 运维负责人、告警接收人和工作时间外响应方式。

### 建议基线（等待人工确认）

- Node.js 24 LTS + TypeScript + Fastify；
- PostgreSQL 16 或团队已验证的更新稳定版；
- Redis 7 + BullMQ；
- local/dev 使用 MinIO，生产通过 S3 兼容适配层接云对象存储；
- API、内容处理 Worker 分进程，音频使用 FFmpeg/ffprobe；ASR/强制对齐才调用 Python Worker；
- Docker Compose 复现 local/dev/test。

详细设计见 `docs/批量音频字幕导入架构-v1.md`。

### 产物

- `backend/docs/adr/0001-stack.md`；
- `backend/docs/adr/0002-environments.md`；
- `backend/.env.example`，只写变量名；
- 环境矩阵，列出 local/dev/test/prod 的用途和禁止事项。

### 验收

- 未确定生产账号时仍能完成 local/dev/test 设计。
- 阶段 0 未 `GO` 时，prod 环境不能部署或启用真实服务。

## 5. 步骤 2：建立后端工程骨架

### 操作

1. 建立应用入口、配置加载、依赖锁文件和格式化规则。
2. 建立 `/health/live` 与 `/health/ready`。
3. 建立统一请求上下文和 `requestId`。
4. 建立统一成功响应、错误响应和异常处理中间件。
5. 建立数据库连接、事务封装和迁移命令。
6. 建立 Redis/BullMQ 连接、API 入队和独立 Worker 进程；Worker 关闭时能安全归还未完成任务。
7. 建立 MinIO/S3 兼容对象存储适配器、预签名分片上传和本机 bucket 初始化。
8. 固定 FFmpeg/ffprobe 运行方式和版本，不依赖开发者机器上的偶然安装。
9. 建立单元、集成、契约和 Worker 测试目录。
10. 建立CI：安装、静态检查、测试、契约校验、迁移测试和内容处理冒烟测试。
11. 建立Docker Compose或等价的可重复本地运行方式，至少包含 API、Worker、PostgreSQL、Redis 和 MinIO。

### 验收

- 新机器只按 `backend/README.md` 即可启动。
- 健康检查能区分进程存活和依赖可用。
- 启动日志不输出密钥和连接串原文。

## 6. 步骤 3：冻结 API 契约基线

### 操作

1. 创建 OpenAPI 3.1 文档，统一前缀 `/api/v1`。
2. 创建请求/响应 JSON Schema。
3. 建立稳定错误码表，至少包含：
   - `AUTH_CODE_INVALID`；
   - `ACCESS_TOKEN_EXPIRED`；
   - `REFRESH_TOKEN_REUSED`；
   - `CONTENT_VERSION_UNAVAILABLE`；
   - `QUIZ_PACKAGE_MISMATCH`；
   - `QUIZ_ATTEMPT_REJECTED`；
   - `RANKING_UNAVAILABLE`；
   - `RANKING_PERIOD_INVALID`；
   - `RANKING_FILTER_INVALID`；
   - `UPLOAD_SESSION_EXPIRED`；
   - `ASSET_CHECKSUM_MISMATCH`；
   - `INGESTION_BATCH_CONFLICT`；
   - `INGESTION_JOB_FAILED`；
   - `SUBTITLE_VALIDATION_FAILED`。
4. 写接口示例、错误示例、分页和幂等语义。
5. 发布第一个契约版本，例如 `api-contract-v1.0.0`。

### 验收

- OpenAPI能通过校验器。
- 示例请求和实现的字段、状态码一致。
- 客户端不需要解析人类文案判断错误类型。

## 7. 步骤 4：完成 B-02 数据库与迁移

### 核心表

- `users`：业务用户主键、状态和最小身份信息；
- `wechat_identities`：加密或受控保存微信身份映射；
- `user_sessions`：refresh token 摘要、设备、过期和撤销；
- `campuses`：稳定校区ID，首批为 `a`、`b`；
- `user_profiles`：用户所属校区、年级、阅读级别及来源；
- `works`、`pieces`、`content_assets`：作品、篇章、版本和资源；
- `content_versions`、`content_reviews`：整套内容版本、审核门槛、发布与回滚；
- `ingestion_batches`、`ingestion_items`：批量导入控制面和单文件结果；
- `upload_sessions`：分片上传、对象 key、预期大小/哈希、过期和完成状态；
- `processing_jobs`、`processing_artifacts`：可重试任务及原始/中间/最终产物关系；
- `quiz_packages`、`quiz_questions`、`quiz_attempts`、`quiz_answers`；
- `ranking_snapshots` 或可重算聚合表；
- `audit_events`。

### 数据约束

1. `campus_id` 必须引用有效校区。
2. `grade` 只允许 `k`、`1`～`9` 或空值。
3. `reading_level` 只允许当前冻结级别或空值。
4. Quiz attempt 以 `user_id + attempt_id` 唯一。
5. 内容资产以 `piece_id + content_version + asset_type` 唯一。
6. 排名快照必须记录周期、过滤条件、规则版本和生成时间。
7. 导入任务以任务类型和幂等键唯一；同一 `piece_id + content_version` 同时只有一个活动发布事务。
8. SHA-256 相同的物理对象可以复用，但逻辑资产引用和审计记录不能合并丢失。

### 验收

- 空库可以一次执行到最新版。
- 重复执行不会产生重复数据。
- 至少完成一次备份、删除测试库、恢复和校验演练。
- migration 失败时有明确回滚或向前修复步骤。

## 8. 步骤 5：完成 B-03 微信登录和会话

### 接口

- `POST /api/v1/session/wechat`；
- `POST /api/v1/session/refresh`；
- `DELETE /api/v1/session/current`；
- `GET /api/v1/me`。

### 操作

1. X 调用 `wx.login` 获得一次性code。
2. B使用服务端AppSecret向微信换取身份。
3. B映射或创建业务`userId`。
4. 返回短期access token和可轮换refresh token。
5. refresh token只存摘要；轮换后旧token重放必须拒绝并记录安全事件。
6. 支持退出、会话撤销、账号禁用和token过期。
7. `GET /me`返回业务用户信息，不直接暴露openid。

### 验收

- 正常、过期、重复、伪造code均有测试。
- access token过期、refresh轮换、重放和撤销均有测试。
- dev/test身份不能进入生产数据域。

## 9. 步骤 6：建立批量管道并导入版本化内容

### 操作

1. 按 `docs/批量音频字幕导入架构-v1.md` 建立 `incoming/quarantine/processing/ready/published/rejected` 存储边界。
2. 实现管理员批次、预签名分片上传、完成上传、批次 finalize、状态查询、重试、取消、发布和回滚接口。
3. 上传方直接写对象存储；API 只签发受限地址并记录会话，不接收或转发整段音频。
4. 上传完成后写入任务队列；Worker 校验 MIME、文件头、大小、SHA-256 和安全扫描结果。
5. 音频通过 ffprobe/FFmpeg 探测与处理；字幕解析为统一 cue schema 并校验顺序、重叠和音频边界。
6. 任务必须幂等，临时错误指数退避，不可重试错误进入隔离区，超限任务进入死信队列。
7. 从 Peter Rabbit `dist/` 读取 metadata、manifest、cues、vocab 和 quiz，作为第一批端到端样本。
8. 校验 `workId=peter-rabbit`、`pieceId=peter-rabbit-01`、`contentVersion=1`、`quizVersion=1`。
9. 音频、正文、字幕、词表、Quiz 和封面必须作为同一版本组装 manifest；任一必需资产失败时不发布该版本。
10. test 环境可导入候选数据，但保持 `publishable:false`；Worker 不得自行提升发布状态。
11. 记录导入操作者、来源提交 SHA、工具与参数版本、输入/输出哈希、时间和结果。
12. 批量压测后记录每小时文件数、总 GB、最大单文件、处理时延、CPU、内存、临时磁盘和成本估算。

### 验收

- 任一资产哈希不一致时整批失败。
- 不允许静默覆盖同一内容版本。
- C-03/C-05未关闭时不能通过后台改成正式发布。
- 数百个文件批量导入时，API 内存不随文件总大小线性增长。
- 分片中断可续传，重复消息不重复处理，Worker 中途退出后任务可安全接管。
- 单文件失败可定位和重试；同一 piece 版本仍保持整体原子发布。
- 字幕乱码、时间倒序/越界和损坏音频均返回稳定错误码。

## 10. 步骤 7：完成 B-04 内容 API 与资源鉴权

### 接口

- `GET /api/v1/works`；
- `GET /api/v1/works/:workId`；
- `GET /api/v1/pieces/:pieceId/manifest`。

### 操作

1. works使用不透明cursor分页。
2. work详情返回piece列表、版本和可用状态。
3. manifest返回版本、资源类型、SHA-256和短期资源URL。
4. 受限资源存放在私有对象存储。
5. 短期URL必须包含过期时间，并定义客户端刷新方式。
6. 内容版本失效时返回稳定错误码。
7. 发布、回滚、CDN缓存失效和manifest哈希必须一致。

### 验收

- 未授权用户不能通过永久URL绕过API。
- 过期URL、错误版本、已撤回内容和重复请求都有测试。

## 11. 步骤 8：完成服务端 Quiz 判题

### 接口

- `POST /api/v1/me/quiz-attempts`。

### 操作

1. 按现有Quiz v1契约接收attempt ID、版本、题目ID和逐题选择。
2. 用服务端题库判分，不接收客户端可信score或mastery。
3. 以`userId + attemptId`保证幂等。
4. 校验内容版本、题包版本、题目集合和选项范围。
5. 成功记录为`server_verified`；错误版本或非法答案返回`rejected`。
6. 排行和正式报告只消费服务端验证记录。

### 验收

- 相同attempt重复提交返回同一结果。
- 修改客户端score不能改变服务端结果。
- 版本失效、缺题、多题和越界选项均有契约测试。

## 12. 步骤 9：冻结 B-06 排行规则

### 当前UI输入

- 校区：`a`、`b`；
- 周期：`rolling_7d`、`calendar_week`、`calendar_month`、`calendar_year`；
- 具体周：ISO周键，例如`2026-W39`；
- 具体月：月份键，例如`2026-09`；
- 年级：`all`、`k`、`1`～`9`；
- 阅读级别：`all`、`1`～`5`。

### 必须冻结的业务规则

1. 业务时区建议固定为`Asia/Shanghai`。
2. `rolling_7d`是请求时刻向前连续7×24小时。
3. `calendar_week`为周一00:00至下周一00:00，使用ISO周键。
4. `calendar_month`为自然月；`calendar_year`为自然年。
5. 校区、年级和阅读级别以服务端已验证用户档案为准。
6. 当前可信来源只能是`server_verified` Quiz attempt。
7. 主排名指标为服务端计算的0～1000整数综合分`rankingScore`，规则版本为`quiz-score-v1`。
8. 综合分按同一筛选人群内的百分位计算：完成不同书本30%、阅读词量15%、贝叶斯校正正确率25%、挑战度15%、进步幅度10%、题材广度5%。完整公式见`backend/docs/adr/0003-ranking-score-v1.md`。
9. 每本书只采用周期内第一次合法`server_verified` Quiz attempt进入算法，避免重复刷题；重做记录仍可在明细页查看。
10. 同分使用并列名次；少于10名合格用户返回`cohort_too_small`，不返回可识别用户列表。
11. 不展示真实姓名，默认使用匿名显示名；后续若使用昵称，必须取得明确同意。
12. 样本不足时不生成虚假用户、分数或名次。

### 已确认算法

- 完整决策、公式、缺失数据处理和反刷分约束见`backend/docs/adr/0003-ranking-score-v1.md`。
- 正确率是六项输入之一，不等于最终排名分。
- 校区、年级和阅读级别变更默认从下一个完整榜单周期生效；历史不可变快照不重写。

## 13. 步骤 10：实现排名存储和聚合

### 操作

1. 校区和用户档案变更必须有审计记录。
2. Quiz attempt验证成功后发布内部聚合事件或进入重算队列。
3. 聚合任务按规则版本生成或刷新快照。
4. 快照记录`campusId`、周期类型、周期键、grade、level、规则版本和生成时间。
5. 支持从原始服务端attempt全量重算，不能只依赖不可恢复的增量计数。
6. 用户档案变更时定义从何时起进入新分组，不偷偷改写历史榜单。
7. 样本不足时只返回状态和门槛，不返回可识别用户列表。

### 验收

- 重复消费事件不重复计分。
- 同一原始数据重算得到相同结果。
- A/B、K～9和Lv 1～5的组合不会发生跨组泄漏。

## 14. 步骤 11：实现排名 API

### 选项接口

`GET /api/v1/ranking-options`

返回：

- 可用校区；
- 可用周期类型；
- 可选周、月和年；
- 年级、阅读级别；
- 业务时区；
- 最低样本量和规则版本。

### 榜单接口

`GET /api/v1/rankings`

查询参数：

- `campusId=a|b`；
- `periodType=rolling_7d|calendar_week|calendar_month|calendar_year`；
- `periodKey`：周榜使用`YYYY-Www`，月榜使用`YYYY-MM`，年榜使用`YYYY`；滚动7日不传；
- `grade=all|k|1..9`；
- `level=all|1..5`；
- `cursor`、`limit`。

响应至少包含：

- `status=ready|unavailable|cohort_too_small`；
- 规范化后的筛选条件；
- `windowStart`、`windowEnd`、`timezone`；
- `ruleVersion`、`generatedAt`；
- 名次、匿名展示名和服务端计算指标；
- 当前用户自己的名次，仅在有资格且样本门槛允许时返回；

### 排名Quiz明细接口

`GET /api/v1/rankings/{participantId}/quizzes`

使用与榜单相同的校区、周期、年级和级别参数，返回同一不可变快照中的：

- `rankingScore`和六项得分拆解；
- 完成/全部书目、词数、平均正确率、平均级别和Fiction占比；
- 分页的书名、系列、作者、作答时间、正确率、级别、类别和词数；
- 不返回逐题答案、手机号、微信身份或真实姓名字段。
- 下一页cursor。

### 验收矩阵

1. A/B两个校区。
2. 7日、自然周、自然月、自然年。
3. 当前周、历史周、当前月、历史月。
4. All、Kindergarten、Grade 1～9。
5. All Levels、Lv 1～5。
6. 无数据、样本不足、非法periodKey、未来周期、无效校区。
7. 分页稳定、并列稳定、重复请求结果稳定。
8. 未登录、无档案、被禁用用户和撤回attempt。

## 15. 步骤 12：完成 B-05 日志、监控和审计

### 操作

1. 每个请求记录`requestId`、路由、状态码、耗时和稳定错误码。
2. 登录、内容、Quiz、排行查询、内容导入和回滚均可审计。
3. 指标至少覆盖错误率、P95延迟、登录成功率、资源失败率、Quiz拒绝率、排名聚合延迟和聚合失败数。
4. 导入指标覆盖上传完成率、分片失败率、队列深度、最老等待时长、重试/死信、处理阶段耗时、Worker 资源、对象容量和审核积压。
5. 定义告警阈值、负责人和处理手册。
6. dev/test/prod日志完全隔离。
7. 排名查询日志只记录筛选条件和结果数量，不记录用户答案或完整个人档案。
8. `requestId`、`batchId`、`itemId`、`jobId` 和 `contentVersionId` 可串起导入链路；普通日志不记录预签名 URL。

### 验收

- 能用一个`requestId`串联客户端报错、API日志和后台任务。
- openid、token、手机号、答案和密钥不会出现在普通日志。

## 16. 步骤 13：安全、备份和回滚

### 操作

1. 对登录、刷新、Quiz写入和排行查询分别设置限流。
2. 对写接口使用幂等键或业务唯一键。
3. 数据库定期备份，记录RPO/RTO。
4. 演练数据库恢复、应用回滚和内容版本回滚。
5. 对象存储使用最小权限；签名密钥定期轮换。
6. 对象存储开启版本化或等价保护；中间产物、未完成分片和过期会话有生命周期清理。
7. Redis 队列不作为事实来源；数据库恢复后可找出未完成任务并安全重建队列。
8. 依赖扫描、密钥扫描和上传类型/大小限制进入CI与运行时校验。

### 验收

- 保存一次完整恢复演练记录。
- 回滚不会把`publishable:false`内容错误发布。
- 旧契约版本的支持和弃用策略有记录。

## 17. 步骤 14：X/B 联调

### 顺序

1. B发布契约版本和提交SHA。
2. X生成或编写API客户端，加入base URL和token管理。
3. X接入微信登录、刷新、退出和`GET /me`。
4. X接入works、work和manifest。
5. X接入Quiz提交，保留离线时的`local_unverified`状态。
6. X接入`ranking-options`和`rankings`，将现有A/B、周期、周/月、年级和级别控件映射为服务端参数。
7. 服务不可用、样本不足或未登录时继续显示真实空状态。
8. 双方验证超时、弱网、401刷新、重复提交、版本失效和分页。

### 验收

- X不包含AppSecret或后端密钥。
- 客户端修改本地score、校区或年级不能改变服务端排名。
- 固定契约版本的全部契约测试通过。

## 18. 步骤 15：后端交付

最终交付必须包含：

- B分支名称、`handoffBaseCommit`和交付提交SHA；
- 契约版本和变更记录；
- `backend/README.md`；
- ADR、OpenAPI、JSON Schema和错误码表；
- migrations、seed和恢复记录；
- local/dev/test部署说明；
- session、content、Quiz和ranking测试；
- ingestion、multipart upload、Worker、失败重试、死信、原子发布和批量压测记录；
- 日志、指标、告警和回滚说明；
- 测试身份获取方式，不在文档中填写真实密钥；
- 未完成项、风险和下一阶段建议。

只有客户端能够按文档独立启动、调用、复现错误并通过契约测试，才算完成交付。
