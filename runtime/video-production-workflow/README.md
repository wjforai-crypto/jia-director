# Video Production Workflow 2.1

独立于王杰工作台的真实视频生产核心。Codex 负责语义剪辑、任务编排、实现整合、测试、审片和归档；工作台只读取项目合同并显示控制面；Kimi Code 仅在视觉评分达到阈值后，以受控任务包参与视觉建议或少量重点镜头。

## 运行边界

- 核心引擎：Node.js 22 + TypeScript + FFmpeg/FFprobe。
- ASR 基线：本机 whisper.cpp；可导入兼容的 Whisper JSON。
- Kimi：只读取 `prepare-kimi` 生成的脱敏任务包，不决定删词和主时间线。
- Workbench：只读同步固定的九份 JSON 合同，不承担剪辑渲染。
- ChatCut / Script Cut：可选执行器，不是默认精剪引擎；是否能调用必须以当前会话实际暴露的提交与进度工具为准，不能把已安装插件文件当成可调用证明。
- 剪映：通过 MP4、SRT、素材清单和剪辑决策清单接力，不承诺第三方可编辑项目转换。
- B-roll：本核心规划槽位并生成哈希绑定的外部执行包，硬性分开“完整提示词审批”“短期执行 claim”“付费生成”和“返回结果审片”。当前正式启用的 `minimax-broll-generator` 仍是 Schema 1.5，只确认了单测与 dry-run，且尚未适配新的 claim 契约；仓库 H3-current 候选因安全与集成阻断已拒绝提升。核心命令不会隐式发起付费调用。

## 项目合同

每个视频项目根目录包含：

- `project.json`
- `assets.json`
- `transcript.json`
- `cut-plan.json`
- `edit-plan.json`
- `visual-routing.json`
- `kimi-visual-direction.json`
- `review.json`
- `archive-manifest.json`

参考视频原创仿拍路线按需再增加两份合同，不会污染目标视频的 `transcript.json`：

- `reference-analysis.json`：原片事实证据、可由词级证据重建的原片逐字稿、逐镜头拆解、剪辑/声音语法、可迁移机制和禁止复制项。
- `recreation-plan.json`：新片 Brief、受保护元素逐项替换表、目标逐字提词稿、拍摄表、剪辑蓝图以及带稳定 ID 的 B-roll/MG/SFX/BGM 槽位。

同时生成便于审核的 `reference-analysis.md`、`recreation-board.md` 和 `teleprompter.txt`。参考片审批、仿拍方案审批和实际 Edit Plan 映射均绑定内容哈希；参考视频字节、参考分析或目标方案变化后，旧批准不能继续使用。

状态机固定为：

`intake → source_registered → plan_ready → visual_direction_ready → draft1_pending_user → draft1_approved → revision_in_progress → internal_review_passed → draft2_pending_user → final_confirmed → archived`

登记文件不会自动确认。初稿与第二稿的用户确认均绑定文件 SHA-256，文件变化会让旧证据失效。

## 开发

```powershell
npm install
npm run check
npm run dev -- <command> [options]
```

## 已实现命令

| 命令 | 作用 |
| --- | --- |
| `init` | 建立九份版本化项目合同 |
| `ingest` | FFprobe 探测、流式 SHA-256 和素材登记 |
| `transcribe` | 运行 whisper.cpp 或导入 Whisper JSON，保留稳定 word ID |
| `review-transcript` | 以输入哈希绑定的审计记录校正 ASR，不改词级时间戳 |
| `plan-cut` | 分离完整语义单元和机械停顿候选，不自动删语音 |
| `review-cut` | 审定每个保留、删除或停顿压缩决定 |
| `plan-edit` | 由已批准 Cut Plan 生成稳定镜头 ID 和 Edit Plan |
| `plan-product` | 为软件演示直接生成锁定时间线和稳定镜头 ID，不伪造转写证据 |
| `route-visual` | 计算五维 Kimi 评分与隐私路由 |
| `record-privacy-review` | 在视觉路由前登记敏感项目的外部处理授权、登记源素材、独立脱敏复核人及逐个批准输出哈希 |
| `prepare-kimi` | 对 6–12 张已哈希关键帧生成边界明确的 Kimi 任务包；敏感项目只复制已批准帧和脱敏 Edit Plan 到隔离目录；新任务包在此处占用调用额度，可用 `--session` 续接旗舰会话 |
| `import-kimi-review` | 重新核验隐私与输入证据、同会话约束、建议范围及四项保护约束 |
| `record-kimi-failure` | 登记 timeout、429、不可用或无效输出；首败只授权同一哈希任务包的一次重试，重试再失败后封锁外部调用并进入待 Codex 回退 |
| `complete-kimi-fallback` | 导入覆盖所有已选镜头的本地 Codex 视觉方案；只有方案、保护约束与输入哈希通过后才满足视觉门 |
| `decide-kimi-review` | 逐镜头登记 Codex 的采纳、调整或拒绝结论 |
| `accept-kimi-scene` | 绑定实现文件和实现前后关键帧哈希，登记真实验收归因 |
| `render-rough` | 用 FFmpeg 真实裁切、拼接、响度处理并生成 SRT |
| `probe-mechanical` | 可选调用哈希锁定的 auto-editor，只生成独立机械候选，不改语义 Cut Plan |
| `analyze-reference` | 将已登记的 `role=reference` 实际视频与人工/模型分析输入固化为哈希绑定的原片逐字稿、镜头表和视听语法；不写目标 `transcript.json` |
| `review-reference` | 对参考片逐字稿、镜头边界、可借鉴机制和保护边界执行人工审核；参考字节漂移时拒绝批准 |
| `plan-recreation` | 基于允许原创改编的已批准参考分析生成目标脚本、逐字稿、替换表、详细拍摄表、剪辑蓝图与表格化审核件；`analysis_only` 不得进入本命令，平台和画幅必须与项目一致，替换项必须绑定真实 JSON Pointer 目标字段 |
| `review-recreation` | 按内容哈希批准或退回仿拍方案；审核表展示完整拍摄参数、B-roll 来源/授权/资产哈希和生成提示词；撤回已应用或中断中的方案时回滚 Edit Plan，并让依赖它的审片证据与定稿状态失效 |
| `apply-recreation` | 用显式镜头映射把已批准蓝图写入现有 Edit Plan；验证目标逐字稿→实拍 Transcript→Cut Plan→Edit Plan 的文字与哈希链，并给实际镜头绑定生成投影哈希；同一 pending 事务可恢复，不改目标逐字转写或 Cut Plan |
| `prepare-broll-handoff` | 将一个已批准的 `generated_after_approval` 槽位编译到项目内唯一规范路径，绑定完整提示词、隐私合同、有效生成载荷和所有证据/生成输入素材的字节哈希；不调用付费 API，敏感项目直接阻塞。退回后必须用 `--revision-of`、`--revision-reason` 和 `--revision-prompt-file` 提交真正变化的完整提示词；尚未审批的修订可用 `--supersede-pending-revision true` 受控替换 |
| `approve-broll-handoff` | 用户按精确槽位和 `contentHash` 批准外部执行包，并记录送审文件 SHA-256；operator 无权代批。审批本身不授权付费调用 |
| `claim-broll-execution` | 受控执行器在真正请求模型前取得 60–3600 秒的执行凭证；此时重新核对当前方案、隐私状态、外部处理权限和全部输入字节。结果必须回显 `executionClaimHash` |
| `reconcile-broll-execution` | 只有用户或操作者明确确认“请求从未提交”，并绑定现有 claim hash、写明原因时，才释放失效/中断的执行凭证；保留旧凭证历史，禁止自动续签导致重复付费 |
| `import-broll-result` | 回读外部 manifest，核验输入哈希、视频字节和 FFprobe 时长/画幅，再由核心从返回视频独立抽取 entry/climax/exit 关键帧；不信任执行器提供的图片代替视频证据，结果保持待用户审片 |
| `review-broll-result` | 用户按结果、视频和核心抽帧哈希接受或退回 B-roll；接受时还必须用 `--rights-confirmed true --rights-basis <依据>` 明确确认本项目使用权。退回后的相同字节不能改判通过，必须准备有效载荷已变化的修订执行包/结果；未接受结果不能进入 Edit Plan |
| `qa-media` | 校验文件哈希、48 kHz、音画同步、LUFS、True Peak 和黑帧；报告使用 `--report <file.json>`，兼容旧参数 `--output`，且禁止覆盖媒体文件 |
| `record-version` | 登记哈希绑定的初稿、第二稿或最终候选 |
| `confirm` | 执行初稿或定稿用户确认门；定稿通过前会阻止未收口的付费 claim，并要求当前方案已应用、每个生成 B-roll 槽位已有用户接受且完成权利/素材登记 |
| `record-review` | 在初稿确认后登记 Codex 独立审片结论 |
| `prepare-jianying` | 复制 MP4、SRT、素材和剪辑决策到哈希绑定的接力包；只登记“已准备、未导入”，不改变项目状态 |
| `archive` | 在用户确认定稿后校验六类必需文件、写入哈希并进入归档状态；当前方案的生成 B-roll 必须已接受、确认使用权、应用到 Edit Plan，且 handoff、result、供应商 manifest、视频和核心验收帧会自动进入 `generated_broll` 归档清单 |
| `validate` | 按 JSON Schema 校验九份核心合同、可选参考视频合同，以及已登记 B-roll handoff/result，并重验真实媒体与素材字节 |

auto-editor 机械候选必须显式启用并锁定二进制哈希，例如：

```powershell
npm run dev -- probe-mechanical --project <project-dir> --engine auto-editor --executable <auto-editor.exe> --expected-sha256 <sha256> --output <project-dir>\mechanical-candidates.auto-editor.json
```

该命令在工具和源素材的隔离副本上运行，只接受线性、单视频轨、单音频轨、无 effects/transitions 的 v3 时间线；输出仍是 `candidate_only`，不会修改 `cut-plan.json` 或工作流状态。

## 参考视频原创仿拍

最小执行顺序：

```powershell
npm run dev -- ingest --project <project-dir> --asset <reference.mp4> --role reference --provenance public-reference
npm run dev -- analyze-reference --project <project-dir> --asset-id <asset_id> --input <reference-analysis-input.json>
npm run dev -- review-reference --project <project-dir> --decision approve --reviewer <user> --authority user
npm run dev -- plan-recreation --project <project-dir> --input <recreation-plan-input.json>
npm run dev -- review-recreation --project <project-dir> --decision approve --reviewer <user> --authority user
```

上述阶段先产出并确认“怎么拍、说什么、准备哪些素材”。目标 A-roll 拍完后，仍须走原有真实粗剪链路：`ingest --role a-roll → transcribe → plan-cut → review-cut → plan-edit`（产品演示可走 `plan-product`）。只有项目已经处于 `plan_ready`、当前 `edit-plan.json` 为 `ready`，并生成了同时绑定目标 `transcript.json`、`cut-plan.json`、`edit-plan.json` 当前 SHA-256 的镜头映射文件，才执行：

```powershell
npm run dev -- apply-recreation --project <project-dir> --input <shot-mapping.json>
```

`referenceVerbatimTranscript` 只表示原片实际说了什么；`targetVerbatimScript` 才是新片拍摄时使用的提词稿。默认模式只借鉴结构、节奏、信息层级与通用镜头语法，不复制原台词、人物身份/声音、商标、品牌 UI 或受保护画面。只有 `authorized_close_recreation` 且附权利证据时，系统才允许更接近的复现模式。

参考仿拍方案中的 B-roll 槽位只代表“准备生成/采集什么”和“送审前必须使用的完整提示词”，生成状态仍是 `pending_plan_review`。每个槽位有稳定 ID；审核表必须显示来源策略、授权文件哈希、素材哈希，以及生成执行器、模型、模式、完整提示词和提示词哈希。`licensed_stock` 不仅要绑定授权文件，还必须绑定 `assets.json` 中权利已清晰的真实素材 ID、素材 SHA-256，并在建计划、复核和应用时重新验文件哈希。用户批准具体镜头后，先运行 `prepare-broll-handoff` 形成项目内唯一、隐私与有效生成载荷哈希绑定的执行包，再用 `approve-broll-handoff` 对精确内容做用户审批；审批不等于可以付费调用，受控执行器必须紧接请求前运行 `claim-broll-execution`，结果 manifest 回显同一 `executionClaimHash`。claim 后若进程中断，不能自动重试；只有查明根本没有发出 provider 请求，才能用 `reconcile-broll-execution` 绑定旧 claim 释放并保留审计记录。敏感项目不创建 MiniMax 外发包，应先建立经过独立审核的脱敏、非敏感项目包。退回后重试必须改写完整提示词或其他有效载荷；审批前改稿使用受控 supersede，旧包保留为不可执行历史证据；撤回或替换方案会把相关 handoff 全部标成 `stale`。当前正式启用的 `minimax-broll-generator` 尚未完成本核心 claim 契约的生产适配；仓库内 H3-current 候选经审计已拒绝提升，不能冒充已上线。返回结果由核心重新探测视频并自行抽取三类关键帧，`review-broll-result` 还要记录用户对生成内容使用权的明确确认；通过后只登记素材，不直接偷改主时间线。归档前当前方案必须真正 `apply-recreation`，并由归档器自动纳入生成视频与完整审计证据。旧方案 handoff 继续作为历史证据验证，但不能满足新方案槽位。若执行器未被当前会话发现为已启用且兼容能力，保留待生成槽位并报告阻塞，不改用未验证可调用的 ChatCut。

准备、审批、claim、释放、导入、审片、素材登记、隐私授权、参考/方案撤回、版本确认与归档，共用项目级状态锁，防止不同镜头或独立进程互相覆盖。同一事务不得再次进入公共加锁入口；需要组合操作时只能调用会验证当前锁权的内部步骤，避免未等待的子任务越过锁生命周期。异常退出遗留的 `.video-flow-project-state.lock` 表示跨文件写入或外部付费请求状态可能不明；不得按 PID 或时间自动删除，必须先核对 provider 任务、当前 claim 和各合同文件，再由操作者处理恢复。

原片 `protectedElements` 与方案 `mustReplace` 的并集必须逐项写进 `replacementMap`，说明是替换还是在近似复刻授权内复用、替代内容、验收方法，以及实际落到新片合同中的 `targetPaths`。每个路径必须是存在的 JSON Pointer，且只能指向 Brief、目标逐字稿、拍摄表或剪辑蓝图等批准字段；每个 `replace` 项还必须给出至少一个 `replacementAnchors`，锚点既要出现在替代说明中，也要真实出现在所绑定的目标字段里，防止用无关路径伪装“已替换”。近似复刻授权还必须绑定参考素材 SHA-256、权利主体、逐项获准元素、授权文件哈希、核验人和核验时间；`licensed_reuse` 的 `sourceElement` 必须精确存在于授权元素中。

`recreation-application.json` 是可恢复事务：`pending` 可用完全相同的 mapping 继续应用，也可通过 `review-recreation --decision revise` 受控回滚；回滚过程使用 `rollback_pending → rolled_back`，即使在 Edit Plan 已解绑而方案记录尚未撤回时中断，也能根据回滚哈希继续完成；遇到第三种未知 Edit Plan 状态会停止而不猜测覆盖。已经应用的方案不得被 `plan-recreation` 直接覆盖；先撤回后重建时，旧 application 审计记录会保留。撤回会把项目退回 `revision_in_progress`，使依赖该方案的版本证据失效，并阻止旧 `final_confirmed` 继续归档；同一旧成片字节不能重新登记为新证据，必须重新渲染。

本轮对目标微信视频 `https://weixin.qq.com/sph/AA8ST0Zriq` 的验证只取得落地页和公开元数据，未取得可回放的视频、音频、时长或字幕；因此没有生成原片逐字稿、镜头时码或仿拍分析。详见[下载与媒体证据评估](evaluations/weixin-video-skill-research-20260926.md)。需要继续分析时，必须提供本地视频文件或用户明确授权且可校验的实际媒体。

## Kimi 路由

五项各 0–2 分：关键落点、抽象表达、信息层级、品牌审美和素材缺口。总分小于 6 时由 Codex 独立完成；达到 6 时生成一次视觉导演建议任务。未脱敏敏感项目即使达到阈值也会阻塞。

普通项目最多一次，`flagship` 最多在同一会话内续接一次。调用额度在新任务包生成时占用；相同输入的重复准备保持幂等，不能通过失败导入或重新评分重置额度。timeout、429 或不可用结果只允许复用同一任务包重试一次；再次失败进入 `fallback_codex_pending`，第三次外部调用和重新准备都会被拒绝。该状态不会自动通过视觉门，必须用 `complete-kimi-fallback` 登记覆盖全部选中镜头的 Codex 方案后才进入 `visual_direction_ready`。Kimi 报告不是验收；Codex 必须复查工作树、重新渲染、抽帧和运行 QA。

失败登记必须附真实调用证据：`--started-at`、`--ended-at`、`--launcher-exit-status`、项目根目录内非空的 `kimi-raw-report-initial*.txt` 或 `kimi-raw-report-retry*.txt`，以及已返回时的 `--session`。引擎会记录耗时、原始报告哈希、任务包哈希和不可用输出哈希；重试时若已有 session，必须与首次失败一致。

## 当前基准

- 口播：`E:\视频文档\2026-08-09_视频工作流2.0-保险夫妻口播基准`
- 软件演示：王杰工作台 30–45 秒 16:9 功能演示（固定触发一次 Kimi 视觉评审）

任何上传、发布、定稿或 Skill 提升都需要独立的人工作业门，核心引擎不会自动执行。
