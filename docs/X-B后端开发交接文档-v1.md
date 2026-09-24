# 听阅 X 客户端 → B 后端开发交接文档 v1

> 交接日期：2026-09-24
> 文档状态：当前交接基线
> 交接范围：`X` 客户端与 `B-01`～`B-06` 后端基础
> X 负责人：客户端负责人
> B 负责人：后端同事
> 当前发布结论：阶段 0 **NO-GO**

## 1. 目的与使用方式

本文是后端同事可以直接执行的交接合同，不是项目宣传或概念说明。它回答以下问题：

- X 客户端已经完成什么、还缺什么；
- B 后端本轮必须实现什么、不得越界实现什么；
- 哪些 ID、版本、可信边界和接口语义已经冻结；
- 两条长期平行分支如何共享唯一接口契约；
- 每个 B 任务怎样才算完成并可交给 X 联调。

执行优先级：本交接文档解释 X/B 边界；任务状态和发布门槛仍以 `docs/正式产品实施计划-v1.1.md` 与 `docs/阶段0核验表-v1.0.md` 为准。发生冲突时不得自行猜测，应由双方共同确认并同步文档。

## 2. 本轮范围和明确排除项

### 2.1 本轮实施范围

本轮后端只实施主计划中的：

- `B-01` 环境与技术选型；
- `B-02` 数据库与迁移；
- `B-03` 微信登录会话；
- `B-04` 内容 API 与资源鉴权；
- `B-05` 日志、监控与运营后台基础；
- `B-06` 真实排行聚合与筛选。

第一批可联调接口只包含：

- `POST /api/v1/session/wechat`；
- `POST /api/v1/session/refresh`；
- `DELETE /api/v1/session/current`；
- `GET /api/v1/me`；
- `GET /api/v1/works`；
- `GET /api/v1/works/:workId`；
- `GET /api/v1/pieces/:pieceId/manifest`；
- `POST /api/v1/me/quiz-attempts`；
- `GET /api/v1/ranking-options`；
- `GET /api/v1/rankings`；
- `GET /api/v1/rankings/:participantId/quizzes`；
- 健康检查、稳定错误码、请求追踪和审计日志。

### 2.2 本轮不包含

- `S-01`～`S-04` 学习数据导入、日常同步、冲突合并和双设备验收；
- `P-01`～`P-05` 商品、订单、支付、权益、退款和对账；
- 正式生产环境启用；
- 把 Peter Rabbit 候选内容改成可发布；
- 为通过检查而伪造账号、成绩、排行、权益、审核或真机证据。

`B-02` 可以为 `reading_progress`、`saved_words`、`orders`、`entitlements` 预留表结构或迁移顺序，但本轮不得把它们误报为已经开放的业务能力。

## 3. Git 与契约治理

### 3.1 平行分支模型

- `peter`：X 客户端长期开发线，由客户端负责人维护；
- B 后端分支：由后端同事在取得最新版 `peter` 和本文后自行新建，作为与 `peter` 地位平行的长期后端开发线；
- 不复用旧的 `feature/peter-rabbit-content-pipeline`；
- 本交接不要求把整个后端分支 PR 合并回 `peter`；
- 后端工程放在新分支的 `backend/` 目录；
- 新分支建立后必须记录取得交接材料时的 `peter` 提交 SHA，字段名为 `handoffBaseCommit`。

禁止使用 `--allow-unrelated-histories` 强行合并旧历史，也不得强制推送覆盖对方分支。

### 3.2 唯一接口契约来源

B 分支是以下产物的权威来源：

- OpenAPI 3.1 文档；
- JSON Schema；
- 稳定错误码表；
- 数据库迁移；
- 后端契约测试；
- 契约版本和弃用记录。

`peter` 保存本文、客户端适配器和客户端契约测试。X 联调时必须固定以下两项，不能只写“最新版本”：

- 后端契约版本，例如 `api-contract-v1.0.0`；
- 对应 B 分支提交 SHA。

任何字段删除、类型变化、鉴权语义变化、错误码变化或版本失效规则变化都属于破坏性变更，必须由 X/B 双方确认。不得只在一条分支静默修改。

## 4. 当前 X 客户端真实状态

| 任务 | 状态 | 已有事实 | 尚缺 |
| --- | --- | --- | --- |
| X-01 播放器跨页状态 | `DONE` | 全局后台音频会话、跨页继续、返回接管、用户暂停保护、倍速、循环和系统媒体事件已实现并测试 | 无代码缺口 |
| X-02 断点与可靠完成 | `PARTIAL_DEVICE_PENDING` | 可信断点、收听区间合并、真实墙钟计时、版本失效、异常后台采样拒绝已实现 | 微信真机后台、锁屏、系统控制和可信时长证据 |
| X-03 正式点词 | `DONE` | 358 个审核义项覆盖 Peter Rabbit 全文 906 个可点击 token；上下文拆义和播放意图已测试 | 无代码缺口 |
| X-04 Quiz/报告/排行边界 | `DONE_LOCAL_TEST` | 版本化attempt、本机未验证标签、旧记录隔离、服务端判题、`quiz-score-v1`算法排行、A/B校区与周期/年级/级别筛选及参与者Quiz明细已接入 | 真实微信账号和真机联调待外部资料 |
| X-05 正式/Demo 隔离 | `PARTIAL` | production/Demo 可复现双构建；正式包物理排除 Demo 能力且只含 Peter Rabbit；开发版本 `0.1.1` 已上传 | 微信基本资料初始化、体验版设置、Android/iPhone 体验版与正式版证据 |

当前自动基线为小程序`npm test` 62/62、后端`npm run check` 38/38通过；真实Fastify+PostgreSQL的X/B联调也已通过。自动检查不能代替真机、账号、权利、隐私和上线资格。

### 4.1 当前客户端网络能力与缺口

仓库已有`miniprogram/services/api.js`和`config/api.js`：

- 使用`wx.request`调用固定`api-contract-v1.0.0`；
- 使用`wx.login`获取code，AppSecret只在服务端；
- 保存access/refresh token，401时最多刷新一次并重试；
- 映射稳定错误码，接入内容、Quiz、算法排行和排行明细；
- develop环境可显式配置本机API与stub code，体验版/正式版不得使用stub。

尚未实现完整跨设备同步队列/冲突合并，也没有真实订单、支付或权益。真实微信凭据、合法域名和Android/iPhone真机联调仍待外部资料。`miniprogram/services/host.js`继续负责本地存储、导航和离线回退，不是HTTP客户端。

## 5. 已冻结的身份、版本与内容边界

### 5.1 稳定身份

| 对象 | 冻结值 |
| --- | --- |
| `workId` | `peter-rabbit` |
| `pieceId` | `peter-rabbit-01` |
| `contentVersion` | `1` |
| `quizVersion` | `1` |
| 旧客户端 ID | `peter`，只允许用于迁移，不能成为服务端新主键 |

购买和未来权益按 work；听读进度、Quiz、字幕、词表和缓存按 piece。

### 5.2 内容成套发布原则

音频、正文、字幕、词表、Quiz、封面和资源校验值必须按 `pieceId + contentVersion` 成套发布。任一资产变化必须升版，不能静默替换同一版本内容。

当前候选输入：

- `content/peter-rabbit/peter-rabbit-01/dist/metadata.json`；
- `content/peter-rabbit/peter-rabbit-01/dist/manifest.json`；
- `content/peter-rabbit/peter-rabbit-01/dist/cues.json`；
- `content/peter-rabbit/peter-rabbit-01/dist/vocab.json`；
- `content/peter-rabbit/peter-rabbit-01/dist/quiz.json`；
- manifest 中记录的资产 SHA-256。

当前内容仍为 `publishable:false`。C-03 外部权利审核与 C-05 发布门槛未关闭前，B 端不得自行改为已发布或生产可售。

## 6. API 通用规范

第一版契约统一使用：

- API 前缀：`/api/v1`；
- 传输：HTTPS；
- 媒体类型：`application/json`；
- JSON 字段：`camelCase`；
- 时间：UTC RFC 3339，例如 `2026-09-24T03:00:00.000Z`；
- 服务端 ID：不可猜测的 UUID 或等价高熵随机 ID；
- 分页：不透明 cursor；
- 金额：未来使用整数最小货币单位，本轮不启用金额接口；
- 每个响应返回或在响应头携带 `requestId`；
- 错误必须提供稳定 `error.code`，不能要求客户端解析人类文案；
- 客户端重试可能重复提交，写接口必须具备幂等设计。

建议通用错误结构由 B-01 契约评审冻结，例如：

```json
{
  "requestId": "request-id",
  "error": {
    "code": "STABLE_ERROR_CODE",
    "message": "面向用户或开发者的说明",
    "retryable": false,
    "details": null
  }
}
```

该示例不是已冻结 Schema；最终以 B 分支经双方确认的 OpenAPI 为准。

## 7. 信任边界

### 7.1 客户端本地数据不是服务端事实

本地键 `tingyue.product.v1` 当前可能包含：

- `favorites`；
- `recent`；
- `progress`；
- `results`；
- `listeningSec`；
- `listenDaily`；
- `words`；
- `idMigrationVersion`；
- `progressSchemaVersion`。

这些字段只能作为以后 `S-01` 一次性迁移的输入。服务端不得直接信任客户端提交的：

- `completed`；
- `coverage`；
- `listeningSec`；
- Quiz `score` 或 `mastery`；
- 排名、购买状态、优惠券、邀请奖励或 Demo 权益。

### 7.2 当前可靠收听语义

客户端进度 schema 为 `2`，包含可信断点、收听区间、版本和音频身份。当前完成判定为：

1. 音频自然结束；
2. 唯一收听覆盖率至少 90%；
3. 最后 3 秒已实际收听。

拖动到结尾不能完成；异常后台长间隔不能计时；版本或音频身份变化必须使旧断点失效。未来 S 阶段必须单独冻结服务端可信增量和冲突合并协议，B 本轮不得自行把完整客户端进度对象当作权威写入。

## 8. Quiz Attempt v1

现有冻结契约以 `backend/contracts/openapi.json` 及其引用的 JSON Schema 为准。接入 `/api/v1` 后的正式地址为：

`POST /api/v1/me/quiz-attempts`

关键规则：

- 客户端提交 `attemptId`、内容/题包版本、题目 ID、逐题选项和起止时间；
- 服务端按 `attemptId + userId` 幂等；
- 服务端从自己的版本化题库判分；
- 客户端不得提交可信 score、mastery 或排名；
- 成功结果为 `server_verified`；
- 版本失效、题目集合错误或选项越界返回 `rejected` 和稳定错误码；
- HTTP 200、本机分数或网络成功均不能由客户端自行升级为 `server_verified`；
- 排行只使用服务端验证结果。

B 端实现前必须把现有 Markdown 契约转成 OpenAPI/JSON Schema，并补齐拒绝响应、重复提交和版本失效测试。

## 9. B-01 环境与技术选型

### 9.1 必须决策

- 后端语言与框架；
- 关系型数据库及版本；
- 云供应商与中国大陆目标地域；
- 对象存储/CDN、预签名分片直传和生命周期；
- 队列、重试/死信和独立内容处理 Worker；
- FFmpeg/ffprobe，以及可选 Python ASR/对齐 Worker 的边界；
- dev/test/prod 环境边界；
- API 与资源域名；
- 微信合法域名配置；
- 密钥管理方式；
- CI、部署、迁移和回滚方式；
- 预算上限、运维负责人和告警渠道。

### 9.2 当前允许范围

只实施 local/dev/test 和可重复部署方案。生产配置只提交无密钥模板；阶段 0 `GO` 前不部署或启用生产服务。

建议基线为 Node.js 24 LTS + TypeScript + Fastify、PostgreSQL、Redis/BullMQ、MinIO/S3 兼容对象存储、FFmpeg/ffprobe 和可选 Python Worker。该建议必须在 B-01 ADR 中由双方确认后才算冻结。音频文件不得存入 PostgreSQL，也不得由 API 服务器代理整文件上传。详细设计见 `docs/批量音频字幕导入架构-v1.md`。

### 9.3 B-01 交付物

- `backend/README.md`；
- 架构决策记录；
- OpenAPI 3.1 初稿；
- JSON Schema 和错误码表；
- `.env.example`，只含变量名和安全说明；
- local/dev/test 启动与部署命令；
- `handoffBaseCommit`、契约版本和 B 分支提交 SHA。

## 10. B-02 数据库与迁移

### 10.1 本轮核心对象

- `users`：业务用户主键、最小化微信身份映射、状态、时间戳；
- `user_sessions`：refresh token 摘要、设备/会话状态、过期与撤销；
- `campuses`、`user_profiles`：稳定校区、年级、阅读级别及其可信来源；
- `works`、`pieces`：稳定 ID、版本、发布状态、免费/付费属性；
- `content_assets`：piece、内容版本、存储 key、SHA-256、状态；
- `content_versions`、`content_reviews`：整套版本、审核门槛、发布指针和回滚；
- `ingestion_batches`、`ingestion_items`：批次和每个文件的声明、状态及结果；
- `upload_sessions`：预签名分片上传、对象 key、预期哈希和过期状态；
- `processing_jobs`、`processing_artifacts`：Worker 任务、重试/死信和产物关系；
- `quiz_packages`：题包版本和题目集合；
- `quiz_attempts`：用户、piece、版本、逐题选择、服务端结果、时间；
- `ranking_snapshots`：周期、校区、年级、级别、规则版本、聚合结果和生成时间；
- `audit_events`：操作者、动作、目标、前后版本、requestId 和时间。

可为未来阶段预留但本轮不开放 API：

- `reading_progress`；
- `saved_words`；
- `orders`；
- `entitlements`。

### 10.2 迁移完成定义

- schema、唯一索引、外键和幂等键明确；
- migration 可从空库重复执行；
- migration 有自动测试；
- seed 只包含测试或明确候选数据；
- 升级和回滚路径明确；
- 完成一次备份与恢复演练并保存记录；
- 不把 openid、token、答案或个人信息写入普通调试日志。

## 11. B-03 微信登录会话

### 11.1 登录流程

1. X 调用 `wx.login` 获取一次性 code；
2. X 将 code 发送至 `POST /api/v1/session/wechat`；
3. B 在服务端使用安全保存的 AppSecret 换取微信身份；
4. B 映射或创建业务 `userId`；
5. B 返回短期 Bearer access token 和可轮换 refresh token；
6. X 使用 access token 调用 `GET /api/v1/me`；
7. B 支持过期、刷新、撤销、退出和账号禁用。

AppSecret、openid 映射、refresh token 原文和服务器密钥不得进入客户端、Git 或普通日志。生产构建不得恢复 Demo 固定验证码登录路径。

### 11.2 必测场景

- code 正常、过期、重复使用和伪造；
- access token 过期；
- refresh token 轮换与重放；
- 会话撤销和账号禁用；
- dev/test 身份不能进入生产环境；
- 日志和错误响应不泄露微信身份或密钥。

## 12. B-04 内容 API 与资源鉴权

### 12.1 内容读取

必须实现并在 OpenAPI 冻结：

- works 列表与游标分页；
- work 详情；
- piece manifest；
- 内容版本、发布状态和资源校验值；
- 免费试读与受限资源边界；
- 客户端版本不兼容和内容版本失效错误。

### 12.2 资源鉴权

- 受限正文和音频放私有对象存储；
- B 根据用户、work、piece、版本和未来权益签发短期 URL；
- URL 必须有过期和刷新协议；
- 未授权用户不能通过永久公开地址绕过 API；
- 当前 Archive.org 音频地址只能作为候选来源，不能作为未来付费资源的鉴权机制；
- 发布、回滚、缓存失效和 manifest hash 必须一致。

### 12.3 批量内容导入

- 管理端或受控导入 CLI 先创建批次，再通过短期预签名地址把音频、字幕等文件分片直传对象存储；
- API 只负责控制面，完成上传后把任务写入 Redis/BullMQ；独立 Worker 负责哈希、格式、安全、音频探测/转码、字幕解析和版本组装；
- 首版管理员接口包括批次创建/查询、上传会话创建/完成、批次 finalize、失败重试、取消、发布和回滚；
- PostgreSQL 只保存元数据、任务和审计；原始文件、中间产物和发布资产进入不同存储前缀；
- 同一 piece 版本必须原子发布，任何必需资产失败都不能让客户端读取半成品；
- C-03/C-05 未关闭时，处理成功也只能进入待审核状态，不能把 `publishable:false` 提升为已发布。

### 12.3 发布限制

B 可以导入测试环境候选数据，但不得：

- 把 `publishable:false` 改成 true；
- 将候选内容暴露为生产商品；
- 在 C-03/C-05 未关闭时形成正式发布入口。

## 13. B-05 日志、监控与运营基础

最低要求：

- 每个请求有 request/trace ID；
- 登录、内容查询、manifest 获取、Quiz 验证、内容发布与回滚可审计；
- 指标至少覆盖错误率、延迟、资源失败率、登录成功率和 Quiz 拒绝率；
- 排行聚合延迟、失败率、快照版本和重算结果可观测；
- 定义告警阈值、告警渠道和负责人；
- dev/test/prod 日志和监控隔离；
- 定义日志保存期限；
- 内容操作记录操作者、时间、目标、前后版本和回滚关联；
- openid、token、手机号、用户答案和密钥默认脱敏或不记录。

本轮运营基础可以先提供受控管理命令或最小内部界面，但不能把无鉴权的管理端点暴露到公网。

## 14. S 与 P 的预留边界

### 14.1 S 学习同步

后续必须单独冻结：

- `POST /api/v1/me/local-import`；
- 阅读进度可信增量 schema；
- 生词新增/删除版本；
- 离线批量队列、幂等和重试；
- 多设备冲突合并；
- 服务端版本和时间戳。

本轮只保证表结构不会阻止未来实现，不开放未冻结接口。

### 14.2 P 支付权益

P 阶段只有在阶段 0 `GO` 后才能实施或启用。未来价格、支付状态、权益、退款和内容发布状态必须以服务端为权威。客户端支付 success 回调不得直接解锁权益。

## 15. 联调顺序

1. B-01：冻结技术选择、环境、通用 API 规范和契约版本；
2. B-02：完成数据库、迁移、测试种子和恢复演练；
3. B-03：完成微信登录、会话与 `GET /me`；
4. B-04：先完成批量直传、队列、Worker 和版本化导入，再完成 works、work、manifest 和测试环境资源鉴权；
5. Quiz：按现有 v1 契约实现服务端判题；
6. B-06：冻结排行规则，完成校区、周期、年级、级别筛选和可信聚合；
7. B-05：补齐日志、指标、告警、审计与回滚；
8. B 发布固定契约版本和提交 SHA；
9. X 在 `peter` 添加网络适配器和客户端契约测试；
10. 双方在 test 环境完成错误、过期、重试、幂等和版本失效联调；
11. 更新主计划状态，但阶段 0 未 `GO` 前不启用生产。

逐项输入、操作、产物、测试和验收矩阵见 `docs/B后端详细实施步骤-v1.md`。

## 16. 每个 B 任务的完成定义

“接口能跑”不等于完成。每个任务必须同时具备：

- 对应任务 ID 和明确范围；
- OpenAPI/JSON Schema 与实现一致；
- 自动单元、集成和契约测试；
- migration 可重复且有回滚/恢复说明；
- 密钥不入库；
- 日志脱敏；
- 稳定错误码和 requestId；
- local/dev/test 可部署；
- 故障、超时、重复提交和恢复路径已验证；
- 客户端可复现的联调步骤；
- 契约版本、B 分支提交 SHA 和变更记录。

## 17. 后端交付清单

首次交付至少包含：

- [ ] 后端分支名称与 `handoffBaseCommit`；
- [ ] `backend/README.md`；
- [ ] 架构决策记录；
- [ ] OpenAPI 3.1；
- [ ] JSON Schema；
- [ ] 错误码表；
- [ ] `.env.example`；
- [ ] 数据库 migrations 与 migration 测试；
- [ ] local/dev/test 启动和部署说明；
- [ ] session、content、Quiz、ranking 的自动测试；
- [ ] 审计日志、指标和告警说明；
- [ ] 备份、恢复和回滚记录；
- [ ] 契约版本与 B 分支提交 SHA；
- [ ] 给 X 的联调账号/测试身份获取方式，不在文档中填写真实密钥。

## 18. X 侧接收清单

客户端负责人收到 B 交付后：

- [ ] 核对固定契约版本和 SHA；
- [ ] 在 `peter` 新增正式 API 适配器，不修改 Demo 模块冒充正式实现；
- [ ] 接入 `wx.login`、会话刷新与退出；
- [ ] 接入内容列表、详情和 manifest；
- [ ] 接入 Quiz 服务端验证并保留 `local_unverified` 降级状态；
- [ ] 接入 ranking options 和 rankings，将校区、周期、周/月、年级和级别控件映射为契约参数；
- [ ] 对所有稳定错误码建立 UI 行为；
- [ ] 增加契约测试、弱网、过期、重试和版本失效测试；
- [ ] 保持 production/Demo 物理隔离；
- [ ] 不在客户端写入 AppSecret、服务端密钥或生产 refresh token 明文日志。

## 19. 当前未决输入

以下事项仍需项目负责人或双方后续确认，本文不虚构答案：

- B 新分支的实际名称；
- 云供应商、地域、预算和运维负责人；
- API/资源域名与微信合法域名；
- 后端语言、框架和数据库；
- access/refresh token 具体有效期；
- 日志保存期限和告警渠道；
- 排名指标、并列规则、最小样本量、用户展示名和档案变更生效规则；
- 小程序主体、类目、隐私和未成年人方案；
- C-03 外部权利签署与 C-05 发布结论；
- S、P 阶段的正式排期和负责人。

## 20. 参考索引

- `docs/正式产品实施计划-v1.1.md`；
- `docs/阶段0核验表-v1.0.md`；
- `backend/contracts/openapi.json`；
- `docs/B后端详细实施步骤-v1.md`；
- `docs/X-02真机验收记录-template.md`；
- `docs/X-05体验版正式版验收记录-template.md`；
- `miniprogram/services/host.js`；
- `miniprogram/modules/listen-read/player.js`；
- `miniprogram/modules/quiz/attempts.js`；
- `content/peter-rabbit/peter-rabbit-01/dist/manifest.json`；
- `artifacts/build/X-05-release-audit.json`；
- `artifacts/device/X-client-upload-0.1.1.json`。

## 21. 交接确认记录

| 项目 | 记录 |
| --- | --- |
| 交接文档版本 | v1 |
| X 负责人确认 | 2026-09-24 已确认采用建议技术基线和分支方案 |
| B 负责人确认 | Codex 按确认内容开始实施，后续由实际后端负责人复核签署 |
| B 分支名称 | `backend/v1` |
| `handoffBaseCommit` | `7b882b22bfcf535cf2677616cfa82b6bb3d8a70e` |
| 首个契约版本 | `api-contract-v1.0.0`（2026-09-24 工作区校验通过） |
| B 契约提交 SHA | 待实际创建 B 分支提交后填写；当前未擅自提交用户工作区改动 |
| 联调开始日期 | 待双方确认 |
