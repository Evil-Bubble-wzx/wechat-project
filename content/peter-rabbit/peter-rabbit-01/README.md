# Peter Rabbit 单独内容包

包标识：`peter-rabbit-01`  
作品：*The Tale of Peter Rabbit*  
作者：Beatrix Potter  
朗读：Julian Pratley（LibriVox）

## 目录职责

- `source/`：不可被构建脚本覆盖的源音频、原始电子文本、清洗正文、来源清单和权利记录。
- `work/`：可重复生成的正文、字幕草稿、词条草稿、音频校验和对齐状态。
- `review/`：人工修改与审核记录。
- `dist/`：发布状态、QA 报告；只有审核通过后才允许放入正式的 `audio.mp3 / cues.json / vocab.json`。

## 当前状态

当前为 `needs_review`，不可发布。已经具备：

- 真实完整音频与 SHA-256；
- Project Gutenberg 正文与来源原档；
- Faster-Whisper `base.en / CPU int8` 的完整识别结果；
- 片头、正文、片尾共 59 条时间轴字幕，其中正文 57 条；
- 952 个标准原文词与 1007 个 ASR 词的序列对齐；
- 每句无损 token 化与播放器逐句切换；
- 任意正文词点击及待审核词条卡片；
- 待补充的词条索引；
- 自动 QA 和发布拦截。
- 离线人耳审核页、正式审核 schema、校验与修正应用器；
- 审核人 `wzx` 已完成全文试听和 28/28 个裁决，O1/O2 已按录音恢复，`subtitleReviewComplete:true`。
- 词汇审核 schema、开放来源证据、离线工作台、校验与应用器；371 个动态审核单元已完成经 `wzx` 授权的 AI 辅助全量审核，形成 358 个正式义项并覆盖 906 个可点击 token。

尚未完成：

- 整体人工完成门槛；
- 元数据、Quiz、词卡和权利人工复核。

所有未完成项均记录在 `dist/qa-report.json`，`dist/manifest.json` 的 `publishable` 保持为 `false`。字幕和词汇子门槛已经关闭，但不会越过整体人工、权利、元数据与 Quiz 门槛。

## 字幕人耳审核

本轮审核已于 2026-09-21 完成；签署结果保存在 `review/review-decisions.completed.json`，应用后的正式修订保存在 `review/corrections.json`。以下步骤保留为后续重建和复审流程：

1. 执行 `npm run content:peter:review` 生成最新审核草稿和离线页面。
2. 直接打开 `review/index.html`，从头听完整篇音频，并完成 28 个决策单元：26 个低置信词和 O1/O2 两个整句裁决。
3. 页面达到至少 95% 完整试听覆盖率、逐项确认并填写审核人后，下载 `review-decisions.completed.json` 到 `review/`。
4. 执行 `npm run content:peter:review:check`；校验通过后再执行 `npm run content:peter:review:apply`。
5. 应用器会生成正式 `review/corrections.json`，更新 `dist/cues.json`、QA 和 manifest；随后执行 `npm run content:peter:export`。

机器建议仅供预选，不能生成正式修订。O1/O2 如果确认录音略读，必须填写理由；如果确认录音有该句，必须填写录音实际文字及整句起止时间。首次完整审核不能只听重点片段。

## 词汇编辑审核

词汇审核以已经通过字幕审核的 `dist/cues.json` 59 条字幕为唯一输入，不重新运行字幕对齐流程。371 个原始审核单元覆盖 909 个候选 token；审核后 Benjamin 与 McGregor’s 被排除为专名，最终 358 个义项覆盖 906 个可点击 token。13 组多义或多词性项目按上下文拆分，所有面向学习者的中英文释义均已重写。审核方式为 `ai_assisted_full_review`，由 `wzx` 明确授权；该记录不声称 `wzx` 本人逐项人工检查。

1. 执行 `npm run content:peter:vocab` 重建候选并生成 `review/vocab-index.html`；若有效 completed 归档存在，命令会保留已应用状态并展示完成结果。
2. 打开 `review/vocab-index.html`，逐项核对已预填的 lemma、词性、英式 IPA、当前语境的儿童化英文释义、中文释义和出现位置；必要时修改或拆分义项。不要直接把开放词典原文当作最终项目释义。
3. 本轮完成文件保存在 `review/vocab-decisions.completed.json`；重做授权的 AI 辅助审核可执行 `npm run content:peter:vocab:audit`。
4. 执行 `npm run content:peter:vocab:check`；通过后再执行 `npm run content:peter:vocab:apply`。
5. 应用器生成 `review/vocab-corrections.json` 和 `dist/vocab.json`，将 token 改写为正式 `lemma:partOfSpeech:senseNo` 引用。
6. 执行 `npm run content:peter:vocab:export`，校验 358 个审核义项与 906 个可点击 token 的完整映射，并生成正式播放器词卡模块。该步骤只关闭 X-03 客户端接线项，权利和整体发布门槛仍保持关闭。

第三方数据版本、SHA-256、许可证和修改说明见 `source/lexicon/THIRD_PARTY_NOTICES.md`。审核归档不保存逐项停留时长等行为遥测。

## C-04 元数据与 Quiz

正式权威 ID 为 `workId: peter-rabbit`、`pieceId: peter-rabbit-01`；旧客户端 ID `peter` 仅用于一次性本机状态迁移。`source/metadata.source.json` 移除了无来源的 Level 与 Pages，并将项目版本标签与外部 Series 概念分开。

`source/quiz.source.json` 包含固定顺序的 10 道双语基础理解题。每题均有稳定题号、正文 cue 引用、证据片段、三项双语选项和双语解释。80 分只用于掌握反馈，不限制内容访问；本轮不生成选项语音。执行 `npm run content:peter:c04` 会校验 cue 证据并生成 `dist/metadata.json`、`dist/quiz.json`、`review/c04-review.json` 和小程序题目模块，同时更新 `contentVersion:1` 资产哈希。审核方式为 `ai_assisted_full_review`，未声称人工终审。

## 重建

在项目根目录执行：

```powershell
npm run content:peter
npm run content:peter:align
npm run content:peter:review
# 完成人耳审核并下载 review/review-decisions.completed.json 后：
npm run content:peter:review:check
npm run content:peter:review:apply
npm run content:peter:export
# 字幕审核通过后，进入词汇审核：
npm run content:peter:vocab
# 完成词汇审核并生成 review/vocab-decisions.completed.json 后：
npm run content:peter:vocab:check
npm run content:peter:vocab:apply
# 生成并校验 C-04 元数据、Quiz 与 contentVersion:1 候选包：
npm run content:peter:c04
# C-04 候选包确认后再导出正式词卡，关闭 X-03 接线项：
npm run content:peter:vocab:export
```

构建脚本不会自动覆盖 `source/text-original.txt`。如果下载原文的清洗结果发生变化，构建会直接报错，要求人工核对源文件。
