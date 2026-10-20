# 本地多镜头合成构建器

入口为 `scripts/build-composition.mjs`。使用 Node 自带模块，无新增 npm 依赖；依赖现有 `ffprobe` 读取本地媒体。已按 HyperFrames 0.7.103 的 `data-*`、`data-no-timeline` 和可 seek CSS 约定实现。

输入只是**渲染资产说明**，不是第二套项目状态合同。构建器不创建核心项目、不修改审批、不登记定稿、不执行归档。口播仍由核心流程确定切点与审片，生成素材仍需原有授权与交接。

这个基础构建器保留原接口和简单 fade/none 行为，主要承担原片剪辑后的媒体、原声、字幕与局部补图合成，不是整片创意导演入口。整片创作先按 [motion-direction.md](motion-direction.md) 完成视觉动作、镜头和节奏设计，再使用 [directed-runtime.md](directed-runtime.md) 的导演工程入口或经过实际验证的自定义 HTML；不得把一组 `card` 加入场动画便当作动效视频。

八种基础动效仍由 [motion-components.md](motion-components.md) 的独立 `build-motion.mjs` 制作，用于局部插入和兼容展示；需要组合时先导出镜头，再作为本构建器的 `video` 素材。需要局部透明叠加或复杂转场时将动效源码纳入自定义 HTML，而非假定基础构建器已经支持 alpha 或所有动效参数。原有媒体边界、轨道、原声和版本保护规则继续适用。

## 命令

```powershell
# $skillRoot 使用本次实际读取的已启用 jia-video Skill 所在目录
node (Join-Path $skillRoot 'scripts\build-composition.mjs') `
  --input 'E:\你的工程\render-description.json' `
  --output 'E:\你的工程\composition-v1'
```

`--output` 必须是全新目录，既存空目录也会拒绝。`--ffprobe '<可执行文件路径>'` 可覆盖默认 PATH 中的 ffprobe。素材的相对路径以输入 JSON 所在目录解析；不接受 HTTP、data、file 等 URL，不下载素材。

输出包括：

- `index.html`：可编辑的 HyperFrames 合成源码。
- `assets/`：本地素材副本，以完整 SHA256 与原扩展名命名。
- `asset-manifest.json`：原绝对路径、实际路径、SHA256、字节数、媒体探测信息及镜头使用位置。它记录可追溯性，**不证明版权授权**。
- `render-description.json`：输入说明的副本；里面的原素材路径不会自动改成新相对路径，重建时应继续使用原输入文件，或自行改成 `assets/` 副本路径。
- `README.md`：合成与验收边界。

先验证全部输入与素材，再在独立临时目录复制；复制后的哈希必须匹配。输出目录以排他创建方式预留；失败时仅清理本次创建的临时/输出目录，不留半个成品，不覆盖旧版本。

## 真实 JSON 格式

以下例子要求 `images/reference.png`、`video/source.mp4` 和 `audio/narration.wav` 真实存在，并分别满足镜头时长和 trim 要求。

```json
{
  "title": "寿险的功能与意义",
  "canvas": { "width": 1080, "height": 1920, "fps": 30, "duration": 9 },
  "style": {
    "background": "#07111f", "foreground": "#f6f8fa",
    "muted": "#b6c7d8", "accent": "#34d399",
    "fontFamily": "Microsoft YaHei", "motion": "fade"
  },
  "shots": [
    { "id": "intro", "type": "card", "start": 0, "duration": 3,
      "title": "先说清楚这个概念", "text": "一句话解释，避免挤入整篇正文。" },
    { "id": "reference", "type": "image", "start": 3, "duration": 3,
      "source": "images/reference.png", "fit": "contain", "title": "查看可核验的材料" },
    { "id": "source", "type": "video", "start": 6, "duration": 3,
      "source": "video/source.mp4", "mediaStart": 1, "sourceAudio": true,
      "volume": 1, "fit": "contain" }
  ],
  "audio": [
    { "id": "narration", "source": "audio/narration.wav", "start": 0,
      "duration": 6, "mediaStart": 0, "volume": 1, "track": 10 }
  ],
  "cues": [
    { "id": "caption_intro", "type": "subtitle", "start": 0.2,
      "duration": 2.3, "text": "已经人工校对的字幕", "track": 20 },
    { "id": "explain", "type": "overlay", "start": 3.2,
      "duration": 2.4, "text": "解释性文字", "position": "top", "track": 21 }
  ]
}
```

| 字段 | 约定 |
|---|---|
| `canvas` | 必填；整数画幅，宽 320–8192、高 240–8192；fps 默认30、范围1–240；总时长大于0且不超过3600秒 |
| `shots` | 1–500个；类型 card/image/video；每条必须有全局唯一 ASCII `id`、`start`、正数 `duration`；默认 track=0 |
| `title/text` | 中文或其他纯文本；转义 HTML，不执行文本里的标签或脚本；card 至少有一项非空 |
| `source` | image/video/audio 必填本地文件；图片限静态 PNG/JPEG/WebP，避免动画与 SVG 外部依赖 |
| `fit` | 图片/视频默认 contain；cover 必须显式选择，会裁切画面，需人工检查 |
| `mediaStart` | 视频与音轨的源素材起点，默认0；`mediaStart + duration` 不得超过对应流的探测时长 |
| `sourceAudio` | 视频有音频流时默认保留；false 明确静音；显式 true 但缺少音轨会拒绝 |
| `volume` | 0–1，默认1；只是静态增益，没有响度统一、ducking 或自动声音设计 |
| `audio` | 可选本地配音/音乐/音效；默认 track=10；时长和源起点必须明确 |
| `cues` | 可选有限字幕或解释文字；字幕默认 bottom/track20，overlay默认 top/track21；position仅top/bottom |
| `track` | 0–999整数；所有 shots/audio/cues 统一检查，同一轨道不许重叠，紧邻边界合法；不同轨道可同时播放，须自行避免视觉/声音冲突 |
| `style` | 可选；颜色只接受六位十六进制；字体使用本地已存在字体，未安装时由浏览器后备；motion=fade或none |

镜头 `shots[].title` / `shots[].text` 与字幕、叠加文字 `cues[].text` 在生成任何输出前通过共享 `scripts/visible-text-policy.mjs` 检查。制作状态文案“AI示意”“AI情境示意”“初稿”“样片”“未定稿”“试片”“工程小样”“工程验证”“工程演示文案”会拒绝，并报告具体字段；状态写在交付文件。正常 AI、技术主题及保险合同条件允许，素材 `source` 在这里是文件路径，不按显示文字误禁。顶层 `title` 仅为 HTML 文档标题和交付说明，也不按视频画面文字处理。构建器不识别素材本身含有的字或声音，嵌入式标签仍须观看原素材和实际成片核对。

画幅与时间由输入明确给出，不强制竖屏；主体镜头按数组顺序确定 z-index，不按 track 决定视觉层级。生成的媒体子元素使用保留的1000以上轨道，用户 `id` 不得与 `<镜头id>-media` 冲突。

## 渲染与复核

通过现有工作区入口运行 lint、布局 inspect 和渲染：

```powershell
pwsh -NoProfile -File (Join-Path $skillRoot 'scripts\run-video.ps1') `
  -Command render -ProjectDir 'E:\你的工程\composition-v1' `
  -OutputPath 'E:\你的工程\renders\draft-v1.mp4'
```

这个入口保留新输出保护。复杂定制仍可由 Agent 直接修改**新版本** HTML：图表、Canvas/SVG/Three.js、品牌视觉、局部放大、真人 PiP、跨镜头动效、精确字幕断行都不必压进此基本模板。

当前模板只提供硬切、少量有限 CSS 入场、简单标题/解释文字以及上下方 cue。媒体位于预留矩形，标题与解释文字应保持简短；不自动测量中文长文后重排。样式默认来自工作区技术小样，不代表王杰已认可的全片视觉风格。CSS 使用固定时长与暂停动画，交给 HyperFrames seek，不依赖 wall clock、随机数、CDN 或运行时 TTS。

不做：事实研究、文案审校、ASR/强制对齐、字幕自动断句、生成视频/配音、语义口型同步、复杂转场、音频响度修复、正式成片验收。不同轨道的媒体可以混音，没有自动压低；字幕时间由调用者提供。没有旁白或源声音时不会自动制造音轨，无声动画与核心要求双轨的 qa-media 需分别判断。字体、长文本是否溢出、主体是否被裁切、每片规格以及声音品质仍需实际 inspect、解码查看和听审。构建成功不等于渲染通过或用户定稿。

本地行为与兼容验收证据位于 `checks/2026-10-03/skill-build-unit/`。其中复用的是本工作区中文技术试读、技术验收图像与视频，不是正式素材作品。
