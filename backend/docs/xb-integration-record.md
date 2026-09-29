# X/B联调记录

- 初始日期：2026-09-24；当前代码复验：2026-09-29
- 接收契约：`api-contract-v1.0.0`；当前契约：`api-contract-v1.3.0`
- 排行规则：`quiz-score-v1`
- 环境：本机小程序API适配层、真实Fastify监听随机端口、隔离PostgreSQL测试schema

## 已验证链路

1. 小程序调用`wx.login`，开发环境仅使用显式stub code，服务端创建会话。
2. 客户端读取`/api/v1/me`并保存access/refresh token和用户信息；客户端不包含AppSecret。
3. 伪造过期access token后，内容请求收到401，客户端只刷新一次并重试成功。
4. 内容列表返回已发布书目。
5. Quiz正确答案返回`server_verified`和服务端分数；相同attempt重复提交保持相同业务结果；题包版本不符返回稳定拒绝。
6. 服务端按`quiz-score-v1`重建快照；少于10人的人群返回`cohort_too_small`且不泄露排名。
7. 客户端退出后服务端撤销session，本机清除token。
8. 审计表包含登录、刷新、内容读取、Quiz验证、排行读取和退出事件。
9. S-01 通过真实客户端 transport、Fastify 与 PostgreSQL 导入：服务端重算进度、保留待解析词面、复判 Quiz，并对相同快照精确重放回执。

10. S-02 通过真实 Fastify/PostgreSQL 双设备脚本：旧 revision 只合并区间、因果 revision 更新断点、自然结束完成、未来时钟诊断、精确重放、幂等复用拒绝和签名 cursor 均通过。
11. S-03 通过真实 Fastify/PostgreSQL 双设备脚本：稳定 entry、删除墓碑、旧删除胜出、旧收藏防复活、最新 revision 显式恢复、内容版本边界、精确重放和签名 cursor 均通过。

## 自动命令与结果

```text
cd backend
npm run test:integration:xb

xb.integration.passed login=wechat refresh=retry content=works quiz=verified+idempotent+rejected ranking=small logout=revoked
npm run test:integration:local-import
local-import.smoke.passed progress=recomputed words=pending quiz=verified idempotent=replayed
npm run test:integration:progress-sync
progress-sync.smoke.passed devices=2 stale=merged checkpoint=causal completion=trusted idempotency=exact
npm run test:integration:saved-word-sync
saved-word-sync.smoke.passed devices=2 delete=winner stale-save=blocked restore=explicit idempotency=exact
```

## 仍需人工环境

- 真实微信AppID/AppSecret、request合法域名和业务域名；
- 微信开发者工具中的非stub登录；
- 体验版Android/iPhone登录、弱网、刷新、Quiz、榜单和退出验收；
- 联调固定B提交SHA。目前工作区未提交，不能填写虚假SHA。
