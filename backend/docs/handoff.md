# B 后端交接基线

- 确认日期：2026-09-24
- B长期分支：`backend/v1`
- `handoffBaseCommit`：`7b882b22bfcf535cf2677616cfa82b6bb3d8a70e`
- 当前契约：`api-contract-v1.0.0`，入口`backend/contracts/openapi.json`
- 技术基线：Node.js 24、TypeScript、Fastify、PostgreSQL、Redis/BullMQ、MinIO/S3兼容对象存储、FFmpeg/ffprobe、可选Python Worker
- 数据库基线：6条migration，27张业务表加`schema_migrations`，A/B校区seed
- 排行基线：`quiz-score-v1`，0～1000综合算法分；完成Quiz书本数只是30%输入，不是最终指标
- 本地完成：步骤0、2～5、7～14；步骤6核心链路完成但大批量验收未关闭；步骤1及15依赖生产/人工输入
- 自动验证：后端38项测试、小程序62项测试、契约、数据库、会话、内容、Quiz、排行、可观测性、安全、导入、X/B联调和浏览器双模式回归通过
- 生产边界：阶段0仍为`NO-GO`；C-03/C-05未关闭时内容保持`publishable:false`
- 工作区：保留了用户原有未提交前端、内容和文档修改；未擅自提交或清理

## X/B联调结果

小程序通过`miniprogram/services/api.js`调用真实Fastify接口，已验证微信stub登录、401后refresh一次并重试、内容列表、Quiz验证/幂等/版本拒绝、算法排行、小样本隐私状态、退出撤销和审计事件。客户端不包含AppSecret；开发环境API地址和stub code使用显式本机配置，体验版/正式版必须从ext config提供HTTPS合法域名。

## 当前需要人工提供的资料

1. 生产云厂商、地域、预算、域名、监控/运维负责人。
2. 微信小程序真实AppID/AppSecret及合法域名配置；随后执行开发者工具、体验版、Android/iPhone真机验收。
3. C-03/C-05内容权利和发布签署。
4. 数百文件/总GB压测数据集及生产容量目标。

B契约提交SHA尚未填写：当前改动保留在工作区，未收到创建提交的授权。实际提交后应把SHA写入本文件和X/B交接记录。
