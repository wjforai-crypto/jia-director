# 2.0本机运行与接口

本页描述实际本机程序，不表示所有风格均已验收。工程与自测证据在`E:/开发项目/jia-director-system`；固定花叔MIT提交8a0d7d72ca65fcce6f8ba82c4a6c8dfe35b8422c，vendor不可改，runtime修改写patches。私人口播自动包装器未取得；这里实现的是公开方法的本地适配。

## 入口与宿主

用PowerShell7运行本包`scripts/run-director.ps1`，它转入项目`scripts/director.ps1`，读取旧视频工作区配置并选固定Python312。不得改用PATH上偶然出现的Hermes Python、重装浏览器或无声降帧。`doctor --out <新报告.json>`实际测Canvas像素、WebGL2 shader编译与像素、GPU名称、ffmpeg/ffprobe及Python依赖。Canvas为了可重复读帧统一willReadFrequently；WebGL硬件探针另测，不把Canvas探针当Three场景已经验收。

所有输出用新目录，不覆盖旧片。路径有空格时正常引号；先检查现有改动。每条命令失败即停止依赖步骤，不能只看文件是否存在。

```powershell
& ./scripts/run-director.ps1 doctor --out E:/视频文档/项目/doctor.json
& ./scripts/run-director.ps1 storyboard --input E:/视频文档/项目/storyboard.json --script E:/视频文档/项目/locked-script.txt --out E:/视频文档/项目/preflight.json
& ./scripts/run-director.ps1 clip validate --spec E:/视频文档/项目/clip.json
& ./scripts/run-director.ps1 clip stills --spec E:/视频文档/项目/clip.json --times '0,1,3.9' --out E:/视频文档/项目/stills-v01
& ./scripts/run-director.ps1 clip audit --spec E:/视频文档/项目/clip.json --out E:/视频文档/项目/layout-v01
& ./scripts/run-director.ps1 clip qa --spec E:/视频文档/项目/clip.json --out E:/视频文档/项目/continuous-v01
& ./scripts/run-director.ps1 clip render --spec E:/视频文档/项目/clip.json --out E:/视频文档/项目/render-v01
```

## 分镜预检

JSON顶层：style、palette（色板名或#rrggbb数组）、character.mode（none/hands/back/frames；frames需source）、example、tier、newDirection、directionSelected、duration、shots。

shot：id、start、end、background、objects数组、action={from,verb,to}、camera、text（新增重点字）、textLed、method。字幕和证据正文另列，不能塞进text偷过字数。检查具体物与动作、连续时段、2–6秒、重点字、文字镜占比、开头/结尾事件、重复推镜、两语法、金额/单位与中文数。程序只能核结构和数字对应，仍须内容/角色/动作审查；术语、复杂保险条件、计算和事实不能由数字正则代验。directionSelected仅记真实用户选择或明确代选依据。

## 画法与执行工具

| 画面需求 | 实际使用的层 | 不该替代的工作 |
|---|---|---|
| 像素角色 | 原生Canvas低分辨率/固定色板/整数放大 | 动作姿态设计、物体接触 |
| 产品UI/语义变形 | HTML/CSS/SVG或t2_keynote_ui、局部运动库 | 同物连续性、真实交互逻辑 |
| 复古屏幕/发光 | WebGL shader叠加现有内容 | 用滤镜替代主体内容 |
| 立体场景 | 当前Three工程和实际相机/灯光/物体 | 不能用2D投影标签冒称真实3D |
| 手绘/彩铅/水彩 | 当前p5+p5.brush或已接入PAINT/MEDIUM | 角色统一、笔触与纸质真实实现 |
| 数学图解 | t1_3b1b或已可用Manim原生工程 | 数学关系、公式推导的正确性 |
| 多镜头编排 | 当前确定性时间函数、Remotion或HyperFrames | 不把合成器等同某种画风 |

2.0接入8种参数语法：t1_3b1b（公式与曲线）；t2_keynote_ui（UI）；t3_finance_chart（数据）；y1_kurzgesagt（机制图解）；y2_vox（资料桌面）；y3_whiteboard（白板）；y4_storytime（角色帧）；y5_kinetic_type（文字重音）。schema是上游自定义字段合同，不是JSON Schema。工程`examples/*.json`提供可运行样例；新项目先复制再改，单段<=8秒，轨道档一片<=2语法。错误字段、缺资产、未知cue、非有限时间、片尾cue会拒绝。rare汉字缺glyph会失败，不能系统字体静默回退。

材质和相机原语：runtime/huashu/engine/lib/paint.js的PAINT.brush/watercolor/leaf/inkWash，medium.js的MEDIUM.plaster/fresco，camera.js的CAM.track/with/at/pushTo；场景eras表登记matchCut/whip等转场，live表示转场仍推进原场景。可修改示例在demos/jia_v2；这是跨材质工程测试，不能直接当一片统一风格的用户作品。先看函数实际签名，再写镜头，不凭名称猜参数。

## 风格源码与证据

`style list`查24家族；`style build`从原library重新登记但保留已绑定与旧未分范围证据；`style verify`校验源/回执。23家族有代码，1家族为方法资料。每次`style attach --id STxx --receipt <实际渲染回执> --scope <范围.json>`须指定variant、interval、expected、originalSource（该家族已登记源）、renderedSource（实际回执内源）。kind为implementation-study或reference-reproduction；后者还需selfScore>=80以及实际reference/comparison文件绑定。仅登记当前子风格/时段，不给全家族盖章。

## 口播与透明插段

1. 原声精剪和最终词表先固定。已有ASR token偏移不称强制对齐；words与audio必须有同一音轨/JSON哈希回执。新音色的身份、听感仍由本人复核，已有WAV不自动证明音色已验收。
2. `voice-cues --words <json> --audio <wav> --spec <clip.json> --mapping <映射.json> --offset <主片起点> --asr-receipt <回执> --out <新目录>`。mapping为cueIndex/keyword/必要occurrence；从真实词表找关键词，重复词未指定次序、越界、取整到片尾均拒绝。保存主/局部时间与采样误差。
   注意t2的number.at按上游合同指“数字落定”，提前0.9秒开始计数；词锚若要对应首次可见须另选事件或安排相应时点。预演按各语法真实合同检查。压缩全片时间时不能只等比缩cue、忘记横移和计数的固定动画时长；每个重要对象要留下完整呈现窗口。
3. `clip render --spec <输出clip.json> --alpha --out <新目录>`导出ProRes4444 MOV。验证像素确实有透明和可见部分，不能只检查扩展名或codec。
4. `compose --timeline <timeline.json> --out <新目录>`：video={width,height,fps,duration}；shots=[{file,duration}]；overlays=[{file,start,duration,x,y}]；audio={file}可选。时间落在输出帧网格，片长相等；透明叠层不足或音频过短拒绝，不自动循环/补静音。字幕与声音归主时间线，不让插段再带一套主音轨。
5. 核事件前一帧/当帧/后一帧、透明合成、最终音轨与完整解码。词锚采样误差与听感分开，PCM相关性只证明保留源声音，不证明音色或内容正确。

## 实片门禁、独立审核与冻结

`inspect-final --video <mp4> --production-receipt <render/compose回执> --out <新目录>`完整解码，执行固定上游film_gate算法，绑定源码/spec/素材/MP4/算法和报告。H12按已采用阈值执行，即使上游短片豁免也不会绕过红灯。30/60fps测试段可以技术渲染通过而运动门禁失败，不能因此宣称可交付。配色例外只有用户实际要求时用`--allow-blue-purple <来源理由>`，黄灯逐项审片记录。

`deliver --video ... --qa <qa.json> --review <独立review.json> --out <新冻结目录>`。review kind=independent-review，reviewer、status、coverage的from/to/mode、findings及warningDecisions，videoSha256/qaSha256/sourceSha256必须对应实际同版本。未解决问题拦截；已解决问题须issue/cause/fix/retest/destination。AI不得把userAccepted设为true。独立审核需另一个有真实审查能力的审核者；不可由执行者填一份PASS文件顶替。完整看听/抽帧/技术探针的覆盖据实区分。

冻结视频、QA、review、film-gate报告与算法；`verify --manifest <manifest.json>`复验视频、源码、输入、外部帧目录及门禁绑定。修改后重跑受影响的检查和审核。`feedback --input <问题.json> --out <新目录>`要求issue/cause/fix/destination（project/recipe/skill-candidate）、affected={path,sha256}与evidence实际通过报告路径；证据必须覆盖修复后的受影响版本，不能用空壳PASS。候选不自动修改中央Skill。

## 自测与证据边界

项目scripts/selftest.py产生新目录，单测→doctor→8语法×5变体与实际静帧/视频→连续帧QA→60fps→材质/透明口播与负例→报告。重型集成测试约数分钟，按阶段回报。程序和运行时改动使旧源回执过期；仅文档更改不冒称必须重渲全部历史片。

通过矩阵只覆盖已登记工程用例，不能证明所有未来主题/所有24风格/每台设备都稳定。实际本机报告、未通过的研究段、艺术认可与发布状态以项目验收表和冻结清单为准。
