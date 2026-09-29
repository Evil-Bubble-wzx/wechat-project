# Quiz Attempt API v1

## 边界

正式接口为 `POST /me/quiz-attempts`。客户端只提交题包版本和逐题选择，不提交可被信任的分数、掌握结论或排名数据。当前仓库没有服务端实现；本机即时反馈必须标记为 `local_unverified`。

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

## 成功响应

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
- 排行只使用服务端验证记录，客户端支持且只支持四种状态：未登录 `unauthenticated`、服务不可用 `unavailable`、样本不足 `cohort_too_small`、可展示 `ready`。当前仓库固定为 `unavailable`；在真实服务返回 `ready` 前不展示用户、名次或榜单行。
