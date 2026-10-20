# 外部动效库与原创积累

配置入口为工作区 `config/video-workflow.json` 的 motionArchive，当前实体库在 `E:\动效资产库\motion-archive`。这是素材和代码管理工具，不是新增中央 Skill；不要复制其全部代码或其他 Skill 指令到本包。启动：`node E:\动效资产库\motion-archive\scripts\local-launcher.mjs`，默认仅监听本机，网址以回执为准。

## 查找与复用

读取 catalog/jia-index.json 或 docs/王杰动效库梳理.md，按表达任务筛选少量候选：机制/流程、产品演示、文字焦点、情绪观念、金融数据、活动权益、口播短镜。上游有 23 个模板、5 套风格、10 个背景、2 个字体；更新后重新读实际目录，不固定假定数量。原创待审与本人已确认分别保存，不能把来源作者的发布状态当作王杰的审片确认。

```powershell
$archive = 'E:\动效资产库\motion-archive'
node (Join-Path $archive 'prototype/workflow/cli.mjs') search '流程'
node (Join-Path $archive 'prototype/workflow/cli.mjs') usage editing-workflow
node (Join-Path $archive 'prototype/workflow/cli.mjs') plan editing-workflow '<实际请求.json>'
```

参数 mode 与 binding 决定实际修改方式：runtime-prop 才可直接传参；source-edit 必须复制到新工程后改源码；selection 选择已发布变体；consumer 在父工程加载风格/字体/背景。保留每包自己的时长、画幅、容量、Remotion 版本和渲染管线，不自动重装所有依赖或裁切成目标画幅。直接链接本地包与预览；查 source/limitations/rights，替换未经授权的第三方素材。库的管理页面不等于已实现自动模板渲染。

口播仍以已确认精剪时钟为准，不产生另一套原声和字幕。保留 A-roll 的关系、态度、情绪和结论；只在表达任务需要时插入镜头。不要把整片改成模板轮播。

## 保存我们自己的好动效

用户认可一个可复用动作后，按外部库 docs/原创动效保存流程.md 创建 capture 请求并保存。最低包括真实 MP4、可编辑源码、素材/字体、封面、引擎与渲染方法、固定版本、文件散列、适合/不适合、实际参数及第三方权利边界。当前支持 HyperFrames/Remotion/其他引擎的源码归档，不将 HyperFrames 伪装成 Remotion 工程。

技术通过但未被用户认可，只进入“王杰原创 · 待审”，不能默认推荐成好动效。只有上下文中已有用户对该具体作品/版本的明确认可，才用实际 manifest SHA 和确认记录执行 approve，转入“王杰原创 · 已确认”。已有认可可继续归档，不重复问；没有认可就不代签。

capture 与 approve 的接口、请求示例和保存清单位于外部库说明；文件路径通过 motionArchive.originalArchiveCli 定位。旧版本及原工程保留；每次修改提高版本，新确认另记回执，不覆盖旧源码包。捕获不包含密钥、运行环境或 node_modules，归档不等于对外发布。此路径不使用 ChatCut，不触发 MiniMax 付费生成。
