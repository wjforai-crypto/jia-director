# 2.0接入说明

本机新执行能力以[2.0运行与接口](director-2-runtime.md)为准；以下旧接口、声音和既有工程说明保留，按实际任务选用，不叠加第二套流程。

# 本机运行与核心交接

## 定位已有环境

默认工作区为 `E:\开发项目\视频剪辑skill`，配置为 `config\video-workflow.json`。本包 `scripts/run-video.ps1` 调用工作区已实测的启动器，不包含模型、浏览器、密钥或依赖副本。工作区迁移后显式传 `-Workspace`；配置路径不匹配时停止，不重装或改全局 PATH。

运行 `pwsh -NoProfile -File '<本Skill目录>\scripts\run-video.ps1' -Command doctor`。检查 FFmpeg/FFprobe、Node、HyperFrames、Whisper与ASCII工作区别名。doctor只报告凭证是否存在，不能证明远程鉴权、余额、音色或创作质量。

本机 HyperFrames 锁定0.7.103，复用现有Chromium；Remotion旧工程为后备，不自动升级其依赖。视频素材native提取在本机中文路径组合下曾崩溃，统一render入口采用ASCII工程Junction、ASCII缓存/临时输出和Node `--preserve-symlinks-main`，成功后排他复制到用户的新输出路径，保留job回执。合成素材文件名也优先使用构建器的SHA256名称；自定义HTML引入中文命名媒体时另做真实提取验证，不称为已普遍验证。

ASR为whisper.cpp1.9.1与multilingual-small，用ASCII缓存避开本机中文路径问题，再经核心 `transcribe --engine import` 登记。词级接口实际为token区间，需校对；旧结果存在时启动器拒绝重转写。

原创 `scripts/fine-cut.mjs`、`scripts/talkcraft-bridge.mjs`、`scripts/personal-voice.mjs` 位于工作区，由当前 `config.workspaceRoot` 或显式工作区定位，不是928文件上游包的副本。接口分别见 [fine-cut.md](fine-cut.md)、[talkcraft-adapter.md](talkcraft-adapter.md)、[personal-voice.md](personal-voice.md)。模型、依赖、上游候选与正式 Skill 的可用状态分开报告。

宿主能调用的工具以本次发现为准。本 Skill 按用户要求排除 ChatCut，已有说明或安装状态不构成调用理由。Kimi委派是可选分支；用前读取本机唯一维护源中指定的委派说明，并在已有授权内执行。核心路由需要Kimi建议时完成其正式交接，不改低分以绕过它。

## 常用调用

Jia-video 3.0新增`materials`（取材/去重/选段）与`visual-asset-import`（登记到现有补图面板）；详见[素材库](material-library.md)。本地VideoSeek固定源码/模型/隔离依赖在`runtime/videoseek`，库和索引在配置`materials.libraryRoot`。均为可选取材模块，不改变核心CLI、ASR和已有声音路径；没有图库key也能用本地、Mixkit详情页、Commons/NASA公开路径。

在 PowerShell 中将 `$skillRoot` 设为本次实际读取的 Skill 路径。数组参数使用下面的脚本调用形式；不要把整段JSON或多个参数拼成shell文本。

核心CLI参数按 `--键 值` 成对解析，布尔值也是显式字符串；没有根级 `--help`。以本文件已核对的命令和当前源码为参数依据。

```powershell
$entry = Join-Path $skillRoot 'scripts\run-video.ps1'
& $entry -Command doctor
& $entry -Command probe -InputPath $source
& $entry -Command transcribe -ProjectDir $project
& $entry -Command preview-voice -Text $previewText -OutputPath $newWav
& $entry -Command render -ProjectDir $composition -OutputPath $newMp4
& $entry -Command core -CoreArgs @('validate','--project',$project)
```

`render`检查已有HTML、lint、布局inspect，使用独立后端导出到新路径。`preview-voice`只生成离线占位WAV。新的HTML/素材必须实际制作；运行入口不替代脚本与分镜判断。

独立静态预览和备份HTML放在合成目录以外的review目录，避免HyperFrames扫描到多个独立root；真正的子合成按后端接口连接，不以孤立备用HTML混入主工程。

本包 `scripts/build-composition.mjs` 根据[渲染说明](composition.md)生成可编辑多镜头工程；输入只描述镜头、素材和cue，不记录审批或workflowStatus。复杂自定义镜头允许直接写HTML。锁定随机种子、媒体加载与按时间seek，避免CDN/网页播放成功却无法导出的情况。

## 首次建项

原片通路先登记真实原片。下面的 `init/ingest` 适用于有真实来源的口播/已有视频项目，不适用于把新渲出的动画冒作原片。代码新创作没有 A-roll 时使用本地独立渲染与完整交付材料；当前核心要求 `source_registered` 才能继续产品计划，不能通过假的 source 或手改状态绕过。

```powershell
& $entry -Command core -CoreArgs @('init','--project',$project,'--title',$title,
  '--lane',$lane,'--source',$source,'--aspect-ratio',$aspectRatio)
& $entry -Command core -CoreArgs @('ingest','--project',$project,'--asset',$source,
  '--role','a-roll','--provenance',$provenance)
```

口播用 lane `speech`；已有适用来源的产品/混合工程按真实情况用 `product-demo`/`hybrid`。传入实际画幅，避免 lane 默认尺寸覆盖当前项目。`a-roll` 对应真实主视频素材，不用导出的动画预演来伪装原片；新创作规格显式写入工程，不从示例的480P/16秒推断。

启动器拒绝重新init已有任何核心合同的目录；继续该工程。已有brief/工程但尚无核心合同的目录可以init。其他素材使用 `ingest` 的真实role登记，例如 `supplemental`、`voiceover`、`music`；核心可登记图片及音视频，但权利来源仍需另留可核验依据。只有确定来源时使用 `user-owned`/`licensed`；别把任意URL当已授权素材。

## 无口播制作路线：独立制作或记录已有项目分镜

无真实 A-roll 时，工作区允许 `standaloneLocalRendering=true`：保存 brief、脚本、分镜、设计、实际工程、导出回执与 QA，调用本地 render 生成视频，保持待用户审片。该路线不伪报核心版本状态或核心归档通过，用户定稿仍需真实确认。要把这种创作完整纳入核心，应实现受控的无 A-roll 项目通路；不能用动画成片回灌 A-roll 偷渡现有状态机。

`plan-product --project <project> --input <json>` 在 `source_registered`、lane为product-demo/hybrid时可用。输入结构：

```json
{
  "brief": {"goal": "说明具体制作目标", "scriptFile": "实际脚本文件路径"},
  "durationSeconds": 6,
  "shots": [
    {"slug":"intro","timelineIn":0,"timelineOut":2,"semanticIntent":"提出问题","visualRole":"代码解释","onScreenText":["问题"],"acceptance":["中文可读"]},
    {"slug":"explain","timelineIn":2,"timelineOut":6,"semanticIntent":"解释机制","visualRole":"素材与动效组合","onScreenText":["机制"],"acceptance":["结果帧完整"]}
  ]
}
```

镜头从0连续覆盖duration，slug唯一。这只是已有核心的分镜登记：它不会合成视频，且会将transcript/cut-plan设为not_applicable、voiceover留空。真实配音和字幕cue仍保存到实际合成工程并登记资产。**不要在已转写的原片工程上用plan-product代替精剪，以免覆写转写和粗剪计划。**

分镜生成后实际用构建器或自定义HTML/Remotion制作导出。本地素材/代码动画可完成全片，本人正式配音按已选择的本地路线及实际回执核对；样本未建立时继续独立镜头，不把系统试音改称正式本人声音。

已有适用核心项目的顺序仍是合法 init/ingest → plan-product → 按真实需求 route-visual → record-version。plan-product 后仍在 plan_ready，不能跳过路由；核心登记不会制作成片。无 A-roll 的独立制作不执行这段交接。

## 口播剪辑路线：粗剪与精剪

1. 新的词级审片入口见 [rough-review.md](rough-review.md)，导出后用实际 `fine-cut.handoff.json` 承接精剪；面板保留原片顺序，不写核心状态。已有正式核心工程按其状态执行：转写并校对后，`plan-cut --strategy semantic+silence` 生成按segment划分的speech operation与停顿 operation。当前代码保留所有正间隔，小于0.8秒默认完整 keep，较长间隔只给出0.25秒压缩候选，不自动应用。它不是逐词自动语义剪辑，仍需回查自然节奏。
2. `review-cut` 必须为每个operation给出有理由的决定，并绑定当前cut-plan文件SHA256。speech只允许keep/drop；pause允许keep/drop/compress，compress需要合法targetDuration。精确到一个词的删改由精剪工程处理，不直接改核心JSON制造不存在的自动能力。
3. `plan-edit` 后按真实信息需求运行 `route-visual`；若decision为codex，进入visual_direction_ready。高分/显式Kimi分支执行真实建议交接或现有有证据的fallback，不能伪填评分或接受记录。
4. `render-rough --project --output --srt --label`真实调用FFmpeg，且**自动登记draft1版本**，不要给同一粗剪重复record-version。严格保留新输出路径。粗剪登记的draft1是当前核心的实现约束，不代表精剪和补图已经完成，也不要求在用户已授权全流程时额外停下来确认粗剪。
5. 精剪处理实际切点、呼吸、原声和人物构图。`plan-edit` 只生成计划，不渲染精剪；本地帧级工具按 [fine-cut.md](fine-cut.md) 的有声 CFR 粗剪、明确切点、实际计划散列合同执行，输出底片、SRT、粗剪→精剪映射与 QA。它不处理语义删改、不自动登记核心版本；原片→粗剪映射另保留。再补图/动效并导出完整初稿，用正式 `record-version --stage draft1` 登记真实新文件；此前 pending 粗剪可被标记 superseded，旧文件保留。只要求粗剪时直接交付粗剪。

`review-transcript`只改segment.text，不改words文字或重新对齐；一次correction即可将整体标记reviewed，所以必须另记录实际核查的全片覆盖，不能把该状态当作全片已审证明。字幕优先使用已校对句子，不能把旧words直接烧录为正确字幕。如果校对后重做计划使状态退回source_registered，重新生成/审查计划，而不是改status字段跳过。

校对输入使用transcript内部contentHash；即使某句文字未改，也可按真实核查记录其原样文本和原因，不能虚构听审。cut-review则使用当前cut-plan整个文件SHA256小写值，两者不能混用：

```json
{"sourceContentHash":"实际transcript内部contentHash","reviewer":"实际核查者","evidenceSources":["实际证据来源"],"corrections":[{"segmentId":"实际片段ID","text":"核查后的完整句子","reason":"实际核查依据"}]}
```

```json
{"sourceCutPlanHash":"实际cut-plan文件SHA256小写","reviewer":"实际剪辑审查者","decisions":[{"operationId":"实际speech操作ID","decision":"keep","reason":"保留完整观点"},{"operationId":"实际pause操作ID","decision":"compress","targetDuration":0.25,"reason":"缩短空停顿，保留句间节奏"}]}
```

decisions恰好覆盖所有operation；示例中的两项不是固定数量，按真实工程生成。只用已启用工具和正式CLI，不从隔离区执行候选Skill。

## 路由、版本和技术QA

```powershell
& $entry -Command core -CoreArgs @('route-visual','--project',$project,
  '--critical','0','--abstract','0','--information','1','--brand','0','--asset-gap','0')
# 上面只是简单技术样例评分；实际镜头按真实信息各项0—2评分。
& $entry -Command core -CoreArgs @('record-version','--project',$project,
  '--stage','draft1','--file',$newMp4,'--label',$label)
& $entry -Command core -CoreArgs @('qa-media','--project',$project,
  '--version-id',$versionId,'--report',$newQaJson)
```

record-version按当前状态允许draft1/draft2/final_candidate，得到真实versionId与hash；不能为被拒稿或失效的相同字节换stage重用证据。QA需要已有音视频轨，检查48kHz、音视频时长差不超过一帧、-16LUFS±1、truePeak≤-1dBTP及黑帧；freeze/silence只是提示，仍需审片。**核心confirm/review/archive并未自动强制核对QA通过记录，所以Skill在交付/定稿前必须主动运行并检查passed。**

需要修正响度时用本包实际工具，不覆盖旧版本：

```powershell
node (Join-Path $skillRoot 'scripts\normalize-audio.mjs') --input $renderedMp4 --output $newNormalizedMp4 --config 'E:\开发项目\视频剪辑skill\config\video-workflow.json'
```

它测量已有音轨后使用固定增益、过采样及延迟补偿峰值限制，保留原视频时长，视频stream-copy，输出48kHz AAC及前后测量回执；最多进行一次不超过3dB的实测增益修正。本机动态loudnorm输出在真实样例中移动了后段声音，不能只裁尾后称为对齐。原文件已有时长错位或处理后响度/峰值不满足目标时停止，需实际混音调整。工具不生成旁白，完成后仍需对真实新文件登记版本并重新QA、核对声音事件和字幕落点。用户明确要求无声或不同响度时说明现核心固定检查的边界，提供实际媒体检查，不伪报核心pass。

核心 `confirm --gate initial|final --version-id --decision approve|revise --reviewer` 仅记录已发生的用户确认。`record-review --version-id --decision pass|fail --reviewer`记录实际Agent审片，必须符合当前状态。初稿获用户确认后才能记录该轮内部审片；拒稿修改时登记新pending候选再审查。没有用户回复时保持待确认，交付可用文件和准确断点。

`archive --project --input <json>`只在final_confirmed后执行。输入entries包含文件级group/path/label，当前必需group为source、editable_project、preview、review_evidence、asset_manifest、readme；不以目录路径替代文件。它登记并验证归档文件，不搬运素材：先把文件与依赖放入归档路径，再提交、回读manifest和文件。

## 服务、付费与本人声音的实时状态

服务事实只从当前 `config/video-workflow.json`、实际适配源码及有效回执判断，不保留“尚未鉴权/尚未适配”的过时统一结论。MiniMax 当前可记录已验证的特定模型、480P、text-only、项目 claim 与预算桥；这只证明对应范围，不证明余额、所有载荷或本项目已授权。自动付费默认关闭，用户禁止时不调用。冻结 endpoint/model/resolution 与实际 provider 载荷，按本项目的 claim、费用预留、预算帽与停止条件执行，不从独立生成脚本绕过核心合同，也不把主镜头塞入不适用的参考 B-roll 槽位。

声音已选择本地优先，当前 `voice.productionMode` 为 `local-first-personal-sample-required`；口播保留原声，远程声音不自动启用。配置中的 Python、runner、model 与离线报告仍需 doctor 核验；安装/试跑通过不等于本人样本和试听完成。已有 `personalVoiceValidated`/`personalListeningAccepted` 为 false 时不能称正式本人声音已建立，具体流程见 [personal-voice.md](personal-voice.md)。付费选择与生成视频授权独立，缺口不阻碍已授权的本地制作。

Talkcraft 的 fixed commit、staged候选、授权、runtime和桥状态读取 `upstreamAdapters.talkcraft`。原创文件交换桥可用，不等于上游 Skill/runtime 已启用；禁止从隔离区执行上游安装/自动升级。当前选择本地本人声音，不接它的 Fish TTS 作为默认路径。


## 1.2 源码制作入口

`source-doctor/source-check/source-render`通过工作区`runtime/source-film`执行已有浏览器或原生命令工程，详见[源码驱动制作](source-backed.md)。它们使用独立job与新输出，不写核心确认状态；源码复现与新创作不伪造A-roll。原HyperFrames的`render`及粗剪/精剪入口不变。
