# iPhone临时HTTPS准备：2026-10-13

用户确认临时HTTPS、iPhone优先、首版免费。本机stub3100环境保留。真实微信AppSecret尚缺，私有backend/.env.device-iphone已准备（API3101、provider real、目标AppID），git忽略确认通过。用户应本机填写Secret，不发送聊天，不重置已有Secret。

新增工具tools/iphone-test-gateway.cjs：端口4182，独立私钥、最多6小时、请求限流与body限制、真实登录码不替换、拒绝test码、会话来源检查、禁止admin/commerce/local-import，只开放本轮学习及Peter目录/manifest；签名资源经短期随机租约转发，仅允许本机已知S3与Peter fixture published路径。隧道key与配置在私有.cache/device-local/iphone-gateway.json。

新增tools/build-iphone-preview.cjs：独立build/iphone-https-test，真实wx.login、stubLoginCode null、commerce默认禁用、开发环境限制，内置私有网关key，不用于正式发布。

tests/iphone-gateway.test.js已通过：真实码完整转发、stub拒绝、无key/外部会话拒绝、admin/commerce路由拒绝、只列Peter、非法资源路径拒绝、存储签名不下发。

启动Cloudflare隧道操作被自动审批拒绝：真实登录与学习数据经第三方传输未获得充分具体授权。命令未执行，不得用其它方式绕过。已向用户请求明确授权本次Cloudflare传输范围；等待答案。尚无实际临时HTTPS地址或可用新手机二维码。真实AppSecret填写和公网数据流向批准两项都需完成。

## 配置与授权完成

用户明确允许本次Cloudflare传输真实登录及测试学习数据，且已本机填好AppSecret，未在输出中显示。真实API3101健康200，WECHAT_PROVIDER=real；旧stub3100服务保留。

独立网关4182及Cloudflare隧道启动成功，临时地址https://athletics-observations-journalism-varied.trycloudflare.com。公网无key=401，admin路由=404，test登录码=400。微信官方凭据探测仅使用无效探针code返回40029，不代表真实微信登录完成。

独立build/iphone-https-test生成成功，12主路由＋Quiz子包；AppID wxef246c6a495e4030、基础库3.17.3，真实wx.login（stubLoginCode:null），模拟购买默认禁用。开发模式测试包，非生产发布。网关六小时拒绝窗口，到期需要重新准备地址/包；电脑、Docker及服务须保持运行。

目前仍在等待微信preview生成手机二维码，不能复用先前localhost二维码。首次真实微信登录产生新的真实openid身份，不保证旧stub记录自动属于该身份；本轮不迁移或覆盖旧记录。手机登录、播放、资源下载、学习与积分验证待用户实际反馈。

手机preview已成功：包544365字节，私有二维码.cache/device-local/iphone-preview-2026-10-13.png，已提供用户进行iPhone首轮真实登录和播放验证。

手机首轮诊断反馈域名限制。用户已在后台request保留原域名并追加当前临时域名，downloadFile添加当前域名，反馈保存成功。已复查HTTPS在线，正在重新生成域名配置更新后的预览。实际登录尚待手机复验。

用户iPhone开启调试后反馈登录成功。网关实际session/wechat=201、me=200；真实provider API确认相同状态，学习同步/生词/收藏/个人历史接口均200，无业务错误。可确认真实微信登录及个人接口首次连通；合法域名在非调试模式仍未验收，播放及记录持久性待下一轮。

用户反馈详情Take Quiz一度提示无小测，随后反馈已做完小测。尚未据此修改入口判断；需继续确认服务端提交、Me历史及积分，本轮不可仅凭作答页面认定云记录保存成功。

用户反馈登录、播放及重新进入进度保留通过。小测随后实际提交到网关200；只读核对目标AppID最新小测为server_verified、10题、成绩50%、本次quizCorrect积分50，verified_at=2026-10-13T02:18:34.641Z。云历史/学习汇总/积分读取均200。当前未修改详情入口代码；早前无小测提示未稳定复现，不能记录为已定位修复。生词保存与重进、非调试合法域名、手机后台/弱网及跨设备仍待验收。

## iPhone缓冲问题与修复

用户反馈声音停止、进度条不动、加载缓慢。实际探测本机网关30ms，Cloudflare约908ms；日志有租约过期404及客户端取消流，但无法仅凭此确定具体音频请求根因。

发现播放器等待缓冲后缺少超时兜底，重复waiting还会丢失等待前的播放意图。修复为15秒缓冲超时保留位置/已听覆盖，最多自动续签一次，再次卡住则提示重试；暂停、切换/账户变化、恢复事件清理定时器。等待本身不授予听读积分。

新增三项针对性回归通过；当前客户端220/220及页面绑定/语法检查通过。iPhone新测试包生成中，手机复验待用户反馈。临时网络延迟未据此认定解决。

缓冲恢复版preview实际成功（545326字节），二维码.cache/device-local/iphone-buffer-recovery-preview.png；最新播放器实际API/S3联合回归通过，手机表现待复验。

缓冲修复版手机复测用户报告切到聊天30秒返回后未登录。当前日志无对应DELETE session/current或刷新401；API客户端会话仅存内存，App.onShow只有同步而没有重新认证/会话恢复。尚需确认是否运行时重启或重新扫码导致会话丢失；不把推测记为确定原因。已询问用户具体返回状态，下一步针对实际情况补会话恢复与回归。

## iPhone后台切换验收通过

用户澄清此前未登录现象发生在关闭预览/重新扫码后，不认定为单纯后台切换导致掉登录。按说明重新登录，播放约1分钟，点击右上圆形按钮返回微信聊天约30秒，再从最近小程序返回；用户明确反馈声音、进度条、登录状态三项均正常。

当前已获用户确认：真实微信登录、播放、重进进度保留、生词保存、Quiz云端提交与积分、正常后台聊天切换恢复。最新已核小测10题/50%/50积分。缓冲超时恢复改动客户端220项及本机真实API/S3联合回归通过。

仍未完成：关闭/微信回收后会话恢复体验、长时间锁屏/弱网、跨设备、Android（暂缓）、非调试合法域名运行、稳定生产部署、主体类目/内容公开发布门槛与平台审核。当前仅临时HTTPS、开发调试模式；不等于正式可公开上线。

## 首播等待与资源提示修复

用户说明慢发生在iPhone打开故事至首播，随后出现资源加载/校验失败提示。日志确认存在works/peter-rabbit%253Apeter-rabbit-01的404：host.go对章节组合id编码，页面onLoad未解码导致章节组合被作为workId二次编码请求。已在页面入口解码，回归覆盖编码章节与hasQuiz保留。

新增已校验JSON资源内存缓存：账号/作品/篇章/内容版本/小测版本/manifest摘要共同作为键，最多4包，5分钟；登录切换及退出清理，返回对象独立拷贝，仍获取/校验新manifest与签名URL。详情页仅对免费章节预取并校验四类JSON，不缓存授权证明，不绕过版本/摘要。

客户端222/222与本机真实API/S3联合回归通过，手机新版preview成功（546397字节），二维码.cache/device-local/iphone-resource-loading-preview.png。手机首播耗时及提示是否消失待用户复测，不能宣称临时Cloudflare网络性能已达生产要求。

按用户明确要求，删除播放页reader-panel-bottom整行（音频已导入/待导入状态与阅读小测入口）。保留书籍详情Take Quiz、积分说明及播放控件；iPhone及本机primary/isolation构建已更新，12路由绑定/语法检查通过。本次低影响界面删除未新增镜像测试。
