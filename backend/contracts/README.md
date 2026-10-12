# API 契约

当前权威版本：`api-contract-v2.4.0`

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

客户端必须加载同一个 pieceId/contentVersion 的七种资源；阅读 JSON 校验字节数、摘要、身份和题包版本。当前资源规范化格式见 worker 约束，VTT/SRT 原文件不能直接作为可用阅读资源。已存在的旧版本需重新验证并补齐元数据、真实音频时长和同版本题包后，才可用于这条动态链路。

## Quiz 云历史和统计

观察到 2.3 的客户端启用 GET /me/quiz-history 与 GET /me/learning-summary。历史按账号/数字 revision 拉取，包含撤回；游标绑定账号和派生序列 epoch，400 INVALID_REQUEST 时完整重拉，成功后才替换缓存。currentCompatible 是拉取时快照，报告以最新 summary 为准。

摘要区分篇章与整书、有效覆盖与重复播放计时；首次完成版本词数未知为 null。Quiz 均值与六篇趋势仅用最新验真、未撤回、当前兼容的不同篇章，按实际验真时刻排序。积分和大整数总和保留十进制字符串。

提交前持久化原始 Quiz 请求，重试保持 attemptId、版本、逐题选择和时间。不上传 score/mastery；本机练习不替代登录正式版的云统计。存储失败阻止发送，不完整确认保留队列；撤回、受限/下架及旧题包的新提交不会成为有效成绩。

## 排行分析

观察到 2.4 的客户端启用 GET /rankings/{participantId}/quiz-analysis，snapshotId 必填。新端点提供匿名参与者的同快照 PASSED/ALL 统计、验真记录、本次新增答题积分、全量文字搜索、六字段双向排序与分页；原 /quizzes 端点保持兼容，不能将旧统计视为完整分析。

统计按期间内每篇章最新验真且未撤回的结果去重，通过与否来自保存的 mastery。数量为篇章，不是整书；趋势满六篇后取最早和最近各三篇。未知词数总和为 null；等级和分类的平均/比例仅用已知项并返回样本数，趋势组级别缺失则 null。Learning Points 单独显示，不按 PASSED/ALL 拆分；统计在搜索后仍表示整个期间。

query 最长 128 字符，去除首尾空白，%、_ 为普通文字。sort 为 date/title/accuracy/level/words/quizPoints，direction 为 asc/desc，NULL 最后且尝试 ID 保证确定顺序。签名 cursor 绑定快照、参与者、query、sort 和 direction；不同范围不能复用，匿名分析不返回 userId 或逐题答案。

0015 为新快照加入派生字段；旧快照缺少统计返回 RANKING_UNAVAILABLE，不伪造补值。榜单刷新可重建新身份，固定旧快照读取不覆写原数据。回退仅删除派生分析，保留答案与积分；再升级需重建，应用时间完整精度加入来源指纹。

运行 `npm run contract:check` 校验 OpenAPI、Schema、错误码同步、示例、请求 ID 和写接口幂等头。
