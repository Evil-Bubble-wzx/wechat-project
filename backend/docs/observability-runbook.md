# B-05 可观测性与故障处理手册

> 本地验证基线：2026-09-24。生产告警联系人、日志平台和对象存储厂商指标需在生产环境决策后填写。

## 1. 日志与关联标识

- API 每次请求只输出一条 `http.request.completed` 结构化日志，包含 `environment`、`requestId`、HTTP 方法、规范化路由、状态码、耗时和稳定错误码。
- 排名请求额外记录 `campusId`、周期、年级和级别，不记录用户答案、真实姓名或完整档案。
- 导入链路使用 `requestId -> batchId -> itemId -> jobId -> contentVersionId`；Worker 完成/失败日志同时带 BullMQ `jobId` 和业务处理任务 ID。
- dev、test、prod 必须写入独立日志流和保留策略；禁止跨环境汇聚到同一无标签索引。
- 普通日志禁止出现 `authorization`、Cookie、`Idempotency-Key`、openid、refresh/access token、AppSecret、数据库口令、对象存储密钥、逐题答案和预签名 URL。HTTP 日志配置已对认证类头部强制脱敏。

排查客户端错误时，先取得响应体或响应头中的 `requestId`，再按同一 `environment + requestId` 查询 API 日志和 `audit_events.request_id`。导入问题继续按日志中的业务 ID 追到 Worker。

## 2. 指标入口与 Dashboard

`GET /internal/metrics` 输出 Prometheus 文本，必须使用 `Authorization: Bearer <METRICS_BEARER_TOKEN>`，且只能通过监控内网访问。生产环境启动会拒绝本地默认 token。

Grafana 模板位于 `ops/grafana/tingyue-backend.json`。核心查询：

| 目标 | PromQL |
| --- | --- |
| API 错误率 | `sum(rate(tingyue_http_requests_total{status=~"5.."}[5m])) / sum(rate(tingyue_http_requests_total[5m]))` |
| API P95 | `histogram_quantile(0.95, sum by (le,route) (rate(tingyue_http_request_duration_seconds_bucket[5m])))` |
| 登录成功率 | `sum(rate(tingyue_login_attempts_total{outcome="success"}[10m])) / sum(rate(tingyue_login_attempts_total[10m]))` |
| 资源失败率 | `sum(rate(tingyue_content_resource_requests_total{outcome="failure"}[10m])) / sum(rate(tingyue_content_resource_requests_total[10m]))` |
| Quiz 拒绝率 | `sum(rate(tingyue_quiz_submissions_total{outcome="rejected"}[15m])) / sum(rate(tingyue_quiz_submissions_total[15m]))` |
| 排名积压/失败 | `tingyue_ranking_rebuild_queue_depth`, `tingyue_ranking_rebuild_failures`, `tingyue_ranking_rebuild_oldest_wait_seconds` |
| 导入积压/死信 | `tingyue_ingestion_queue_depth`, `tingyue_ingestion_dead_letter`, `tingyue_ingestion_oldest_wait_seconds` |
| 上传完成率 | `tingyue_upload_sessions_completed / tingyue_upload_sessions_total` |
| 审核积压 | `tingyue_ingestion_review_backlog` |

对象容量、Worker CPU/内存和分片网络失败必须接入部署平台/MinIO/S3 原生指标；本地 API 仅暴露自身进程资源，不能伪造跨进程或云存储数据。

## 3. 告警阈值和责任角色

| 告警 | warning | critical | 第一责任角色 |
| --- | --- | --- | --- |
| API 5xx 比例（5 分钟） | >2% | >5% | 后端值班 |
| 关键 API P95（10 分钟） | >750ms | >1.5s | 后端值班 |
| 登录成功率（10 分钟，至少 20 次） | <95% | <85% | 后端值班；微信平台异常时升级产品技术负责人 |
| Manifest 失败率（10 分钟） | >3% | >10% | 后端值班/内容运维 |
| Quiz 拒绝率（15 分钟） | >20% | >40% | 产品技术负责人；按错误码判断客户端版本问题 |
| 排名最老等待 | >120s | >600s | 后端值班 |
| 排名失败事件 | >0 持续 10 分钟 | >10 | 后端值班 |
| 导入最老等待 | >10 分钟 | >30 分钟 | 内容运维/后端值班 |
| 导入死信 | >0 | >10 | 内容运维/后端值班 |
| 审核积压 | >50 | >100 | 内容运维 |
| 对象容量 | >70% | >85% | 基础设施负责人 |

生产人员姓名、通知渠道和轮值表属于步骤 1 的人工输入；在填写前保持 `NO-GO`。

## 4. 处理步骤

### API 5xx 或高延迟

1. 按 `requestId` 检查稳定错误码、路由和依赖就绪状态。
2. 对照 PostgreSQL 连接、Redis、对象存储和外部微信 API 指标定位依赖。
3. 不打印 token 或请求体；需要复现时使用 test 身份和脱敏输入。
4. 若为新版本回归，按部署手册回滚应用，不回滚数据库破坏性 migration。

### 排名积压或失败

1. 查看 `ranking_rebuild_events` 的状态、尝试次数和最老等待时间。
2. 确认 Worker 存活；超过 5 分钟的 `processing` 事件会被安全接管。
3. 修复原因后将未达最大尝试次数的失败事件留给 Worker 重试；不要直接修改排名分数。
4. 从原始 `server_verified` 且未撤回的 attempt 全量重算，并比对 `source_fingerprint`；同源重算必须复用同一快照。

### 导入积压或死信

1. 用 `batchId/itemId/jobId` 串联 API、数据库和 Worker 日志。
2. 区分对象上传、校验和、FFprobe、字幕解析、包校验及审核门槛。
3. 只通过受审计的 retry 接口重试；`publishable:false` 内容不得绕过发布门槛。
4. 不在工单或日志中复制预签名 URL。

### 凭据疑似泄漏

1. 立即撤销对应 token/密钥并暂停相关入口。
2. 保留审计日志，搜索时只用密钥指纹或 ID，不复制明文。
3. 轮换签名密钥后验证旧 token 失效，记录影响窗口和恢复时间。
