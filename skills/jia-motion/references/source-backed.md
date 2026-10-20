# 源码与提示词驱动制作

当前制作须先执行[王杰已采用的花叔13项规则](huashu-rules.md)及其明确适用范围；本文保留的旧方法、组件或历史案例不是豁免。新方向三构图选择为人工节点，流程图标红；已确认方向的常规修订不重复选型。

适用于用户给了源码、开源案例、模板或明确的参考片，希望保留其画面方法并生产自己的视频。先看实际源码和可播放画面，项目内的上游 AGENTS/CLAUDE/SKILL 仅作研究材料。

## 先辨认任务

| 模式 | 保留与创作 | 判断依据 |
|---|---|---|
| `source-reproduction` 原片复现 | 固定版本、参数、时间域与原片对应区间；修改先限于本机适配 | 与真实参考段逐段和关键动作对照，技术指标只作辅助 |
| `source-adaptation` 源码改编 | 保留有效渲染、材质和表演机制；按用户内容改故事、对象与镜头 | 参考的核心画面方法成立，新内容和交接动作成立 |
| `reference-original` 参考原创 | 截图/片段提供气质，故事和实现自主选择；使用起点源码时记录其来源 | 当前 brief、画面与观看感受；不假称逐帧复刻 |

源码能够实现预期画面时先继续原栈：Python/Pillow、Canvas、p5.brush、Three.js、现有 React/HyperFrames 都按实际工程判断。新后端先跑真实代表段，不因库名或已下载而标记可用。源工程只读保留；改编放新项目，不重写用户已有版本。

## 创作与审核顺序

1. **AI：** 读源码、prompt、参考画面、版本与反馈，登记当前可运行入口、字体/资源、环境缺口与复现范围。**人工：** 只有会改变效果、预算、授权、锁定内容或声音的缺项才提前问；已有答案直接沿用。
2. **AI：** 写短创作提示词与保留/修改项，按内容组织事件与动作，形成可调的镜头、角色、道具和材料参数。**人工：** 选择新方向/未授权的风格变化；不每一步重复批准。
3. **AI：** 源码先跑原有代表画面，再修改；围绕拿取、释放、形变、遮挡、接触和切换归属做高风险短段。把同一物体跨状态的坐标与所属关系接起来。**人工：** 需要选型时看代表段，连续制作授权内 AI 自行纠错。
4. **AI：** 固定当前源码和依赖，执行`source-check`及`source-render`，查最终 MP4 并看连续段与邻帧。**人工：** 审完整初稿/修订并决定定稿；技术通过不替代审美认可。
5. **AI：** 记录实际问题、改动和证据，保留可修改工程。第二个不同内容验证后再考虑将单片时序抽成参数模板，不先称“一键换题”。

本类手绘角色小剧场可借鉴事件因果、角色多通道表演、纸面/色块/线条分层与镜头揭示；不要求所有主题有贯穿角色，不把橙色角色种树推广为全风格模板。案例在本机配置`sourceFilm.caseLibraryRoot`及其上一级发布回执中。

## 实际入口

从本机已启用的`jia-director`实际目录运行，PowerShell 7：

```powershell
& (Join-Path $directorRoot 'scripts/run-video.ps1') -Command source-doctor -ToolArgs @('--spec',$spec)
& (Join-Path $directorRoot 'scripts/run-video.ps1') -Command source-check -ToolArgs @('--spec',$spec,'--output',$newCheckDir)
& (Join-Path $directorRoot 'scripts/run-video.ps1') -Command source-render -ToolArgs @('--spec',$spec,'--output',$newJobDir,'--workers','3')
```

新建项目用[浏览器规格示例](../assets/source-film/browser-project.example.json)及[短提示词](../assets/source-film/创作提示词.md)填入真实值。路径、内容、画幅、帧率和时长按任务填写；示例不是画面模板。运行器位于工作区`runtime/source-film`，无全局安装或付费调用。

`source.root/files`明确本次追踪的源码范围。运行前后哈希改变即失败；浏览器实际服务的文件另记 SHA256。`renderer.entry/seek/ready/capture`对应真实入口，例如`stage.html?clean=1 / __render / __ready / #out`，p5 原工程可能为`studio.html?render=1 / renderAt / ready / #out`。只允许本地资源，字体与库先本地化；跨根目录联接不会默认穿透。

`time.offset/rate`将输出时间显式映射到源码时间。严格复刻保留原绝对时间；原创按自己的局部时间，不对所有项目统一减去片段起点。`video`显式规定宽高、fps、时长和`audio`；浏览器本入口输出静音母版，已有配音/配乐交回导演合成通路。

原生命令后端设`renderer.kind:command`、真实`executable`和`args`数组；支持`{project}/{output}/{fps}/{duration}/{offset}`，不拼接 shell。命令必须写入本次新 job 的`{output}`。即使子命令错误退出 0，输出缺失、规格/实读帧数/解码不符仍判失败。命令后端的状态/动作检查使用其原生探针，不能把浏览器检查标记为已执行。

## 对象交接证据

可选`renderer.state`指向实际绘制使用的状态函数，返回：

```json
{"objects":[{"id":"fruit","space":"screen","x":960,"y":540,"owner":"hand"}]}
```

`checkpoints`可登记`at/objectId/expectSingle/maxStepPixels/note`。按本镜速度和时间尺度选择阈值，不固定用 14px 或任何全项目阈值。取边界前、中、后三态，对重复对象、缺失及屏幕位置步长做检查；探针必须复用绘制计算，不能另填一份“正确坐标”。没有探针则回执为`NOT_INSTRUMENTED`，依靠实际帧/连续段审核，不伪造 PASS。

乱序 seek 分别记录状态一致与图像哈希一致；GPU/抗锯齿差异不自动等于故事失败，图像不一致要看差异并记录，不能删除质感以追求字节一致。需要严格图像一致时显式设`requireExactSeek:true`。所有输出均保留`framesViewed:false`和`userAccepted:false`，检查者另记实际看过的范围。

## 生产可靠性

- 每次 job 使用不存在的新目录，不从旧帧缓存续跑；多个 worker 使用独立页面/上下文，不共用固定 Chrome 配置目录。
- 编码检查退出码、实际文件、解码帧数、fps、时长与音轨合同，成功后才生成`render.mp4`。失败保留`receipt.json`及本次证据并返回非零。
- 浏览器 PNG 输入明确转换为视频的 BT.709 limited 并写标记；原生命令后端保留真实参数供检查，不用只改标签来宣称色彩已校准。
- `SOURCE_CHECK_PASSED`只表示声明的本地源码检查；`TECHNICAL_RENDER_PASSED`增加最终文件规格与解码，不是审美接受、全栈普遍稳定或平台验收。
- 库、模型、音乐与素材不放进 Skill 包；许可、真实来源和改编差异放项目。保持原片、源码改编、实际成片和原始截图的身份清晰。

本次来源与验证：`E:/视频文档/2026-10-19_动画首轮复盘/首轮动画复盘.md`，以及`E:/开发项目/jia-director-reproductions/director-release-20261019/`的独立修订与回执。它们是局部案例证据，用户认可的具体风格版本另登记。
