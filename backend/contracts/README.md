# API 契约

当前权威版本：`api-contract-v1.0.0`

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
- 排行主指标固定为服务端计算的`rankingScore`（0～1000整数，单位`points`）；客户端不得自行计算或上传可信排名分。当前公式版本为`quiz-score-v1`，见`docs/adr/0003-ranking-score-v1.md`。
- 管理端上传接口只传控制面元数据，文件字节通过短期预签名地址直传对象存储。

运行 `npm run contract:check` 校验 OpenAPI、Schema、错误码同步、示例、请求 ID 和写接口幂等头。
