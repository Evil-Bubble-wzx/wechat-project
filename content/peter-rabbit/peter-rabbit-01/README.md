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
- 片头、正文、片尾共 57 条时间轴字幕，其中正文 55 条；
- 952 个标准原文词与 1007 个 ASR 词的序列对齐；
- 每句无损 token 化与播放器逐句切换；
- 任意正文词点击及待审核词条卡片；
- 待补充的词条索引；
- 自动 QA 和发布拦截。

尚未完成：

- 45 个低置信度词的人工时间轴复核；
- 核对电子书中存在、但当前录音未朗读的 2 个句子；
- 词性、音标、中英文释义和义项审核；
- 全文字幕、词条和权利人工复核。

所有未完成项均记录在 `dist/qa-report.json`，`dist/manifest.json` 的 `publishable` 保持为 `false`。

## 重建

在项目根目录执行：

```powershell
npm run content:peter
npm run content:peter:align
npm run content:peter:export
```

构建脚本不会自动覆盖 `source/text-original.txt`。如果下载原文的清洗结果发生变化，构建会直接报错，要求人工核对源文件。
