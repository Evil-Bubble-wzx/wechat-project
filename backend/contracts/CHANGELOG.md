# API contract changelog

## api-contract-v1.0.0 - 2026-09-24

- 建立 OpenAPI 3.1 和 JSON Schema 2020-12 基线。
- 冻结微信会话、当前用户、内容、Quiz attempt、排行选项和排行接口。
- 冻结批量导入控制面、分片直传、重试、取消、发布和回滚接口。
- 批量声明固定记录 `sourceCommitSha` 和 `toolVersion`，用于内容来源与处理版本审计。
- 建立稳定错误码、`X-Request-Id`、cursor 分页和 `Idempotency-Key` 约束。
- 排行主指标已确认并冻结为服务端算法分`rankingScore`（0～1000整数，单位`points`）。`quiz-score-v1`综合完成书本、词量、贝叶斯校正正确率、挑战度、成长和题材广度；公式与并列规则见ADR 0003。
- 新增排名参与者Quiz明细契约，返回同一快照的六项得分拆解、汇总统计和分页逐书记录，不返回答案或真实姓名字段。
