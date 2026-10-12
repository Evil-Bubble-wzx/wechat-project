# API 契约

当前权威版本：`api-contract-v2.9.0`

- `openapi.json`：OpenAPI 3.1 路由、鉴权、状态码、分页和幂等语义。
- `schemas/api-v1.schema.json`：JSON Schema 2020-12 请求与响应模型。
- `errors.v1.json`：客户端可依赖的稳定错误码。客户端不得解析 `message` 判断流程。
- `examples/`：由自动测试逐个校验的请求、响应和错误示例。

## 版本规则

契约标签使用 `api-contract-vMAJOR.MINOR.PATCH`：

- `PATCH`：只修正文档或示例，不改变可观察行为。
- `MINOR`：只新增向后兼容的接口、可选字段或错误码。
- `MAJOR`：删除字段、改变类型或必填性、改变鉴权/幂等/版本失效语义、删除或重定义错误码。

破坏性变更必须由 X/B 双方确认，发布新 MAJOR，并保留迁移与弃用记录。每次 X/B 联调必须同时固定契约标签和 B 分支提交 SHA，不能引用“最新版本”。

## v2 迁移记录（2026-10-10）

积分数值由 JSON 数字改为十进制整数字符串，旧 0～1000 公式被累计学习积分取代；客户端与后端必须成对更新，路径仍为 `/api/v1`。新增 `/me/learning-score` 及进度/Quiz 回执摘要，期间榜支持年榜。0010 历史回填只进入累计。Quiz 重提的答卷/判分保持幂等，附带累计积分摘要为新读取，其 `asOf` 可变化；进度 mutation 的幂等回执仍完整重放。

## 通用约束

- 业务前缀为 `/api/v1`；JSON 使用 `camelCase`；时间使用 UTC RFC 3339。
- 每个响应携带 `X-Request-Id`；业务响应体也携带 `requestId`。
- 所有写操作要求 `Idempotency-Key`。相同键和相同请求返回原结果；相同键和不同请求返回 `IDEMPOTENCY_KEY_REUSED`。
- Access token 使用 Bearer 传输；微信 code、token、预签名 URL 和用户答案不得进入普通日志。
- 列表使用不透明 `cursor`，客户端不得解析或拼装 cursor。
- 排行主指标为服务端确认的 `rankingScore`，单位 `points`，以十进制整数字符串传输，不设业务积分上限；客户端不得自行计算或上传可信排名分。当前规则为 `learning-points-v2`，见 [ADR 0004](../docs/adr/0004-learning-points-v2.md)。旧 `quiz-score-v1` 仅作为历史规则与快照保留。
- 管理端上传接口只传控制面元数据，文件字节通过短期预签名地址直传对象存储。

## 动态目录和资源

2.2 客户端可读取书目/章节元数据与服务端测量时长。书目未知字段为 null；作品总词数或时长在任一章节缺失时保持未知。搜索游标绑定 query/category；available 指免费数字章节可阅读，不是实体库存。作品的作者、系列和分类投影来自首个当前已发布章节。

客户端必须加载同一个 pieceId/contentVersion 的七种资源；阅读 JSON 校验字节数、摘要、身份和题包版本。2.6 Worker 支持把 UTF-8 VTT/SRT 自动规范化为阅读 JSON，原文件不能直接混入 manifest。已存在的旧版本需重新验证并补齐元数据、真实音频时长和同版本题包后，才可用于这条动态链路。

## 原始字幕导入

字幕声明可使用 application/json（最多 8 MiB）、text/vtt 或 application/x-subrip（最多 100 MiB）；text/plain 和 application/octet-stream 仅在文件名以 .vtt/.srt 结尾时按对应格式处理，不猜测任意文本格式。Worker 先流式核对原始字节大小与 SHA-256，再按 UTF-8 逐行解析；行和 cue 各限 65,536 字符，输出 JSON 最多 8 MiB，超限须按章节拆分。无数据库迁移或新阅读接口。

转换保留文字、毫秒起止时间、VTT 标识符；SRT 数字序号映射为 c 前缀标识。支持 BOM、LF/CRLF/CR、多行和常见呈现标签/字符实体。备注、样式、区域、排版设置和 cue 内时间标记只计入 discardedPresentation，不执行或用于词级同步；converterVersion 为 timed-subtitles-v1。原文件保存在 incoming，ready JSON 的 parent_artifact_id 指向 original，验证信息保存原摘要/大小/MIME 和转换记录。

本功能是单轨旁白阅读转换，不是完整 WebVTT 排版器；结构与时间戳参考 [W3C WebVTT](https://www.w3.org/TR/webvtt1/)。Ruby、未知标记/实体及外部时钟映射需先明确规范化；重叠、乱序、重复标识、无效 UTF-8、缺分隔或正文以及超过音频时长的字幕会失败，不跳过、重排、修复或回溯。原始字幕不会推测翻译、词义或上下文词条，tokens 为 []；需要点词映射时仍须提供审核后的规范化 JSON。

content_assets 和 manifest 使用 ready 文件的实际摘要、大小及 application/json MIME，不能复用原始 VTT/SRT 的声明值；原始声明不被改写。现有 JSON 的内容、摘要和词卡引用保持不变。转换只生成 ready_for_review、publishable:false 候选，不关闭 C-03/C-05 或提供自动发布批准。

## Quiz 云历史和统计

观察到 2.3 的客户端启用 GET /me/quiz-history 与 GET /me/learning-summary。历史按账号/数字 revision 拉取，包含撤回；游标绑定账号和派生序列 epoch，400 INVALID_REQUEST 时完整重拉，成功后才替换缓存。currentCompatible 是拉取时快照，报告以最新 summary 为准。

摘要区分篇章与整书、有效覆盖与重复播放计时；首次完成版本词数未知为 null。Quiz 均值与六篇趋势仅用最新验真、未撤回、当前兼容的不同篇章，按实际验真时刻排序。积分和大整数总和保留十进制字符串。

提交前持久化原始 Quiz 请求，重试保持 attemptId、版本、逐题选择和时间。不上传 score/mastery；本机练习不替代登录正式版的云统计。存储失败阻止发送，不完整确认保留队列；撤回、受限/下架及旧题包的新提交不会成为有效成绩。

## 排行分析

观察到 2.4 的客户端启用 GET /rankings/{participantId}/quiz-analysis，snapshotId 必填。新端点提供匿名参与者的同快照 PASSED/ALL 统计、验真记录、本次新增答题积分、全量文字搜索、六字段双向排序与分页；原 /quizzes 端点保持兼容，不能将旧统计视为完整分析。

统计按期间内每篇章最新验真且未撤回的结果去重，通过与否来自保存的 mastery。数量为篇章，不是整书；趋势满六篇后取最早和最近各三篇。未知词数总和为 null；等级和分类的平均/比例仅用已知项并返回样本数，趋势组级别缺失则 null。Learning Points 单独显示，不按 PASSED/ALL 拆分；统计在搜索后仍表示整个期间。

query 最长 128 字符，去除首尾空白，%、_ 为普通文字。sort 为 date/title/accuracy/level/words/quizPoints，direction 为 asc/desc，NULL 最后且尝试 ID 保证确定顺序。签名 cursor 绑定快照、参与者、query、sort 和 direction；不同范围不能复用，匿名分析不返回 userId 或逐题答案。

0015 为新快照加入派生字段；旧快照缺少统计返回 RANKING_UNAVAILABLE，不伪造补值。榜单刷新可重建新身份，固定旧快照读取不覆写原数据。回退仅删除派生分析，保留答案与积分；再升级需重建，应用时间完整精度加入来源指纹。

## 学生档案

观察到 2.5 后启用 GET /me/student-profile，返回本人当前档案和 canManage；canManage 只控制界面，服务器对全部管理请求独立鉴权。只有 active operations_admin 可读取选项、按 Student Code 查找和维护；普通学生和 content_admin 无管理权限。查询码不是登录凭据，响应不包含身份 UUID、联系方式或逐题答案。

PUT /admin/student-profiles/{studentCode} 仅接受 mutationId、baseRevision、campusId、grade、readingLevel、reason，幂等头须与 mutationId 相同。reason 为核验依据，不应包含无关隐私。服务器生成 admin 来源和核验时间，不能回溯变更；校区须有效，年级 K～9，级别 1～5，未知允许 null，解除校区同时清空年级和级别。

revision 为精确十进制字符串；冲突返回 CONFLICT 并要求重读后重新确认。成功结果按管理员/请求 ID 加密保存，重复返回原结果，同 ID 改目标或载荷返回 IDEMPOTENCY_KEY_REUSED。无变化不增加版本。权限在取得账号锁后再次检查并持有角色锁，变更和审计在同一事务提交。

用户规则为“维持期初档案分组，下个榜单周期才生效”。cohortPolicy 固定 period_start；周/月/年取期初档案，滚动七日取窗口起点。当前档案立即保存但当期榜单不改变归属；累计积分和算法不变。0016 回退只移除派生字段，再升级产生新查询码，旧码请求不能覆盖重置后的 revision，须重新获取。

运行 `npm run contract:check` 校验 OpenAPI、Schema、错误码同步、示例、请求 ID 和写接口幂等头。
## 独立运营与上传恢复

2.7 新增 GET /admin/operations-context、GET /admin/ingestion-batches/{batchId}/recovery、GET /admin/upload-sessions/{uploadSessionId} 及 POST /admin/upload-sessions/{uploadSessionId}/renew，完整路径前缀为 /api/v1。必须使用有效管理员会话；renew 的空 JSON 对象与 Idempotency-Key 不变重试，同键不会延长原租期，租期过后显式申请新键。renew 只签缺失或尺寸错误的分片，查询响应不包含上传 URL。

complete 验证编号连续、真实存储大小及 ETag；确认意图不可修改，新会话用唯一对象身份恢复存储已完成、数据库未完成的状态。完整文件 SHA-256 仍由 Worker 再校验，不能把对象声明 metadata 当作内容摘要证明。0017 事实保留，旧会话异常不自动推断成功。

联调网页只在 local/test 注册。正式管理员网页登录、多章节导入、生产取消/死信矩阵和规模仍待完成；不改变 C-03/C-05 门槛或授予权限。
## 运营控制和恢复

2.8 新增 GET /api/v1/admin/ingestion-batches 与 /admin/ingestion-jobs/{jobId}。列表按创建时间/ID 倒序，签名游标绑定账号和筛选；详情返回累计/剩余次数和重试资格，不返回原始异常、凭证或对象 URL。

POST retry/cancel 保留原 Idempotency-Key，无请求体或空对象均可，未知字段拒绝。同键只恢复原意图，不重置次数。0018 意图与审计先提交，入队或清理失败返回可重试的 DEPENDENCY_UNAVAILABLE；不能换键冒充新意图。

新代次与旧失败队列分开，旧回执不复活取消任务。实际处理锁优先于耗时判断，耗尽不入队，完整上传不删除；0018 有运营事实拒绝回退。

## 整组内容导入

2.9 增加 POST /api/v1/admin/import-groups、GET 同路径（最近 20 组，非分页档案）与 GET /api/v1/admin/import-groups/{groupId}。管理员鉴权在解析清单前完成，取得目录锁后再次检查 active 身份与角色。清单最多 8 MiB、100 部作品、1,000 章、累计声明 100 GiB；每章必须七种资源和明确相对路径。音频每份最多 5 GiB，SRT/VTT 与原文各 100 MiB，封面 50 MiB，metadata/quiz/vocabulary 和规范字幕 JSON 各 8 MiB。

0019 原子创建草稿目录、全部章节批次与审计。相同管理员/键/规范化清单返回原组；换载荷冲突。已有目录属性必须一致；任何已有导入或内容版本历史均要求新版本，取消也不释放旧版本给新导入。单章入口同样锁定章节并检查版本历史和 active 管理员，合法原键重试保持兼容。网页预检 metadata/quiz 的 workId/pieceId/contentVersion，完整内容仍由 Worker 验证；不改变审核发布门槛。格式或大小错误映射到非重试 INVALID_REQUEST，不把错误清单当暂时内部故障。
