# LiveCanvas 数据动效图

这是可直接渲染的本地折线图入口。它使用导入的 LiveCanvas Remotion 模板和单独安装的固定运行时，不在每次制作时安装依赖。与 `metric-bars` 通用组件分开使用：该入口保留上游折线、观测点、日期推进和来源说明。

## 运行前检查

在 Windows PowerShell 中，每条命令单独执行。配置读取工作区 `config/video-workflow.json` 的 `dataCharts.runtimeProject` 和 `render.browserPath`。显式 `--runtime`、`--browser` 可覆盖本次路径；没有数据图运行时配置时不会借用其他版本的 Remotion 项目。

```powershell
node "E:\开发项目\视频剪辑skill\skill-src\jia-video\scripts\render-data-chart.mjs" --doctor
```

doctor 只读报告实际安装的 Remotion bundler、renderer、remotion、React、React DOM 版本和现有浏览器路径。必须为 Remotion **4.0.530**、React/React DOM **19.1.0**，浏览器文件存在。doctor 不下载、不安装，也不证明实际成片通过检查。

## 生成合成小样

导入的 `data.json` 为合成温度示例，必须明确传入 `--allow-demo`。以下输出目录必须不存在，每次换一个新目录名。

```powershell
node "E:\开发项目\视频剪辑skill\skill-src\jia-video\scripts\render-data-chart.mjs" --data "E:\开发项目\视频剪辑skill\skill-src\jia-video\assets\livecanvas-remotion\data.json" --output "E:\开发项目\视频剪辑skill\checks\data-chart-demo-v01" --allow-demo
```

输出包括 `motion.mp4`、`cover.jpg`、帧 0/30/60/78/89 的 PNG、`render.json`，以及可编辑的模板源码。`node_modules` 通过 Windows junction 引用单独运行时，不复制入 Skill。输出固定 **1080×1440、3:4、30fps、90 帧、3 秒、H.264、无声**。这是普通视频与封面，尚未制作 Apple Live Photo 配对文件，也没有横竖版自动重排或可调时长参数。

适配器只在工程副本中加入 `Microsoft YaHei` 字体回退；原导入文件保持不变。回执保存输入原数据、输入与模板 SHA256、真实依赖版本、这些修改、素材摘要、合成标记和渲染状态。输出失败时保留工程与错误回执，不能直接复用失败目录重新运行。

## 换成真实数据

复制示例 JSON 到任务素材目录，再替换全部内容。至少保留以下结构和约束：

- `schemaVersion: 1`，`demo: false`，`provenance` 填真实来源类型；`title`、`subtitle`、`footnote`、`asOf` 清楚交代指标口径、周期和截至时间。
- `metric` 的 `kind`、`label`、`unit` 非空。`temperature` 展示区间最高观测；其他种类沿用上游首尾变化百分比（首观测为零时展示期末值）。负基数或需要其他统计口径时，先审查上游统计语义，不能仅换标题就把结果当作增长率。
- `period.start/end` 为真实 `YYYY-MM-DD` 且开始早于结束；`granularity` 仅 daily/monthly/yearly；`timezone`、`definition` 非空。
- `sources` 每项包含唯一 `id`、非空 `title`、HTTP(S) `url`。可附 `accessedAt`、`method`。每一个观测的 `sourceId` 必须能对应到来源项。
- `series` 为 1–4 条，各自具有唯一 `id`、非空 `name`、六位十六进制 `color` 和 `points`。日期在周期内、严格递增且唯一；值为有限数值或 `null`；每条至少有一个实际观测。
- `display.yDomain` 为两个有限数，低端小于高端，并覆盖全部实际观测；`display.decimals` 为 0–4 的整数。

`null` 保留缺失观测，不补值；跨大间隔也沿用模板断线逻辑（daily 7 天、monthly 45 天、yearly 400 天）。来源 URL 和标识仅做结构检查，**事实核验仍由制作任务完成**。四条系列、长标题或长来源名可能挤压原版固定版式，必须看实际 PNG 后决定是否缩短说明或重排。

当 `demo: true` 或 `provenance: "synthetic"` 任一成立时，必须 `--allow-demo`，画面强制显示“合成示例 · 非真实数据”。真实数据制作不加该开关：

```powershell
node "E:\开发项目\视频剪辑skill\skill-src\jia-video\scripts\render-data-chart.mjs" --data "E:\视频文档\本次项目\素材\chart-data.json" --output "E:\视频文档\本次项目\工程\chart-v01"
```

## 成片检查与两个通路

生成后仍需用 `inspect-video.mjs` 检查 MP4，而不是把 Remotion 直接输出的 PNG 当作最终视频解码证据。输出 QA 目录也应为新目录。

```powershell
node "E:\开发项目\视频剪辑skill\skill-src\jia-video\scripts\inspect-video.mjs" --input "E:\开发项目\视频剪辑skill\checks\data-chart-demo-v01\motion.mp4" --output "E:\开发项目\视频剪辑skill\checks\data-chart-demo-qa-v01" --expect-width 1080 --expect-height 1440 --expect-fps 30 --expect-duration 3 --times 0,1,2,2.6,2.966667
```

以 `inspect-video.mjs --help` 的当前参数为准。查看首帧、推进中、封面时间 2.6 秒、尾帧，核对文字、来源标记、实际数据点、缺失处断线、轴域和统计含义。技术渲染、抽帧审片、用户定稿分别记录。

通路一可将成片作为数据说明镜头接入母工程；通路二可在口播粗剪和精剪后，把它作为补充的全屏数据镜头。3:4 画面放入 16:9 或 9:16 时，应保持比例进行合理缩放、加背景、留出字幕，或另做经过检查的布局重排；不能拉伸图表造成轴形和数字变形。该局部渲染入口不会修改核心项目状态或替代原工作流的确认流程。
