# B 后端交接基线

> 当前接收更新：2026-10-09。已从 `backend/v1@533a64e` 选择性接收 S-03；以下初始交接 SHA 仍作为历史基线。

- B 分支确认日期：2026-09-24
- `peter` 接收复验日期：2026-09-28
- B长期分支：`backend/v1`
- B交付提交：`9efe8aac1d499fb14a81929ae3106fdea823cb25`
- `handoffBaseCommit`：`7b882b22bfcf535cf2677616cfa82b6bb3d8a70e`
- 接收目标：`peter` 基线 `536c201e3ebc4be06cb3b29b4f08e9359127298d`
- 接收契约：`api-contract-v1.0.0`；当前工作区契约：`api-contract-v1.3.0`，入口 `backend/contracts/openapi.json`
- 技术基线：Node.js 24、TypeScript、Fastify、PostgreSQL、Redis/BullMQ、MinIO/S3兼容对象存储、FFmpeg/ffprobe、可选Python Worker
- 数据库基线：当前 9 条 migration；保留 `0008_daily_progress_sync`，新增 `0009_saved_word_sync`；0001～0009 已在隔离 PostgreSQL 18 中升级、回滚并再升级，核验 36 张表。
- 排行基线：`quiz-score-v1`，0～1000综合算法分；完成Quiz书本数只是30%输入，不是最终指标
- 本地完成：步骤0、2～5、7～14；步骤6核心链路完成但大批量验收未关闭；步骤1及15依赖生产/人工输入
- B 分支历史验证：数据库、会话、内容、Quiz、排行、可观测性、安全、导入、X/B联调和浏览器双模式回归曾通过
- 当前复验（2026-10-09）：后端类型检查和 57/57 测试、契约 5/5、密钥扫描通过；客户端 109/109、静态检查和双产物可复现构建通过；S-01、S-02、S-03 隔离 HTTP/PostgreSQL smoke 均通过。
- 生产边界：阶段0仍为`NO-GO`；C-03/C-05未关闭时内容保持`publishable:false`
- 接收范围：选择性接收 `backend/`、后端 CI 和后端专项文档；未把旧基线上的小程序代码、截图和旧项目状态覆盖到当前 `peter`

## X/B联调结果

B 分支旧基线上的前端适配层没有直接覆盖当前 `peter`。现已把 session/refresh、content manifest、Quiz、ranking、local-import 和 progress sync 与 saved-word sync 端点接入当前 X-06 网络层，并保持 token 不落盘、fail-closed 与本机 Quiz 先保存再提交的边界。Fastify/PostgreSQL/Redis/对象存储本机联调及 S-01、S-02、S-03 隔离真实 HTTP 联调已通过；客户端不得包含 AppSecret，体验版/正式版必须使用 HTTPS 合法域名。

## 当前需要人工提供的资料

1. 生产云厂商、地域、预算、域名、监控/运维负责人。
2. 微信小程序真实AppID/AppSecret及合法域名配置；随后执行开发者工具、体验版、Android/iPhone真机验收。
3. C-03/C-05内容权利和发布签署。
4. 数百文件/总GB压测数据集及生产容量目标。

初始 B 契约来源为 `backend/v1@9efe8aac1d499fb14a81929ae3106fdea823cb25`；S-03 选择性接收来源为 `backend/v1@533a64e1ee8789221eb1f4b70767d4a8f075d021`。接收不等于部署完成；生产参数、真实微信环境、权利门槛、规模压测和当前客户端联调仍需分别关闭。
