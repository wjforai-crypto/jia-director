# 动效来源、选择与视频适配

需要找镜头方法或实现动效时读取本文件；已有明确工程只读取对应配方。包内有三组固定版本来源，来源、文件哈希和许可见 [sources.json](../assets/motion-library/sources.json)。这些资源随 Skill 携带，不依赖本机研究目录。

可选的 [video-talkcraft 接入](talkcraft-adapter.md) 单独维护：fixed SHA 上游已 staged、未启用，928文件不复制进本包；原创词表/EDL 桥与上游运行环境分开。仅在口播相关任务需要时读它，不作为另一套自动导演、字幕或音轨主流程。

| 来源 | 包内内容 | 当前用途 |
|---|---|---|
| Emil Kowalski / animate，提交 `e8a175d` | [原指南](upstream/animate/guide.md)、[14节原配方](upstream/animate/RECIPES.md)、[MIT](upstream/animate/LICENSE.txt) | 动作目的、缓动、空间关系、入退场与遮罩设计的参考 |
| LiveCanvas，提交 `d75df0a` | [完整 Remotion 折线模板](../assets/livecanvas-remotion/src/index.tsx)、data、render、package/lock、许可 | 已按原lock安装本地运行时并渲染原模板；自定义数据、工程与无覆盖导出入口见 [data-charts.md](data-charts.md)，原生3:4、3秒 |
| awesome-opus5-5-videos，提交 `3d54892` | [475条离线索引](../assets/motion-library/case-index.json)，其中13例有本地研究标签 | 检索参考镜头与原提示词；不是475个可直接渲染的组件 |

LiveCanvas 明确[引用 animate](https://github.com/pengchujin/livecanvas/blob/d75df0a90a295fc7cf634e7775df47a323ad0bea/THIRD_PARTY_NOTICES.md)，未附带它。这里保留原文用于追溯；**不将原文作为第二个可调用 Skill，不采用原文首次响应等待或其他交互流程指令**。本入口和用户要求决定制作流程。索引中的技术标签来自 Skillry 重制，不能据此判断原作技术；`promptPartial` 只是上游字段。复用第三方媒体须另核对素材权利。

## 从镜头任务选择

先按 [motion-direction.md](motion-direction.md) 写主体、事件、空间和跨镜承接，再决定需要哪些局部配方。连续动作可由 [directed-runtime.md](directed-runtime.md) 或定制工程执行，旧组件服务具体插入任务。不要因为检索得到一个模板，就把整片拆成模板轮播。离线查找：

```powershell
node (Join-Path $skillRoot 'scripts\search-motion.mjs') --query '口播 流程 机制' --limit 5
node (Join-Path $skillRoot 'scripts\search-motion.mjs') --recipe photo-pan --category motion
```

中文整句也会匹配13个研究案例的主题词；其余条目主要按作者、分类和英文技术标签检索。排序只帮助找资料。打开真正候选的固定版本 `promptUrl`，区分原帖、维护者补充和重制描述，再判断是否适合本片。没有看过案例视频就不能写“效果已认可”。

| 局部辅助任务 | 本包可构建配方 | 从来源吸收的方法 |
|---|---|---|
| 问题或观点开场 | `title-reveal`、`quote-focus` | 遮罩揭示和焦点层级；稳定结果留给阅读 |
| 图片承载人物、环境或概念 | `photo-pan` | 有限幅度的平移缩放；文字后期可控排版 |
| 步骤、条件和关系 | `flow-steps` | 列表依次建立、连接关系可见，不只播放卡片 |
| 同尺度对照与取舍 | `comparison` | 焦点切换仍保留完整对照和共同口径 |
| 检查事项或行动步骤 | `checklist` | stagger 与完成标记，节奏服从实际语句 |
| 有来源的数量对比 | `metric-bars` | 统一数值尺度、明确单位与来源，不能装饰性夸大差距 |
| 真人口播中的姓名、术语或重点 | `lower-third` | 弹出标注的入退场路径；避让脸、原字幕和关键对象 |

构建接口与参数见 [motion-components.md](motion-components.md)。这8类是本包实现；不是上游14节交互配方的逐项复现，也不是整片默认导演路线。新动效超出其表达能力时，读原配方并在当前工程中定制，不强套模板。实际播放与运动中间态按 [motion-quality.md](motion-quality.md) 复核，索引命中与技术检查都不能证明观感通过。

## 将交互动画改成视频镜头

- 将 hover、滚动、点击、手势与 DOM 挂载触发改为确定的输出秒数；不等用户交互、不读墙钟。原文的界面响应频率和300ms规则不成为视频阅读时间的限制。
- 入场后留下结论，展示动作有解释职责。入退场缓动可以不同于数据变化；数值或时间扫过时按真实尺度处理。用最终渲染测性能，不能把“某属性必定GPU加速”当成保证。
- HyperFrames 使用有限的 paused GSAP timeline，挂到 `window.__timelines[compositionId]`。每帧由时间求结果，字体/图片加载完再采样。随机或粒子固定种子；视频素材 seek 完再取帧。
- 先看动作早/中/晚与完整结果帧，检查主次层启动、接触响应和主体承接；再检查前进、后退、跨场跳转能否得到同一帧。网页滚动顺畅不能代替多线程视频渲染可重复。
- 真人补层优先保留原声和精剪时间轴。透明 HTML 需要纳入同一工程；普通 H.264 MP4 不保留 alpha，不能把黑底导出当透明贴纸。

## 配套能力按需要调用

复杂效果可读取当前宿主已启用或明确暴露的 Skill：`gsap`/`gsap-timeline` 用于时间线，`hyperframes` 用于 HTML 成片，`video-shotcraft` 用于镜头运动，`motion-reference-studio` 用于额外参考搜索；需要时再用 `lottie`/`text-to-lottie`、`animejs`、`waapi`、`three` 等。不能仅因本文出现名字就假定所有宿主都配置了它们。

React Bits 等网页组件先经过现有 motion-reference-studio 选择与视频适配；ScrollTrigger/手势组件应拆掉浏览器事件依赖。不要把所有外部库复制或安装进项目。当前8类组件使用本地已有 GSAP 文件，不要求新增 npm 包；LiveCanvas 本地运行时使用其原lock中的 Remotion 4.0.530、React 19.1.0，依赖保存在工作区runtime，不打包进Skill。读取配置并运行数据图doctor核对当前可用性。
