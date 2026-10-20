# 上游项目去留与本地职责

当前制作须先执行[王杰已采用的花叔13项规则](huashu-rules.md)及其明确适用范围；本文保留的旧方法、组件或历史案例不是豁免。新方向三构图选择为人工节点，流程图标红；已确认方向的常规修订不重复选型。

2026-10-17。王杰已确定保留口播/无口播两条主线，无口播内部按素材剪辑、原创动画、混合制作选择；本文件执行该整合范围，不给未验通后端签收。

一个总控`jia-director`，一个原创动画制作模块`jia-motion`；参考分析、声音、资产、最终时间线与交付复用。上游的方法按需要加载，不并排安装多套导演Skill。

| 项目 | 处理 | 落位 | 吸收什么 | 明确不带入 |
|---|---|---|---|---|
| [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) | 保留底座 | jia-director最终输出 | 复用本机0.7.103、GSAP与FFmpeg，不升级；新模块交可seek工程。 | 不安装第二套HyperFrames、不把新版上游能力记为旧版已具备。 |
| [remotion-dev/skills](https://github.com/remotion-dev/skills) | 条件保留 | 需要React/已有工程时的替代后端 | 保留既有Remotion工程入口和帧时间组织方法。 | 不与HyperFrames同时争夺最终时间线，不新装一套默认双引擎。 |
| [Kianzzz/xilo-opus-video](https://github.com/Kianzzz/xilo-opus-video) | 拆解整合 | jia-motion：任务说明与预演 | 效果选栈、职责分块、实际关键帧/动态代表段、逐镜检查与局部修改。 | 不另装完整总控，不带入默认配乐/TTS、来自该项目的8分自评或beats[::4]重拍结论；新方向三方案另按王杰已采用的花叔H07执行。 |
| [lemomo-ai/lemo-opuscar](https://github.com/lemomo-ai/lemo-opuscar) | 拆解整合 | jia-motion：风格与构图 | 风格帧、风格规则与动作条带分开；按画面类型选择实际技术。 | 不内置51套完整样片，不把风格数当能力数，不并入整套core运行器。 |
| [HeiGeAi/HeiGe-Video](https://github.com/HeiGeAi/HeiGe-Video) | 拆解整合 | jia-motion：故事、主体动作与修订 | 资料转故事、主角行动、具体参考、多轮调试与本人接受后再固化。 | 不安装alpha总控/重复渲染器，不继承其额外状态机、默认声音及付费路径。 |
| [sevenevesai/riso-windowseat](https://github.com/sevenevesai/riso-windowseat) | 拆解整合 | jia-motion：版画专用规则与动作检查 | 纸张/套色的风格规则、空间尺度、动作交接和播放缺陷检查。 | 不把riso-film/still/score三套入口全开，不将持续运动/配乐偏好变成通用门槛。 |
| [JohnHeibel/ClaudeAnimationBase](https://github.com/JohnHeibel/ClaudeAnimationBase) | 拆解整合 | jia-motion：二维角色方法 | 目标、关键姿势、表情、视线、反应时间与同一舞台的叙事。 | 不复制Clawd形象，不全局禁字/禁3D，不照搬全部p5工程依赖。 |
| [feitangyuan/onetake](https://github.com/feitangyuan/onetake) | 仅方法参考 | jia-motion：界面连续性研究 | 参考跨镜同一对象、操作因果、时序分层与快门对照问题。 | PolyForm Noncommercial：本轮不复制其代码、动作库、脚本或资产进入可复用发布包。通用数学工具为本地新实现。 |
| [yihui-dev/awesome-opus5-5-videos](https://github.com/yihui-dev/awesome-opus5-5-videos) | 统一参考索引 | 导演系统资料库 | 按原帖、参考时间码、提示词来源找到可学习案例。 | 不将收录量报为可执行组件/复现通过数，不逐条下载作品。 |
| [joeseesun/opus-video-prompts](https://github.com/joeseesun/opus-video-prompts) | 统一参考索引 | 导演系统资料库 | 保留原作者链接和案例线索，按需回到原帖。 | 不整包混入生产提示词，不将未明授权提示词与素材当自有资产。 |
| [athemeroy/awesome-claude-5-5-videos](https://github.com/athemeroy/awesome-claude-5-5-videos) | 统一参考索引 | 导演系统资料库 | 来源分类、制作证据、参考迁移与流程分析。 | 保留CC-BY署名；第三方视频/音频另看，不全部塞进Skill。 |
| [guanmo-ai/awesome-ai-motion](https://github.com/guanmo-ai/awesome-ai-motion) | 统一参考索引 | 导演系统资料库 | 按作品任务找案例，保留原帖与重复来源关系。 | 不把仓库软件MIT外推给第三方作品。 |
| [JohnHeibel/PDoomVideo](https://github.com/JohnHeibel/PDoomVideo) | 独立研究复现 | 本机固定源码与画面对照 | 原片区间、章节事件、织机生长、p5.brush与本地字体经通用源码入口做局部运行验证。 | 代码、歌曲、人物与字体资产不装入Skill，不改写其许可；本机研究运行不等于可再分发或生产商用许可。 |
| [WinterArc21/Battle-of-Austerlitz-Film](https://github.com/WinterArc21/Battle-of-Austerlitz-Film) | 放弃运行接入 | 只保留案例指针 | 只参考长片的地形数据、镜头/对象/特效分层与事件组织。 | 未见LICENSE；不搬工程和素材、不引入重量运行器、不外推作者渲染速度。 |

“放弃”指不接入运行器/代码，不删除原文件、历史工程和研究快照。“拆解整合”指本地重写的任务与方法；上游完整产品未安装。许可见upstream-licenses.md，固定提交见assets/upstream-manifest.json。

## 对本机已有内容的处理

- 实拍剪辑与现有8类局部组件、场景图、粗剪/精剪、素材和声音工具保留；按项目选择。
- 原三版Roadster工程/片段保留。自建Pillow/Canvas低模三维渲染器不作为默认3D起步工程；需要3D时评估成熟后端并先做真实短段，不重写通用引擎。
- 过去的技术PASS、目录存在和本次整合不能替代本人接受。风格方法进入库，获认可的具体配方需要另留真实版本与回执。
- 不带入未授权的上游默认配音/配乐、付费生成和重复审批流程。王杰2026-10-20明确采用的花叔13项规则按[当前规则](huashu-rules.md)生效，其中新方向三方案、人物方式、数值阈值和新风格80分登记不能再视为未采用。

## 统一参考库

四个合集仅抽取原帖链接、标题线索、固定来源与重复关系，不复制完整提示词或视频。资料库位于`E:/视频文档/导演系统资料库/2026-10-17`；可用本包find-reference.mjs按实际主题检索，再回原文查看。索引命中不是效果、许可或复现通过证明。

本次运行能力以实际小样/QA回执为准：界面容器变形与对象跨镜承接单独验证，其他风格仍需各自代表段。
