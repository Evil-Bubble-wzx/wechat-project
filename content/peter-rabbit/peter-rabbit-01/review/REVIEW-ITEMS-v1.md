# Peter Rabbit 人工复核清单 v1

> 由 `work/unmatched.json`（45 项）+ `work/alignment.json`（2 个漏读句）生成，未改任何源数据。
> 听音文件：`source/audio-original.mp3`（322026ms，5:22.026）或同文件的 `preview/audio/peter-rabbit-librivox.mp3`。
> 本文件保留原始机器问题清单。正式审核请打开 `review/index.html`：必须先完整听完全文，再完成 26 个独立词位与 O1/O2 两个整句裁决；校验通过后由脚本生成 `review/corrections.json`。
> 规则（管道设计）：不许为过检悄悄改原文；2 个漏读句必须二选一——①采用录音实际朗读文字 ②维持移除并记录理由。

## A. 45 个低置信度词（其中 26 个独立词位；R27–R45 从属于 O1/O2，不单独裁决）

### c0001

> 原文句：Once upon a time there were four little Rabbits, and their names were-- Flopsy, Mopsy, Cotton-tail, and Peter.

- [ ] **R01** `c0001:t39` 「Peter」←识别「Peter.」｜exact（识别一致但置信度低，conf=0.3013）｜试听 0:22.560–0:26.740（命中 0:24.560–0:24.740）｜判定：____ 修正为：____

### c0002

> 原文句：They lived with their Mother in a sand-bank, underneath the root of a very big fir-tree.

- [ ] **R02** `c0002:t31` 「fir-tree」←识别「tree.」｜substitution（识别与原文用词不同，conf=0）｜试听 0:27.340–0:31.580（命中 0:29.340–0:29.580）｜判定：____ 修正为：____

### c0003

> 原文句：'Now my dears,' said old Mrs. Rabbit one morning, 'you may go into the fields or down the lane, but don't go into Mr. McGregor's garden: your Father had an accident there; he was put in a pie by Mrs. McGregor.'

- [ ] **R03** `c0003:t01` 「Now」←识别「Now,」｜exact（识别一致但置信度低，conf=0.0464）｜试听 0:28.940–0:33.340（命中 0:30.940–0:31.340）｜判定：____ 修正为：____
- [ ] **R04** `c0003:t05` 「dears」←识别「dears,」｜exact（识别一致但置信度低，conf=0.3691）｜试听 0:29.560–0:34.000（命中 0:31.560–0:32.000）｜判定：____ 修正为：____

### c0004

> 原文句：'Now run along, and don't get into mischief.

- [ ] **R05** `c0004:t03` 「run」←识别「run」｜exact（识别一致但置信度低，conf=0.3996）｜试听 0:41.220–0:45.380（命中 0:43.220–0:43.380）｜判定：____ 修正为：____

### c0013

> 原文句：Mr. McGregor was on his hands and knees planting out young cabbages, but he jumped up and ran after Peter, waving a rake and calling out, 'Stop thief!'

- [ ] **R06** `c0013:t00` 「Mr」←识别「Mr.」｜exact（识别一致但置信度低，conf=0.4314）｜试听 1:18.640–1:22.660（命中 1:20.640–1:20.660）｜判定：____ 修正为：____
- [ ] **R07** `c0013:t57` 「Stop」←识别「stop」｜exact（识别一致但置信度低，conf=0.0056）｜试听 1:25.160–1:29.340（命中 1:27.160–1:27.340）｜判定：____ 修正为：____

### c0016

> 原文句：After losing them, he ran on four legs and went faster, so that I think he might have got away altogether if he had not unfortunately run into a gooseberry net, and got caught by the large buttons on his jacket.

- [ ] **R08** `c0016:t62` 「net」←识别「-brenet」｜substitution（识别与原文用词不同，conf=0）｜试听 1:44.980–1:49.380（命中 1:46.980–1:47.380）｜判定：____ 修正为：____

### c0018

> 原文句：Peter gave himself up for lost, and shed big tears; but his sobs were overheard by some friendly sparrows, who flew to him in great excitement, and implored him to exert himself.

- [ ] **R09** `c0018:t08` 「for」←识别「the」｜substitution（识别与原文用词不同，conf=0）｜试听 1:53.040–1:57.220（命中 1:55.040–1:55.220）｜判定：____ 修正为：____

### c0019

> 原文句：Mr. McGregor came up with a sieve, which he intended to pop upon the top of Peter; but Peter wriggled out just in time, leaving his jacket behind him.

- [ ] **R10** `c0019:t03` 「McGregor」←识别「McGregor」｜exact（识别一致但置信度低，conf=0.1395）｜试听 2:02.520–2:06.740（命中 2:04.520–2:04.740）｜判定：____ 修正为：____

### c0020

> 原文句：And rushed into the tool-shed, and jumped into a can.

- [ ] **R11** `c0020:t08` 「tool-shed」←识别「shed」｜substitution（识别与原文用词不同，conf=0）｜试听 2:11.420–2:15.680（命中 2:13.420–2:13.680）｜判定：____ 修正为：____

### c0022

> 原文句：Mr. McGregor was quite sure that Peter was somewhere in the tool-shed, perhaps hidden underneath a flower-pot.

- [ ] **R12** `c0022:t23` 「tool-shed」←识别「shed,」｜substitution（识别与原文用词不同，conf=0）｜试听 2:20.740–2:25.000（命中 2:22.740–2:23.000）｜判定：____ 修正为：____
- [ ] **R13** `c0022:t28` 「hidden」←识别「hidden」｜exact（识别一致但置信度低，conf=0.2068）｜试听 2:21.560–2:25.820（命中 2:23.560–2:23.820）｜判定：____ 修正为：____
- [ ] **R14** `c0022:t32` 「a」←识别「the」｜substitution（识别与原文用词不同，conf=0）｜试听 2:22.260–2:26.660（命中 2:24.260–2:24.660）｜判定：____ 修正为：____

### c0024

> 原文句：Presently Peter sneezed--'Kertyschoo!'

- [ ] **R15** `c0024:t06` 「Kertyschoo」←识别「kuchishu!」｜substitution（识别与原文用词不同，conf=0）｜试听 2:28.760–2:33.400（命中 2:30.760–2:31.400）｜判定：____ 修正为：____

### c0029

> 原文句：Peter sat down to rest; he was out of breath and trembling with fright, and he had not the least idea which way to go.

- [ ] **R16** `c0029:t00` 「Peter」←识别「He」｜substitution（识别与原文用词不同，conf=0）｜试听 2:45.460–2:49.480（命中 2:47.460–2:47.480）｜判定：____ 修正为：____
- [ ] **R17** `c0029:t02` 「sat」←识别「sat」｜exact（识别一致但置信度低，conf=0.271）｜试听 2:45.460–2:49.480（命中 2:47.460–2:47.480）｜判定：____ 修正为：____

### c0041

> 原文句：He went back towards the tool-shed, but suddenly, quite close to him, he heard the noise of a hoe--scr-r-ritch, scratch, scratch, scritch.

- [ ] **R18** `c0041:t10` 「tool-shed」←识别「shed,」｜substitution（识别与原文用词不同，conf=0）｜试听 3:48.540–3:52.800（命中 3:50.540–3:50.800）｜判定：____ 修正为：____
- [ ] **R19** `c0041:t39` 「hoe」←识别「ho,」｜substitution（识别与原文用词不同，conf=0）｜试听 3:51.660–3:55.780（命中 3:53.660–3:53.780）｜判定：____ 修正为：____
- [ ] **R20** `c0041:t41` 「scr-r-ritch」←识别「scritch,」｜substitution（识别与原文用词不同，conf=0）｜试听 3:52.320–3:56.820（命中 3:54.320–3:54.820）｜判定：____ 修正为：____

### c0042

> 原文句：Peter scuttered underneath the bushes.

- [ ] **R21** `c0042:t02` 「scuttered」←识别「scarred」｜substitution（识别与原文用词不同，conf=0）｜试听 3:56.580–4:00.920（命中 3:58.580–3:58.920）｜判定：____ 修正为：____

### c0048

> 原文句：He slipped underneath the gate, and was safe at last in the wood outside the garden.

- [ ] **R22** `c0048:t25` 「wood」←识别「ward」｜substitution（识别与原文用词不同，conf=0）｜试听 4:24.960–4:29.080（命中 4:26.960–4:27.080）｜判定：____ 修正为：____

### c0050

> 原文句：Peter never stopped running or looked behind him till he got home to the big fir-tree.

- [ ] **R23** `c0050:t30` 「fir-tree」←识别「poetry.」｜substitution（识别与原文用词不同，conf=0）｜试听 4:35.700–4:39.940（命中 4:37.700–4:37.940）｜判定：____ 修正为：____

### c0057

> 原文句：But Flopsy, Mopsy, and Cotton-tail had bread and milk and blackberries for supper.

- [ ] **R24** `c0057:t02` 「Flopsy」←识别「flopsie,」｜substitution（识别与原文用词不同，conf=0）｜试听 5:05.440–5:09.900（命中 5:07.440–5:07.900）｜判定：____ 修正为：____
- [ ] **R25** `c0057:t05` 「Mopsy」←识别「mopsie,」｜substitution（识别与原文用词不同，conf=0）｜试听 5:05.960–5:10.320（命中 5:07.960–5:08.320）｜判定：____ 修正为：____
- [ ] **R26** `c0057:t14` 「bread」←识别「red」｜substitution（识别与原文用词不同，conf=0）｜试听 5:07.200–5:11.400（命中 5:09.200–5:09.400）｜判定：____ 修正为：____

### c0012（该句已从对齐字幕移除，时间为插值，仅供定位）

> 原文句：But round the end of a cucumber frame, whom should he meet but Mr. McGregor!（详见 B 部分 O1）

- [ ] **R27** `c0012:t00` 「But」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 1:12.700–1:17.073（命中 1:14.700–1:15.073）｜判定：____ 修正为：____
- [ ] **R28** `c0012:t02` 「round」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 1:13.138–1:17.511（命中 1:15.138–1:15.511）｜判定：____ 修正为：____
- [ ] **R29** `c0012:t04` 「the」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 1:13.577–1:17.950（命中 1:15.577–1:15.950）｜判定：____ 修正为：____
- [ ] **R30** `c0012:t06` 「end」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 1:14.015–1:18.388（命中 1:16.015–1:16.388）｜判定：____ 修正为：____
- [ ] **R31** `c0012:t08` 「of」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 1:14.454–1:18.827（命中 1:16.454–1:16.827）｜判定：____ 修正为：____
- [ ] **R32** `c0012:t10` 「a」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 1:14.892–1:19.265（命中 1:16.892–1:17.265）｜判定：____ 修正为：____
- [ ] **R33** `c0012:t12` 「cucumber」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 1:15.331–1:19.704（命中 1:17.331–1:17.704）｜判定：____ 修正为：____
- [ ] **R34** `c0012:t14` 「frame」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 1:15.769–1:20.142（命中 1:17.769–1:18.142）｜判定：____ 修正为：____
- [ ] **R35** `c0012:t17` 「whom」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 1:16.208–1:20.581（命中 1:18.208–1:18.581）｜判定：____ 修正为：____
- [ ] **R36** `c0012:t19` 「should」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 1:16.646–1:21.019（命中 1:18.646–1:19.019）｜判定：____ 修正为：____
- [ ] **R37** `c0012:t21` 「he」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 1:17.085–1:21.458（命中 1:19.085–1:19.458）｜判定：____ 修正为：____
- [ ] **R38** `c0012:t23` 「meet」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 1:17.523–1:21.896（命中 1:19.523–1:19.896）｜判定：____ 修正为：____
- [ ] **R39** `c0012:t27` 「Mr」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 1:18.640–1:22.660（命中 1:20.640–1:20.660）｜判定：____ 修正为：____
- [ ] **R40** `c0012:t30` 「McGregor」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 1:18.680–1:22.700（命中 1:20.680–1:20.700）｜判定：____ 修正为：____

### c0028（该句已从对齐字幕移除，时间为插值，仅供定位）

> 原文句：He went back to his work.（详见 B 部分 O2）

- [ ] **R41** `c0028:t02` 「went」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 2:45.460–2:49.480（命中 2:47.460–2:47.480）｜判定：____ 修正为：____
- [ ] **R42** `c0028:t04` 「back」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 2:45.500–2:49.520（命中 2:47.500–2:47.520）｜判定：____ 修正为：____
- [ ] **R43** `c0028:t06` 「to」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 2:45.540–2:49.560（命中 2:47.540–2:47.560）｜判定：____ 修正为：____
- [ ] **R44** `c0028:t08` 「his」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 2:45.580–2:49.600（命中 2:47.580–2:47.600）｜判定：____ 修正为：____
- [ ] **R45** `c0028:t10` 「work」←识别「（无）」｜inferred（无识别支撑的插值时间，conf=0）｜试听 2:45.620–2:49.640（命中 2:47.620–2:47.640）｜判定：____ 修正为：____

## B. 2 个录音未朗读的电子书句子（二选一裁决）

### O1 `c0012`（anchor 命中率 0.0667）

> 原文：But round the end of a cucumber frame, whom should he meet but Mr. McGregor!
>
> 位置：上一句 c0011 [1:11.680–1:14.700]「And then, feeling rather sick, he went to look for…」→ 下一句 c0013 [1:20.640–1:27.760]「Mr. McGregor was on his hands and knees planting o…」
> 试听区间：1:14.700–1:20.640（约 5.9s），确认录音到底读了什么。

- [ ] **O1** 裁决（单选）：A.采用录音实际文字（写出：____） B.维持移除（理由：____）

### O2 `c0028`（anchor 命中率 0.1667）

> 原文：He went back to his work.
>
> 位置：上一句 c0027 [2:40.180–2:44.080]「The window was too small for Mr. McGregor, and he …」→ 下一句 c0029 [2:47.460–2:52.600]「Peter sat down to rest; he was out of breath and t…」
> 试听区间：2:44.080–2:47.460（约 3.4s），确认录音到底读了什么。

- [ ] **O2** 裁决（单选）：A.采用录音实际文字（写出：____） B.维持移除（理由：____）
