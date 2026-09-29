# API contract changelog

## api-contract-v1.3.0 - 2026-09-29

- Added `POST /api/v1/me/words/sync` for bidirectional stable saved-word synchronization.
- Added revisioned deletion tombstones, delete-wins stale conflict handling, signed cursors and canonical S-03 idempotency IDs.
- Preserved all v1.2 endpoints and response fields unchanged.

## api-contract-v1.2.0 - 2026-09-29

- 新增 `POST /api/v1/me/progress/sync`，单次请求同时批量推送本机证据并按签名 cursor 拉取服务端权威进度。
- 冻结 `s02-batch-v1` / `s02-op-v1` 幂等键、字符串修订号和每批 50 个操作、每页 100 项变更的边界。
- 多设备冲突固定为：收听区间始终合并；只有因果修订号一致的操作可更新可信断点；旧修订操作保留服务端断点。
- 完成状态由自然结束证据、90% 覆盖率和末 3 秒覆盖共同决定；设备时间仅诊断未来偏移，不参与冲突排序。
- 仅接受当前已发布内容版本；内容换版后客户端须从修订号 `0` 建立新版本进度。

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
