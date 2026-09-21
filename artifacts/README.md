# 浏览器验收产物

- `production/`：默认正式模式。只展示 Peter Rabbit，包含正式模式页面截图和真实音频验收结果。
- `demo/`：显式 Demo 模式。包含登录、旧内容、借阅、优惠券与邀请等演示页面截图。
- `legacy/`：模式拆分前的历史截图，仅用于比对，不作为当前验收证据。

运行 `npm run test:browser` 会重新生成 `production/` 与 `demo/` 中的当前产物。
