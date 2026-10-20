# 2.0接入说明

本机新执行能力以[2.0运行与接口](director-2-runtime.md)为准；以下旧接口、声音和既有工程说明保留，按实际任务选用，不叠加第二套流程。

# 运行接口与本机验证

复用导演系统现有Node、GSAP、Chromium、HyperFrames 0.7.103和FFmpeg。不安装依赖、不升级环境、不重建另一套成片状态机。源码预览需本地HTTP，不能以file://执行ES模块。

## 创建可修改示例

在PowerShell中将`$motionRoot`设为当前实际Skill目录。所有规格显式继承任务；示例仅提供16:9布局，换画幅必须重构，不声称自动适配。

```powershell
node (Join-Path $motionRoot 'scripts/build-example.mjs') --kind ui --output '<新工程目录>' --width 1280 --height 720 --fps 30 --duration 5
node (Join-Path $motionRoot 'scripts/build-example.mjs') --kind carry --output '<另一新工程目录>' --width 1280 --height 720 --fps 30 --duration 5
```

默认配置为`E:/开发项目/视频剪辑skill/config/video-workflow.json`，只读取渲染用GSAP/字体路径；可显式传`--config`、`--gsap`、`--font`。缺资源时失败，不联网补齐。输出目录必须不存在；生成HTML、源码、媒体资源清单与独立预览页。字体/GSAP复制到项目，保留原文件，不纳入Skill包。

最终输出调用已配置导演系统的`scripts/run-video.ps1 -Command render -ProjectDir <工程> -OutputPath <新mp4>`。当前该统一入口默认导出30fps；其他帧率需经后端正式参数显式设置，不能以scene.json里的fps替代输出设置。本轮示例均为30fps。

导出后运行`node scripts/inspect-export.mjs --project <工程> --input <实际mp4> --output <新QA.json>`，对照scene.json核验宽高、帧率、时长、实读帧数和全帧解码。不匹配即失败；先修输出设置，不篡改原规格。本轮示例无配乐，不能把无音轨记为响度或听审通过。

## 确定性时间桥

`assets/motion.mjs`是本地新实现，不复制OneTake代码。标准二阶弹簧方程解析求值，改目标时继承上一时刻的位置与速度；也提供Hermite位置/速度插值。

`bindTimeline({id,duration,draw,stateAt})`通过暂停GSAP时间轴的属性写入绘制。`window.__timelines[id]`供HyperFrames使用；`window.__jiaMotion.seek(t)`和`stateAt(t)`供调试。绘制不依赖墙上时钟或上一帧，不在电影HTML里自动播放。预览控件在单独HTML中，其播放时钟不进入渲染函数。

新镜头可复用纯函数和时间桥，自行编写绘制代码；不需要套示例画面。需要真实碰撞、骨骼或复杂三维时使用相应专用后端，不能把解析弹簧叫完整物理引擎。

## 实际取样检查

```powershell
node (Join-Path $motionRoot 'scripts/inspect-motion.mjs') --project '<工程目录>' --output '<不存在的QA目录>' --playwright '<本机已安装playwright包绝对路径>' --browser '<既有Chromium绝对路径>'
```

脚本临时起仅绑定127.0.0.1的项目静态服务，检查字体、浏览器报错、各时间截图、倒序重复seek与对象ID。浏览器/Playwright位置显式指定，跨宿主不会假定能调用Codex工具；不自动下载。结束自动关本次服务与浏览器，报告与截图留在给定QA目录。

运行`node scripts/test-motion.mjs`可检查解析速度、改目标的位置/速度连续和乱序求值。它不代替真实帧与成片验收。

已构建、已导出、动作局部检查与本人接受分别报告。只有两种示例的实际回执支持对应局部结论；其他风格的适配方法不能冒充后端验通。


## 0.2 源码后端

有可运行源码时按[source-backed.md](source-backed.md)保留有效后端；Python原生命令与浏览器Canvas/p5逐帧输出可走`source-render`，规格直接来自实际spec。既有HyperFrames入口仍支持显式`-ToolArgs @('--fps','24')`等已支持参数，不以默认30fps覆盖项目规格。源码检查、最终文件和实际审片分别留证。
