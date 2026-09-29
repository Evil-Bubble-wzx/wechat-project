# API contract changelog

## api-contract-v1.2.0 - 2026-09-29

- 新增 `GET /api/v1/me/progress`、`GET /api/v1/me/progress/{pieceId}` 和 `PUT /api/v1/me/progress/{pieceId}`。
- 进度写入以 `userId + mutationId` 幂等；服务端 revision 为字符串形式的单调 `bigint`。
- 同版本听过区间取并集；旧 revision 不得覆盖新断点；覆盖率和完成状态只由服务端计算。
- 已知且未撤销的旧内容版本只保存为历史进度，不影响当前版本。
- API 响应增加 `X-API-Contract-Version`；客户端只有观察到服务端版本至少为 1.2 时才启用 S-02。

## api-contract-v1.1.0 - 2026-09-28

- 新增 `POST /api/v1/me/local-import`，以 `userId + snapshotId` 幂等导入本机可信进度证据、词面候选和未验证 Quiz。
- 服务端重新校验内容版本、音频时长、收听区间和 Quiz 题包；不接受客户端完成状态、分数或权益字段。
- 生词仅以 `surface_only` 候选保存为待解析状态，不冒充已完成 S-03 稳定词条同步。

## api-contract-v1.0.0 - 2026-09-24

- 建立 OpenAPI 3.1 和 JSON Schema 2020-12 基线。
- 冻结微信会话、当前用户、内容、Quiz attempt、排行选项和排行接口。
- 冻结批量导入控制面、分片直传、重试、取消、发布和回滚接口。
- 批量声明固定记录 `sourceCommitSha` 和 `toolVersion`，用于内容来源与处理版本审计。
- 建立稳定错误码、`X-Request-Id`、cursor 分页和 `Idempotency-Key` 约束。
- 排行主指标已确认并冻结为服务端算法分`rankingScore`（0～1000整数，单位`points`）。`quiz-score-v1`综合完成书本、词量、贝叶斯校正正确率、挑战度、成长和题材广度；公式与并列规则见ADR 0003。
- 新增排名参与者Quiz明细契约，返回同一快照的六项得分拆解、汇总统计和分页逐书记录，不返回答案或真实姓名字段。
