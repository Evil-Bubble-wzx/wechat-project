# 从旧听读演示项目导入的内容

此目录是 2026-09-18 从 `C:\demo11` 导入的四本旧书，与 `content/peter-rabbit/` 独立。运行 `npm run content:legacy` 可以从 `source/` 快照重建七个章节内容包、书目数据、字幕模块及小程序本地音频/封面。脚本按书籍稳定 ID 更新导入书目，不改动 Peter Rabbit 内容包或其他示例书籍。

| 书籍 | 章节 | 音频 | 状态 |
| --- | ---: | --- | --- |
| The Little Seed | 2 | 旧项目合成语音 MP3 | 待人工及商业权利复核 |
| Fox and the Star | 2 | 旧项目合成语音 MP3 | 待人工及商业权利复核 |
| Bear's Picnic | 2 | 旧项目合成语音 MP3 | 待人工及商业权利复核 |
| The Wonderful Wizard of Oz | 第一章 | 旧项目从 LibriVox 素材制作的 MP3 | 待逐句听校及目标地区权利复核 |

`source/stories.json` 保存英文句子、现有中文译文与旧测验，`source/timings.json` 保存逐句起止时间，两个词典 JSON 保存现有点词释义。`source/audio/` 为旧项目实际播放的七段 MP3，`source/quiz-audio/` 的 54 段选项朗读会复制到小程序 `quiz` 分包，`source/covers/` 为四张封面。三本原创故事的章节小测及选项音频已接入，Oz 暂无小测。`source/original/` 保留 Oz 当时使用的 EPUB 与 OGG 作为来源材料；它们不进入小程序包。各章节的 `source/text-original.txt`、`source/audio-original.mp3`、`source/rights.json`、`dist/cues.json` 和 `dist/manifest.json` 可供内容管线逐章复核，`publishable` 均保持 `false`。

小程序当前把这些短音频打包到 `miniprogram/assets/audio/`，因此在本地预览中可以播放；原生小程序使用 `InnerAudioContext` 播放本地文件，后台/锁屏能力不等同于 Peter Rabbit 的远程音频路径。正式上线须解决内容权利、远程托管和逐章复核，不能直接把演示包标记为已发布。

`source/original/pg43936-images-3.epub` 为当时使用的 Project Gutenberg 电子文本，`source/original/21179-02.ogg` 为当时使用的 LibriVox 录音。来源名称只说明导入记录；本次未核实在目标经营地区的商业使用资格，也未替素材提供法律结论。
