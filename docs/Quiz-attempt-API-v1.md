# Quiz Attempt API v1

## 边界

当前契约为 `api-contract-v2.0.0`，接口为 `POST /api/v1/me/quiz-attempts`，写请求携带与 attemptId 一致的 `Idempotency-Key`。客户端只提交题包版本和逐题选择，不提交可信分数、掌握结论或排名积分。服务端判题已实现并通过本机 PostgreSQL/HTTP 验收；本机即时反馈仍标记为 `local_unverified`，只有服务端确认后才升级。

## 请求

```json
{
  "schemaVersion": 1,
  "attemptId": "client-generated-idempotency-key",
  "workId": "peter-rabbit",
  "pieceId": "peter-rabbit-01",
  "contentVersion": 1,
  "quizVersion": 1,
  "questionIds": ["PRQ-001"],
  "selectedOptions": [0],
  "startedAt": "2026-09-23T00:00:00.000Z",
  "submittedAt": "2026-09-23T00:03:00.000Z"
}
```

服务端必须按 `attemptId + user_id` 幂等处理，校验题包版本、题目集合和选项范围，并从服务端题库判分。

相同 attempt 和请求保持原答卷、判分及验证时间；相同 ID 携带不同答案拒绝。v2 附带 `learningScore` 是累计积分的新读取，其 `asOf` 可变化；不能要求整个摘要与首次响应字节相同。

## 成功响应

以下只展示固定判分字段；完整响应还包含 `requestId` 和服务端累计 `learningScore`（规则、十进制字符串积分、三类明细及 `asOf`），以 [权威 Schema](../backend/contracts/schemas/api-v1.schema.json) 为准。

```json
{
  "attemptId": "client-generated-idempotency-key",
  "status": "server_verified",
  "score": 90,
  "mastery": true,
  "verifiedAt": "2026-09-23T00:03:01.000Z"
}
```

版本失效或答案无效时返回 `rejected` 和稳定错误码。客户端不得把网络成功、HTTP 200 或本机计算分数自行升级为 `server_verified`。

## 报告与排行

- 本机报告可展示 `local_unverified`，但必须明确“本机练习、未经服务端验证”。
- 趋势只取每个不同 piece 的最新兼容 attempt；至少 6 个不同 piece 才显示最早 1/3 与最近 1/3 对比。
- 旧记录可展示但不得补造逐题答案，也不得进入新版趋势。
- 排行使用服务端确认的 `learning-points-v2`：有效听读每秒 1 分、篇目首次完成 50 分、同题首次答对 10 分，重复学习不重奖。无有效正确答案支持时取消该题积分，恢复时按原期间重算。历史迁移/S-01 导入只进累计。Quiz 仍在完整答卷提交后计分。
- 页面按鉴权、服务可用性、校区选择、加载、小样本和网络错误显示真实状态；真实服务返回 `ready` 前不展示用户、名次或榜单行。服务已完成本机联调，真实微信与生产环境待验。
- 2026-10-10 验证及剩余里程碑见 [当前交接](学习积分验收与交接-2026-10-10.md)。
