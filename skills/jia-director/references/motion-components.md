# 可复用动效组件

当前制作须先执行[王杰已采用的花叔13项规则](huashu-rules.md)及其明确适用范围；本文保留的旧方法、组件或历史案例不是豁免。新方向三构图选择为人工节点，流程图标红；已确认方向的常规修订不重复选型。

`scripts/build-motion.mjs` 将一份本地 JSON 构建成可编辑的 HyperFrames HTML 工程。它保留以下八种基础组件，用于口播中的局部插入、姓名条、简单数值说明和已有工程的兼容展示；不是整片创作默认，也不建立核心项目状态。

整片创作先按 [motion-direction.md](motion-direction.md) 规划视觉动作、对象关系、镜头和节奏，再使用 [directed-runtime.md](directed-runtime.md) 的导演工程入口或经过实际验证的自定义 HTML。不能把八种组件轮流排满时间轴，便当作完整的视频表达；`photo-pan` 的图片推拉、标题滑入、顺序卡片也不能替代机制和叙事所需的动作。这些组件适合回答局部问题，跨镜头承接和主体持续动作由母工程组织。

| recipe | 适合表达 | 关键参数 |
| --- | --- | --- |
| `title-reveal` | 开场、章节标题 | `title`、可选 `eyebrow` / `subtitle` |
| `photo-pan` | 素材图、生成图的有限推拉 | `image`、`title`；`pan` / `positionX` / `positionY` / `zoomStart` / `zoomEnd` |
| `flow-steps` | 步骤、机制、责任传递 | `title`、2–5 个 `{label,detail}` |
| `comparison` | 并列概念与条件比较 | `title`、`left` / `right`、1–4 行 `{label,left,right}`；必须给 `source` |
| `checklist` | 操作检查、合同阅读提示 | `title`、2–5 个 `{label,detail}` |
| `metric-bars` | 有依据的数值比较 | `title`、`unit`、`scaleMax`、1–5 个 `{label,value}`；必须给 `source` |
| `quote-focus` | 需要读完的重点句 | `quote`、`attribution`、可选 `title` |
| `lower-third` | 口播姓名、主题提示条 | `name`、可选 `role` / `tag` / `side` |

这是本 Skill 自有的实现，不冒充上游仓库的原组件。视觉模式来自已经运行的寿险动效小样：蒙版标题、有限照片推拉、顺序步骤、勾选描边和重点句停留。上游动效库的检索与改编按动效目录文档执行；任何上游效果仍需转换成有限、可跳转的时间轴。

## 构建与输入

需要基础组件时，复制 `assets/motion-components/starter.json` 到项目工程目录，改脚本、尺寸、时长与素材路径。此文件使用家庭财务内容展示七种不依赖外部图片的组件，供兼容检查和局部选取；第八种 `photo-pan` 需要另行提供本地图片。它的组件轮播和 24 秒时长不是整片创作模板。调用现有 Node 和本机已核对的 GSAP；构建不会联网、安装依赖或下载字体。

```powershell
node '<skill-root>\scripts\build-motion.mjs' `
  --input '<project>\engineering\motion-v01.json' `
  --output '<project>\engineering\motion-v01' `
  --gsap '<existing-local-runtime>\gsap.min.js' `
  --font '<licensed-local-font>\font.ttf'
```

`--input`、`--output`、`--gsap` 必填；`--font` 可省。提供字体时，工程通过 `@font-face` 引入并实际使用该文件；省略时使用显式声明的本机 Microsoft YaHei，依赖回执标记此系统字体不可移植。需要跨机器交付时提供有使用授权的本地字体，并验证真实加载。输出目录必须不存在，未知/重复参数、未知字段、无效素材、重复 ID、越界时长和冲突片段都会报错。必须使用版本新目录，不覆盖已经交付的工程。

顶层字段为 `schemaVersion:1`、ASCII `compositionId`、可选 `title`、`canvas`、可选 `style`、`shots` 和可选 `captions`。`canvas` 必须包含 `width`、`height`、`duration`，默认 `fps:30`、`captionReserve:0.14`、`transparent:false`。颜色只允许 `#RRGGBB`，可改 `background` / `foreground` / `muted` / `accent`。横版与竖版使用不同排版，不只是把横版缩小。

每个 shot 包含 ASCII `id`、秒数 `start` / `duration`、`recipe`、`params` 和可选事实出处文字 `source`。单段至少 0.5 秒。全画面 shot 不可重叠；`lower-third` 可叠在全画面上，但提示条之间不可重叠。Caption 为 `{id,start,duration,text}`，段间不可重叠；预留区始终存在。这里只接受已核对的字幕时间，没有自动声文对齐。长脚本先拆场景，勿把所有文字塞进一个组件。

`photo-pan` 的 `image` 是相对输入 JSON 的本地 PNG/JPEG/WebP 路径，或本地绝对路径；不接受 URL。默认有限左向平移，缩放为 `1.12→1.05`，可改方向 `left/right/up/down/none`；缩放区间为 `1.04–1.4`，`positionX/Y` 为 `0–100` 的素材焦点。照片真实性和授权由素材登记记录，不由动效脚本推断。

每张事实图都可给 `source`，显示在图内底部。`comparison` 与 `metric-bars` 强制给出处，演示数字必须明确标注假设。数值图只支持非负值，从零起算，所有柱形共用正数 `scaleMax`，值不可超过刻度；最终数值从输入原样显示，不加不存在的小数精度。其他图表、负值、多系列和实际业务数据核验另走数据可视化路线。

`quote-focus.attribution` 不能省，避免把原创演示句伪装成名人引语。Source 文字仅记录输入者的出处说明，构建成功不表示事实已核实。

所有实际上屏的 `params` 文字、`source` 出处文字和 `captions[].text` 都通过共享 `scripts/visible-text-policy.mjs` 校验。禁止“AI示意”“AI情境示意”“初稿”“样片”“未定稿”以及“试片”“工程小样”“工程验证”“工程演示文案”等制作状态文案；带空格、零宽字符或常见分隔符的同类写法也会拒绝。错误指明输入字段，检查发生在输出目录创建之前。制作状态放在交付文件，保险合同条件、假设数据条件和真实事实出处仍可正常上屏；正常的 AI 或技术主题不被整类禁止。

顶层 `title` 只写入 HTML 文档标题和构建说明，不出现在视频画面；它与素材路径、ID、依赖版本等非显示信息不套用上屏文字规则。校验只覆盖此构建器生成的文字，不能识别图片、已剪视频或音频中自带的标签，这些素材仍须真实观看核对。

## 与两条通路衔接

**创意制作**：先完成整片的视觉动作与节奏设计、配音或阅读时间，再按局部组件的插入点构建工程。用工作区 `scripts/video.ps1 -Command render`（或本包 `scripts/run-video.ps1 -Command render`）渲染新 MP4，探测并查看实际画面、字幕和音轨。这个 builder 自身不生成或混音配音；需要完整音频与复杂镜头时，将组件源码纳入已批准的本地母工程，或将局部动效先渲染为视频素材交给现有 `build-composition.mjs`，在那里与音轨、其他素材合成。整片的主体运动和镜头承接不能交给组件轮播自动决定。

**原片剪辑**：粗剪与精剪稳定后，从原声确定插图时点。全画面动效可先渲染为 MP4，再作为现有合成器的 `video` shot，保留原片/原声时间。姓名条可构建 `canvas.transparent:true` 的 HTML 图层，但此时只允许 `lower-third` recipe；透明工程必须在实际支持 alpha 的渲染/合成器中验证。标准 H.264 MP4 不保存透明像素，不能把黑底 MP4 当透明图层，普通 MP4 流程采用带底姓名条或在母工程直接集成 HTML 图层。

HTML 内显式初始化 `window.__timelines`，外置组件脚本写入真实的 `window.__timelines[compositionId]`；每个定时片段带 `class="clip"`，满足当前 HyperFrames 的静态检查与可见性契约。GSAP 时间轴暂停且有限，不使用滚动位置、系统时间、无限 repeat 或随机画面。可以按秒跳到中间帧，也可以从尾部重新 seek(0)。HTML 引入的 GSAP、图片、组件 JS/CSS 与已指定字体文件全部为本地文件。

构建结果包含 `index.html`、可读的 `motion.normalized.json`、带 SHA-256 和用途的 `asset-manifest.json`、依赖版本与哈希 `dependencies.json`。这几份是渲染资产与构建回执，不是核心项目状态合同；构建回执明确标记 `renderVerified:false`。渲染、实际观感、音频质量和用户审片必须分别验收，技术小样保存在工作区 `checks`。
