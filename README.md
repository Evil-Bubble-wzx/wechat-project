# 听阅 Tingyue

参考用户提供的 MegaWords 截图制作的原生微信小程序前端。当前默认运行正式预发布模式：仅开放 Peter Rabbit 数字听阅，隐藏实体借阅、优惠券、邀请、演示购买和固定验证码等演示入口。完整旧功能仍保留在显式 Demo 模式中，供开发验收。

最新导航：仅 Home / Recent / Me 三个主界面；Find Books 与 Borrowed 为二级功能，保留 Home 和 Me 的入口。主要导航、按钮与栏目采用英文，中文说明与中英释义保留。首页不再重复设置“发现下一本喜欢”，统一左封面、右书名与 By / Series / Lv / No. / Words / F/NF / Pages 的列表。示例书目的词数、页数与等级尚待对应真实版本核验。

## 运行

浏览器正式预览（Node.js 18+，首次运行先执行 `npm install`）：

```sh
npm run preview
```

打开 http://127.0.0.1:4173 。该命令默认是正式预发布模式；如需验收旧功能，显式运行 `npm run preview:demo`。

微信开发者工具：导入本目录，选择 `project.config.json`。源代码目录为 `miniprogram/`。原生小程序默认正式预发布模式；只有开发版可在调试控制台执行 `wx.setStorageSync('tingyue.dev.mode', 'demo')` 后重启进入 Demo。执行 `wx.removeStorageSync('tingyue.dev.mode')` 可恢复正式模式；体验版和正式版始终强制正式模式。

## 本次交付边界

已实现 11 个页面：首页、书库、借阅、我的、图书详情、播放器、最近听读、阅读报告、榜单、双登录、Quiz。正式预发布模式只暴露 Peter Rabbit 及本地学习记录；Demo 模式支持本地演示登录、搜索/分类、收藏、预约/防重复/取消、词卡与生词本、测验计分与报告持久化。

**这是可交互的前端，不是已部署的线上系统。** 正式预发布模式不提供登录、支付或实体借阅。Demo 模式的微信/短信登录未调用真实身份服务，固定验证码 `123456` 仅用于显式 Demo；手机号不持久化，演示账户 ID 固定。预约不占用真实库存。所有记录保存于本机，切换设备不共享。

彼得兔已接入 LibriVox 的 Julian Pratley 真实朗读音频（约 5 分 22 秒，64kbps MP3）。本地测试文件位于 `preview/audio/peter-rabbit-librivox.mp3`，浏览器可播放、暂停续播、拖动与调整倍速；音频不随小程序主包打包。来源记录见 `preview/audio/SOURCE.md`。彼得兔与四本旧书共用七行听读界面：每行至多 40 个字符，正在朗读的句子高亮，句间空隙保持上一句高亮，点词可暂停并查看词卡。彼得兔的词义仍待编辑审核；其他未导入音频的示例书目会提示音频缺失。原生小程序使用目录中的远程 HTTPS 地址，需配置合法域名、后台音频能力并进行真机验证。

Peter Rabbit 的字幕人耳审核已完成；词汇审核工作台位于 `content/peter-rabbit/peter-rabbit-01/review/vocab-index.html`。执行 `npm run content:peter:vocab` 可由 59 条正式字幕重建 371 个动态审核单元，机器候选只作参考，必须逐项人工确认并签署后才能应用。

阅读小测支持彼得兔的 5 道示例题，以及三本原创故事各章节的旧题和 54 段选项朗读；《The Wonderful Wizard of Oz》暂未导入小测。排行榜使用真实数据未接入的空状态，不编造用户和排名。归还、馆员核销、到期通知、账户合并、押金支付和跨设备同步未实现，需下一阶段后端开发。

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
npm run check
node tools/content-check.js
npm run test:browser
```

`npm run test:browser` 会依次启动正式预览与 Demo 预览，完成产品模式隔离、真实音频、视觉和完整演示交互验收。需要本机 Edge；Playwright 已作为开发依赖声明。正式产物位于 `artifacts/production/`，Demo 产物位于 `artifacts/demo/`，历史基线位于 `artifacts/legacy/`。已覆盖浏览器 320/390/430px 的页面宽度与主交互；尚未使用微信开发者工具编译或 iOS/Android 真机验收。

原始需求文档保留。当前正式首版不包含实体借阅；相关页面和规则只保留在显式 Demo 模式中。

后续产品、技术、内容、验收和发布工作统一以 `docs/正式产品实施计划-v1.1.md` 为主计划；架构、页面和内容管道文档作为专项参考。本 README 仍用于说明当前前端与演示边界。
