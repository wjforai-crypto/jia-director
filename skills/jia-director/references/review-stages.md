# 本地面板：粗剪 → 精剪切点 → 补图与动效

沿用 `rough-review` 创建和打开工程的入口；第 02、03 步现在是可操作页面。全部本地执行，不调用 ChatCut、MiniMax、云端转写或远程配音。初稿、修改审片与用户确认的流程继续保留；保存、导出和技术 PASS 都不代签用户确认。

## 精剪切点

在第 01 步导出粗剪后，第 02 步选择实际粗剪版本并载入。每个保留片段显示整数帧起止点；结束帧不包含在区间。可回听接缝、逐帧查看、调整边界，在播放位置拆成两个片段再收短中间停顿，以及恢复本轮精剪前的切点。修改后保存、导出，播放真实精剪 MP4。

只能使用所选粗剪实际存在的帧。恢复粗剪阶段已删内容、整句语义删除或改序，回第 01 步或原核心编辑工程；本页不从原片偷偷补回已删画面。每个切点保留理由，检查字头字尾、自然呼吸、表情和上下文。播放器即时跳转不是帧精确导出，也不代表已经人工试听。

复用原创 `fine-cut.mjs`：后台工作进程生成实际 cuts/plan，按实际计划散列渲染并输出 MP4、SRT、粗剪→精剪映射、QA、原片→粗剪映射副本及回执。面板导出动作提供实际计划摘要；回执另记其来源，不能称为用户完成了声音和语义审查。

## 补图与动效

在第 03 步选择真实精剪导出并载入。点击台词建立补图条目，按**精剪帧**调整区间，选择右上、右下角或全屏，填写补图功能，指定实际素材。补图区间不能重叠，避免多个素材争夺画面；复杂多图编排另用定制工程。态度、人物关系、情绪和结论优先保留人物；证据与过程可用 B-roll，抽象机制才用 MG。不自动铺满每句，不自动制造图表数据。

- **本地素材**：粘贴 PNG/JPG/WebP 或 MP4 路径。复制到工程内并登记散列；视频素材音轨不参与混音。视频必须足够长，图片可静止或缓慢推进。
- **本地关系动效**：填写来源和接收方名称，制作 4 秒关系传递示例。复用现有 `build-directed-motion.mjs` 和固定 HyperFrames：连线生长、资源移动、接收方响应。它是局部示例，可编辑源在 `stages/motion`，不能用同一模板包办所有句意。
- **交给 Codex 制作**：为缺少素材的条目填写具体场景、对象、动作和目的，保存后创建任务。界面给出 `task.json` 与中文说明路径，交给当前 Codex 执行。图片用内置 image_gen；定制代码动效用现有本地工具。完成后将真实文件路径填入独立 results.json 并登记；任务未执行就不能称为已生成。

浏览器本身没有内置模型服务，不能直接调用当前聊天的 image_gen。任务结果绑定精剪 ID 和补图编辑版本，版本已改变时拒绝登记，要求重新派发。上传录音、付费生成和外部发布不属于这个本地阶段。

预览可定位补图中间态、播放原声并同步无声素材。最终导出用 FFmpeg 在同一精剪时钟合成；原声音轨直接 stream copy，并比较输入/输出 AAC 载荷。字幕由最终父时间线控制，可选择烧录一次或仅交付 SRT。精剪、补图和音频都不产生独立第二套台词时钟。

当前面板支持右上角/右下角/全屏、图片推进与有界视频覆盖。透明动态图层、任意位置、人物小窗、跨句改序、降噪、音乐混音和更多定制镜头继续通过现有工具按任务制作，不声称本页已经实现完整多轨剪辑器。

## 本地数据和命令

`stages/fine.json`、`visual.json` 是本地编辑记录，含 revision 和冻结来源散列。并发旧版本写入被拒绝；上游修改只提示，不覆盖旧精剪或补图。改变来源前先保存当前修改。所有导出写新目录，不覆盖既有版本。

```powershell
$stage = 'E:\开发项目\视频剪辑skill\scripts\review-stages.mjs'
node $stage state --project-dir '<审片工程>'
node $stage select --project-dir '<审片工程>' --stage fine --id '<粗剪导出ID>' --revision -1
node $stage save --project-dir '<审片工程>' --stage fine --input '<编辑JSON>'
node $stage export --project-dir '<审片工程>' --stage fine --revision '<已保存revision>' --binding-id '<粗剪导出ID>'
node $stage import-results --project-dir '<审片工程>' --input '<results.json>'
```

其余参数运行 `--help`。通过本包 wrapper 也可调用 `stage-status/select/save/export` 和 `visual-task/motion/import-results`。精剪保存输入：`{revision,bindingId,segments:[{id,startFrame,endFrameExclusive,reason}]}`；补图保存输入：`{revision,bindingId,burnSubtitles,items:[{id,cueId,startFrame,endFrame,placement,motion,prompt,assetId}]}`。素材制作结果格式以创建的任务中 `delivery` 为准。

最终交付包含新 MP4、SRT、映射、输入快照、素材及散列、可修改 composition.json、实际 FFmpeg filter/参数、QA 与回执；代码动效源另在工程 `stages/motion` 保留。既有正式核心项目的 claim、锁、版本登记和审查依旧使用原核心 CLI，不由本地面板自动登记。
