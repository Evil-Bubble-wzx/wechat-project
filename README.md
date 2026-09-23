# 听阅 Tingyue

参考用户提供的 MegaWords 截图制作的原生微信小程序前端。当前默认运行正式预发布模式：仅开放 Peter Rabbit 数字听阅，隐藏实体借阅、优惠券、邀请、演示购买和固定验证码等演示入口。完整旧功能仍保留在显式 Demo 模式中，供开发验收。

最新导航：仅 Home / Recent / Me 三个主界面；Find Books 与 Borrowed 为二级功能，保留 Home 和 Me 的入口。主要导航、按钮与栏目采用英文，中文说明与中英释义保留。正式 Peter Rabbit 只展示有证据的 By / Edition / Content ID / Words / F/NF 等字段，不再展示无来源的等级和页数；Demo 书目仍是待核验样例。

## 运行

浏览器正式预览（Node.js 18+，首次运行先执行 `npm install`）：

```sh
npm run preview
```

打开 http://127.0.0.1:4173 。该命令默认是正式预发布模式；如需验收旧功能，显式运行 `npm run preview:demo`。

微信开发者工具正式构建：先执行 `npm run build:production`，再导入本目录并选择默认的 `project.config.json`；该配置只加载 `build/production-miniprogram/`。如需本地验收 Demo，执行 `npm run build:demo` 并改用 `project.demo.config.json`，它只加载 `build/demo-miniprogram/`。两个生成目录均不提交 Git，正式上传不得选用 Demo 配置。正式产物在物理文件层只保留 Peter Rabbit，且不包含实体借阅、优惠券、邀请、固定验证码、Demo 缓存键或旧书内容。

## 本次交付边界

已实现首页、书库、借阅、我的、图书详情、播放器、最近听读、阅读报告、榜单、登录、Quiz 与内容来源/许可等页面。正式预发布模式只暴露 Peter Rabbit 及本地学习记录；Demo 模式支持本地演示登录、搜索/分类、收藏、预约/防重复/取消、词卡与生词本、测验计分与报告持久化。

**这是可交互的前端，不是已部署的线上系统。** 正式预发布模式不提供登录、支付或实体借阅。Demo 模式的微信/短信登录未调用真实身份服务，固定验证码 `123456` 仅用于显式 Demo；手机号不持久化，演示账户 ID 固定。预约不占用真实库存。所有记录保存于本机，切换设备不共享。

彼得兔已接入 LibriVox 的 Julian Pratley 真实朗读音频（5 分 22 秒，64kbps MP3）。本地测试文件位于 `preview/audio/peter-rabbit-librivox.mp3`，浏览器可播放、暂停续播、拖动与调整倍速；音频不随小程序主包打包。播放器使用进程内全局会话，离开播放器后可继续播放，返回时保持同一篇目、实时位置、播放状态与倍速；用户主动暂停不会因页面切换自动恢复。未完成内容在重启后暂停于可信断点；完成必须同时满足自然结束、至少 90% 唯一音频覆盖以及尾部 3 秒已听，拖动到结尾不会完成；倍速播放按真实花费时间累计。来源记录见 `preview/audio/SOURCE.md`。彼得兔与四本旧书共用七行听读界面：每行至多 40 个字符，正在朗读的句子高亮，句间空隙保持上一句高亮。Peter Rabbit 的 358 个审核词条已全部接入 906 个可点击 token，按上下文显示义项；播放中打开词卡会暂停，关闭后仅在原先播放时续播。其他未导入音频的示例书目会提示音频缺失。原生小程序使用目录中的远程 HTTPS 地址，需配置合法域名、后台音频能力并进行真机验证；X-02 在取得至少一台真机的后台/锁屏证据前保持 `PARTIAL_DEVICE_PENDING`。

Peter Rabbit 的字幕人耳审核已完成；371 个词汇审核单元也已在 `wzx` 明确授权下完成 AI 辅助全量审核并应用，形成 358 个正式义项、覆盖 906 个可点击 token。审核方式在归档中如实记录，整体人工完成门槛及发布门槛仍保持关闭。工作台位于 `content/peter-rabbit/peter-rabbit-01/review/vocab-index.html`。

阅读小测支持彼得兔固定 10 道项目原创双语理解题，每题绑定审核正文 cue，并提供双语解释；80 分只作本机掌握反馈，不限制内容访问。本机 attempt 保存题包版本与逐题选择，并明确标为“未经服务端验证”；旧记录保留展示但不进入新版统计，同一篇只采用最新兼容记录，至少 6 篇不同内容才显示趋势。三本原创故事保留各章节旧题和 54 段选项朗读；《The Wonderful Wizard of Oz》暂未导入小测。排行榜仅保留 7-Day / All-Time，真实服务未接入时显示不可用状态，不编造用户和排名；服务端判题契约见 `docs/Quiz-attempt-API-v1.md`。归还、馆员核销、到期通知、账户合并、押金支付和跨设备同步未实现，需下一阶段后端开发。

## 内容如何补充

旧项目的三本原创故事与《The Wonderful Wizard of Oz》第一章已导入 `content/legacy-listen-read/`，共七段音频和 78 条逐句字幕。四本书已出现在本地书目，详情页可选章节，播放器可以播放对应的打包音频并显示字幕、点词释义；三本原创故事还保留各章小测和选项音频。源材料、重建方式和上线复核状态见 [旧内容导入说明](content/legacy-listen-read/README.md)。执行 `npm run content:legacy` 可重复生成导入内容；Peter Rabbit 内容包保持独立。

样例内容统一维护在 `miniprogram/modules/catalog/catalog.json`，封面位于 `miniprogram/assets/`，每本书使用稳定 `id`。复制一项填写标题、作者、分类、封面、时长、库存等即可增加本地样例，不需改页面代码。

```sh
node tools/content-check.js
npm run content:build
```

音频字段可增加 `audioUrl`，应为已确认授权的 HTTPS 资源。`coverUrl` 可配置用于锁屏显示的远程封面。当前本地 JSON 随小程序打包，修改它需重新构建；满足“运营加书不发版”需把目录读取替换为服务端内容 API，并建设上传、校验、发布流程。不要把目前的样例模式理解为已实现云端内容发布。

## 模块结构

- `modules/account/`：演示账户逻辑；正式身份验证应由服务端完成。
- `modules/listen-read/`：微信音频适配器。
- `modules/physical-loan/`：演示预约/续借规则；真实库存锁定必须由服务端事务处理。
- `modules/catalog/`：稳定 ID 的内容目录与示例题。
- `services/host.js`：统一封装存储、导航、提示和设备信息，接入其他宿主时替换适配层。
- `ui/`：共用控制器、页面模板；`pages/`：11 个薄入口。
- `preview/`：仅开发预览使用的 WXML 浏览器渲染桥，不随小程序打包。

将这些前端目录复制到同技术栈的原生微信小程序，调整路由注册、宿主适配器与导航即可开始集成。若宿主为 Taro/uni-app，页面层仍需适配，不承诺原样运行。

## 验证

```sh
npm test
npm run release:audit
npm run build:verify
npm run check:builds
node tools/content-check.js
npm run test:browser
```

`npm run release:audit` 会重建并审计正式/Demo 两套小程序产物；`npm run build:verify` 会再次独立构建并比较 SHA-256，防止构建不可复现；`npm run check:builds` 会分别检查两套生成产物。`npm run test:browser` 也基于生成产物依次启动正式预览与 Demo 预览，完成产品模式隔离、真实音频、视觉和完整演示交互验收。需要本机 Edge；Playwright 已作为开发依赖声明。浏览器截图与结果位于 `artifacts/production/`、`artifacts/demo/`，历史基线位于 `artifacts/legacy/`；构建审计记录位于 `artifacts/build/X-05-release-audit.json`。已覆盖浏览器 320/390/430px 的页面宽度与主交互；尚未完成体验版/正式版 Android 与 iPhone 真机验收。

原始需求文档保留。当前正式首版不包含实体借阅；相关页面和规则只保留在显式 Demo 模式中。

后续产品、技术、内容、验收和发布工作统一以 `docs/正式产品实施计划-v1.1.md` 为主计划；架构、页面和内容管道文档作为专项参考。本 README 仍用于说明当前前端与演示边界。
