# 可执行的镜头场景图

`scripts/build-directed-motion.mjs` 将局部对象、镜头、光照和字幕编排为新建、离线、自包含的 HyperFrames 工程。它不管理原核心项目状态，不调用图片、语音或视频生成服务。现有 `build-motion.mjs` 仍用于单个叠加组件；不要用标题组件轮换代替镜头。

```powershell
node scripts/build-directed-motion.mjs --input assets/directed-motion/life-buffer.example.json --output <不存在的工程目录>
```

可显式传 `--gsap <本地GSAP文件>`、`--font <本地字体>`，优先于配置。缺省读取 `E:/开发项目/视频剪辑skill/config/video-workflow.json` 的 `render.motionGsapPath`，字体取 `render.motionFontPath` 或本机 `C:/Windows/Fonts/msyh.ttc`。可用 `--config <工作区配置>` 更换配置入口；两个资源都显式指定时不依赖默认工作区。资源不存在时失败，不联网下载、不静默降级。工程目录不能已存在。运行资源不引用 checks 验收工程；拷贝进输出后工程自身不再依赖全局配置。

## 成片审查与工程预览

成片审查优先直接播放交付 MP4。不能双击以 `file://` 打开 HTML，浏览器会阻止本工程的 ES 模块。构建器额外生成 `preview.html`，通过本地 HTTP 加载；iframe 外提供播放、暂停、重播和时间滑块，不将任何控件写入 `index.html` 或电影帧。工作区已有 Python 3.12，可前台运行其内置 HTTP 服务：

```powershell
& "C:/Users/MSN/AppData/Local/Programs/Python/Python312/python.exe" -m http.server 3108 --bind 127.0.0.1 --directory "<工程目录>"
```

在浏览器打开 `http://127.0.0.1:3108/preview.html`，结束服务时 Ctrl+C。工作区外依照实际本地工具选择已验证的 HTTP 服务，不假定存在上述 Python 路径。固定 HyperFrames 0.7.103 的 preview 语法虽已核对、服务可启动，本机 Studio UI 加载未通过验收，因此不作为此交付的可用入口。自包含指工程素材与源码本地齐全；构建器不会后台启动、安装、升级或发布服务。

预览页面可读浏览器时钟以推进播放，按帧调用子工程 `__directed.seek(t)`，或暂停的注册 GSAP 时间轴。该时钟只存在于 `preview.html`，不进入 `index.html`、evaluator 或有限导出时间轴。技术检查仍针对子工程，不能把父页面的控件录入成片。

## 输入与时间

`canvas.width`、`canvas.height`、`canvas.fps`、`canvas.duration` 必须显式给出并继承实际项目或本次已确定规格；缺项、null、非数值或越界会失败。宽320–4096、高240–4096、fps1–120且前三项为整数，duration0.5–600秒。854×480、30fps、16秒仅属于下面的示例，不是构建器或新创作的默认值。调整画幅需重新安排对象、字幕与相机，不能仅修改尺寸。

```json
{
  "schemaVersion": 1,
  "compositionId": "directed-motion",
  "title": "生活的缓冲",
  "canvas": {"width": 854, "height": 480, "fps": 30, "duration": 16},
  "style": {"background": "#07111C", "foreground": "#EDF3F5", "accent": "#F1BD71", "lightX": -0.6, "lightY": -0.8},
  "camera": {"x": 427, "y": 240, "zoom": 1},
  "nodes": [{"id": "fund", "kind": "orb", "x": 300, "y": 260, "radius": 26, "depth": 0, "groundY": 330, "shadow": true, "style": {"color": "#F1BD71"}}],
  "tracks": [{"target": "fund", "property": "x", "start": 1, "duration": 2, "from": 300, "to": 600, "ease": "cubic-in"}],
  "captions": [{"text": "把一笔钱，留给继续生活的人。", "start": 1, "duration": 5, "x": 427, "y": 420, "width": 760, "size": 25}]
}
```

- `nodes` 是整个作品共用的对象，不因段落切换销毁。对象 ID 保持，连续轨道接续其位置、光照和变形。
- composition、`stage`、`soft-light`、各 node ID、生成的 `light-${node.id}` 和 `caption-${i}` 必须在实际 DOM 中唯一；只拒绝实际碰撞，不禁用这些合法前缀。node ID `camera` 另为相机轨道目标保留。
- `depth` 范围 -500..1200。正值为远处，负值为近处；投影随相机移动产生不同视差。是 2D 分层投影，不是三维渲染。
- 图形种类：`orb`、`platform`、`gate`、`house`、`person`、`line`、`text`、`asset`。`assetPath` 可用本地 SVG/PNG/JPEG/WebP；`backgroundAsset` 可用同类本地背景。它们复制进入工程素材目录。
- 每个对象可设 `x,y,depth,width,height,radius,rotation,scale,scaleX,scaleY,opacity,light,progress,groundY,shadow,text,size,style`。`style` 只允许 `color,stroke` 十六进制颜色，不直接接收 HTML/CSS。`text` 和字幕都会经过统一可见文字检查。
- 每条 `track` 独立 `start/duration`，`target` 为对象 ID 或 `camera`。对象属性可动画 `x,y,rotation,scale,scaleX,scaleY,opacity,light,progress`；相机可动画 `x,y,zoom`。
- `ease` 为 `linear,smooth,cubic-in,cubic-out,gravity,inertia,spring,hermite`。重力是归一化二次加速；惯性是归一化指数减速；弹簧是归一化阻尼余弦响应。它们用于可解释的艺术运动，不声称求解真实碰撞或牛顿动力学。位置变化可拆为连续轨道，弹性通常只用于局部变形/停稳。`spring` 可设 `damping`(3..20)、`frequency`(2..30)。`hermite` 可设 `velocityFrom/velocityTo`，单位为坐标每秒，以三次 Hermite 接续位置与速度；相邻 Hermite 轨道在同一时刻接续时，构建器校验上一段终速度等于下一段初速度。
- 同对象同属性的轨道不允许重叠；相邻轨道必须显式接续上一条终点。最后一条结束后保留终值。需要连续速度的转场应由导演按关键阶段设计，运行时不会替作者自动补全速度。
- `captions` 是固定画面说明，不被相机带走。可承担命名、条件、标题或阅读任务，布局按语义决定，不将整片默认排成同一标题栏/清单。允许 `{x,y,width,size,color}`，颜色为 #RRGGBB，单条最多 80 字；换行可用 `\n`。与别的字幕组件合成时明确唯一字幕 owner，避免重复烧录。
- 光线采用统一主灯方向，圆形高光与投影遵循该方向。对象的 `light` 可从 0..1 改变局部照明；延迟光照、接收面变形等须按镜头逐对象写轨道，运行时不替作者全屏震动。

## 可重复定位

输出 `assets/evaluator.mjs` 中的 `evaluateAt(spec,t)` 是纯函数：每次从初始状态重新计算，不累积上一帧，不用墙钟或随机数。浏览器将同一个时间映射到全部独立局部轨道；共享主时间不等于共享运动进度。有限、暂停的 GSAP 时间轴仅驱动时间属性；属性 setter 调用 evaluator，绘制不依赖 `onUpdate` 事件。因此普通 `timeline.seek(t)` 与 `totalTime(t,true)` 抑制事件时也能正确绘制。可用 `window.__directed.seek(t)`、`window.__directed.stateAt(t)` 检查，最终渲染仍通过 `window.__timelines[compositionId]`。

## 示例与能力边界

`assets/directed-motion/life-buffer.example.json` 是 16 秒保险内容：收入资源前进、来源熄灭、最后一颗资源下落、合同条件显现、身故受益人接收保险金、资源部分分流缓冲生活责任。贯穿圆形对象、相机跟随、接收面压缩后恢复、近处光晕先响应与远景后响应是实际运动；不采用整页关系图轮替，也不渲染制作状态字。

它支持少量对象的分层动态图形、局部光影和相机承接。暂不支持三维模型、布料/液体物理、自动摄影机导演、真正连动碰撞解算、声音剪辑、自动 BPM 分析、素材中的文字 OCR。外部 SVG 中的可见文字需作者检查；构建器拒绝含 script、foreignObject、外部链接或制作状态词的 SVG。工程不会自动附加音轨。

交付包含输入、HTML、离线 evaluator/播放器、GSAP、字体/图像、素材清单与 SHA256。浏览器检查需要覆盖动作前中后、反向 seek 和同时间重复截图；最终 MP4 还应解码并查看对应动作帧。技术通过不替代用户审片。

### 当前执行证据

2026-10-05 检查工程 `checks/2026-10-05/directed-runtime/engineering-v05`：固定 HyperFrames 0.7.103 lint 为零错误、零警告；浏览器 16 个真实动作时点无页面错误、无外部请求，字体已加载，时间轴长度 16 秒。`contract-v02/contract-check.json` 的 11 项覆盖位置/速度接续、重力/弹簧实际计算、修改时长与坐标、自定义 SVG、制作状态拦截和既有输出保护。

`browser-v05-final/browser-check.json` 对直接/反向定位、抑制事件 `totalTime(t,true)`、普通 `timeline.seek(t)` 分开记录。最后一次直接反向和抑制事件定位的截图像素完全一致；三路生成 DOM 均完全一致。普通 `seek` 在 Chromium 的 SVG 栅格中存在极小像素差异：最大单色通道差 2/255，平均绝对差约 0.00447/255，约 0.446% 色通道不同；该项 `exact=false` 如实保留。此前试验中抑制事件截图也出现过近似量级栅格差异（SSIM 约 0.999966）；状态和实际可见动作稳定，不能宣称所有浏览器截图字节严格一致。不要为了消除该工具差异删除光影设计，也不要把纯函数状态确定性描述为 GPU 图像字节确定性。
