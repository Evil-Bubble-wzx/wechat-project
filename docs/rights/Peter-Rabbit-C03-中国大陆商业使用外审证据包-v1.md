# Peter Rabbit C-03 中国大陆商业使用外审证据包 v1

> 整理日期：2026-09-22  
> 状态：`READY_FOR_EXTERNAL_REVIEW`  
> 目标地区：中国大陆  
> 预定用途：公开商业数字阅读产品（未来可能包含付费访问）  
> 运营主体：`PENDING_ENTITY`

本文件整理可复核事实，不构成法律意见，不代替外部审核人签署。外审完成前，`rightsReleaseApproved` 与 `publishable` 必须保持 `false`。

## 1. 审核范围与结论空位

外部审核人须逐项审阅 `PR-TEXT-01`、`PR-AUDIO-01`、`PR-IMG-01`、`PR-INTERIOR-ILLUSTRATION-01`、`PR-ZH-01`、`PR-VOCAB-01`、`PR-QUIZ-01`，并在签署模板中填写姓名、机构、日期、中国大陆商业使用结论、已审证据 ID 及限制条件。

## 2. 英文正文

- 作品：*The Tale of Peter Rabbit*，Beatrix Potter（1866–1943）。
- 来源：Project Gutenberg eBook #14838，<https://www.gutenberg.org/ebooks/14838>。
- 上游原始文本：`source/text-project-gutenberg-14838.txt`，SHA-256 `2bf0e04297038fd97697dfac2b8a2db14f2b80c2012727f7ac0f28cf0b146544`。
- 产品规范文本：`source/text-original.txt`，SHA-256 `768f434703b244ebd8b3088f97f224644746f8f30fa0bcd520ea3fe22bac64b9`。
- 处理：只截取故事正文，移除 Project Gutenberg 头尾和 `[Illustration]` 占位符；首版不含内页插画。
- 待外审：中国大陆保护期、跨境来源与信息网络传播使用；清理后正文的再分发方式；标题/标识呈现是否足以避免来源或品牌混淆。

## 3. 朗读录音

- 项目：LibriVox *The Tale of Peter Rabbit and Others*，第 1 章。
- 朗读者：Julian Pratley；目录时长 5:22。
- 项目页：<https://librivox.org/the-tale-of-peter-rabbit-and-others-by-beatrix-potter/>。
- 归档标识：`thetaleofpeterrabbitandothers_2008_librivox`。
- 精确文件：<https://archive.org/download/thetaleofpeterrabbitandothers_2008_librivox/peterrabbitandothertales_01_potter_64kb.mp3>。
- 本地文件：`source/audio-original.mp3`，322.026 秒，SHA-256 `6949f07f5234e789903c6089bbee70e8989701ad72dffaf08a6ee89960f02e36`。
- 来源提示：LibriVox 与 Internet Archive 以美国公共领域口径提供录音，并提示美国以外用户自行核验当地法律。
- 待外审：中国大陆表演者权、录音制作者权、信息网络传播与商业使用；署名及其他条件。

## 4. 封面、插画与项目原创编辑内容

- 封面 SVG：`source/cover/peter-rabbit-independent.svg`，SHA-256 `4ef92f75746657628a5b08e2bf0c1cd9254f991fd9d064e2728cc6ae7712ab5b`。
- 产品 PNG：`miniprogram/assets/peter.png`，SHA-256 `9786d9bed6b9a6a592c1f919d312654f09ffa60076ef2598aeb5ef39d687cac7`。
- 创作说明：仓库内新作的几何兔子与花园构图，不临摹 Beatrix Potter 插画；标题标注 `Independent Public-Domain Reading Edition`。
- 内页插画：首版不使用，`N/A`。
- 中文简介与 10 道双语 Quiz：依据审核后正文重新创作，来源记录见 `source/editorial-provenance.json`；C-04 已以授权 AI 辅助方式完成内容审核，每题均绑定正文 cue 证据。
- 待外审：运营主体成立后的权属承接、AI 辅助创作政策、标题/包装的商标与不正当竞争风险。

## 5. 词汇证据与许可

- Britfone 3.0.1：固定 commit、源文件哈希及 MIT 全文见 `source/lexicon/THIRD_PARTY_NOTICES.md`。
- Open English WordNet 2025：CC BY 4.0，保留归属、修改说明与 Princeton WordNet 来源说明。
- 学习者释义：项目原创改写；开放词典只作为 lemma、词性、义项与 IPA 证据。
- 产品内展示：Me → “内容来源与许可”。

## 6. 中国大陆官方法律材料（供外审定位）

- 《中华人民共和国著作权法》：<https://www.ncac.gov.cn/xxfb/flfg/flfg_532/202103/t20210309_50530.html>。需重点审阅外国作品保护、复制/发行/信息网络传播/改编/翻译等权利、自然人作品保护期、权利限制及委托创作权属规则。
- 《实施国际著作权条约的规定》：<https://xzfg.moj.gov.cn/front/law/detail?LawID=358&Query=%E8%91%97%E4%BD%9C%E6%9D%83>。需由外审结合适用条约判断外国作品、表演和录音制品保护。

## 7. 放行规则

只有外审模板全部必填字段完成、限制条件已落实且实际运营主体已确认，才可将 C-03 改为 `APPROVED/DONE`。即使 C-03 通过，仍需完成 C-05 与阶段 0 其他阻断后才能发布；C-04 已完成授权 AI 辅助审核，不等同于人工签署。
