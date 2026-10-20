# 本地口播审片：内容取舍 → 真实粗剪 → 精剪

运行实现位于 `E:\开发项目\视频剪辑skill\scripts\rough-review.mjs` 与 `ui\rough-review`，不把模型、浏览器或整份上游仓库塞进 Skill。读取工作区配置并运行 doctor；使用既有 Whisper、FFmpeg 和系统浏览器。本通路保留真人原声，不调用云端 ASR、TTS 或 MiniMax。

## 创建并打开

```powershell
$entry = 'E:\开发项目\视频剪辑skill\scripts\video.ps1'
$review = 'E:\视频文档\YYYY-MM-DD_项目名\口播审片-v1'
& $entry -Command rough-prepare -ToolArgs @('--input',$source,'--output-dir',$review)
# 可加 --transcript：绑定原片的核心 transcript.json，或显式提供的 Whisper 完整 JSON。
# 可加 --script：原始台词/创作脚本，仅用于辅助校字和覆盖检查。
& $entry -Command rough-review -ToolArgs @('--project-dir',$review)
```

新目录必须不存在；不重建旧工程。`rough-review` 启动隐藏的本地后台进程并请求打开浏览器，网址/PID/日志登记在工程 `sessions`。仅监听127.0.0.1；关闭标签页不停止服务。重开后读取已有编辑记录，不重新转写。若服务异常，先检查 session 日志及锁中的 PID，不能自动删除一个仍有进程使用的锁。

未提供转写时实际调用既有本地 Whisper，ASCII 原生缓存；导入现有 JSON 时记录来源和散列，不宣称重新识别。核心 JSON 检查原片 hash；缺绑定的原始 Whisper JSON 保持显式导入、未听审状态。原始转写与参考脚本不修改。零时长/重叠词合并为有实际 ASR 范围的词组，标明需复核；无可靠词时码只能整句操作，禁止捏造逐字对齐。

## Agent 提供建议，用户可恢复

先按实际录音核对错词、姓名、数字、否定和保险条件。脚本与录音不一致时标记缺失/歧义；禁止把未说出的脚本直接写进字幕。校字与删除分别处理，不通过空字幕“删除”录音。没有听审证据时只给待回听建议，不能把转写或技术指标当成已经听过。

Agent 依据转写和实际可用证据识别重录、口误、拍摄交流、长等待。保留主语、条件、因果、反问与有效停顿；只自动生成长句间间隔提示，默认全部保留。语义判断使用当前 Agent，面板不附带第二个 LLM 或自动收费服务。建议格式：

```json
{
  "sourceSha256": "project.json 中 source.sha256",
  "transcriptSha256": "project.json 中 transcript.sha256",
  "suggestions": [{
    "id": "唯一ID", "start": 39, "end": 42.8,
    "reason": "重录前版本，后一次修正了宾语；须回听边界",
    "category": "重录候选", "confidence": "文本证据，待回听"
  }]
}
```

```powershell
& $entry -Command rough-suggest -ToolArgs @('--project-dir',$review,'--input',$suggestions)
```

上例时间仅示意格式，按本片真实时码生成。导入建议不应用删除，也不生成用户确认。多个建议的重叠删除取并集；恢复其中一个仍可能被另一条删除覆盖，需要查看删除列表。

面板支持逐词选择、Shift 连选、双击定位、Delete 删除、Ctrl+Z 撤销、Ctrl+S 保存、原片/粗剪切换、波形缩放、Shift 拖选、校字、恢复，以及载入删除边界后微调。建议的“听上下文”回听原片，“听切点”检查删除后的连接；保留呼吸多久按发言和表情判断，不统一压成固定间隔。即时预览通过原片 seek 跳过删除段，不能保证逐帧/逐采样精度；实际导出 MP4 才是切点检查依据。

`edits.json` 是本地渲染唯一决定源，采用修订号、防并发写入和来源绑定；它不是新增的核心审批合同。校字不改时码。已校对整句在局部裁剪或改词后，字幕区要求核对保留片段，不把整句文字粘到碎片上；改边界使片段 key 变化，旧字幕确认失效。保存仅保存编辑，不代表用户认可效果。

## 导出与承接

点击“导出粗剪”会先保存当前修改；存在待核查片段字幕时停止。也可显式指定已保存修订：

```powershell
& $entry -Command rough-export -ToolArgs @('--project-dir',$review,'--revision','实际revision')
```

每次生成新的 `exports\r...`，保留旧文件：

- `rough.mp4`：原画幅、源标称帧率的 CFR，H.264/48kHz AAC；原声每个保留区间两端仅做2ms防咔嗒淡化，未做统一加速、系统配音或音量规范化。
- `rough.srt`：单一外置字幕 owner，与视频共享同一帧时钟；不自动重复烧字。
- `mapping.json`：原片→粗剪的帧区间、秒区间及字幕来源；删除边界向外取整，原始亚帧差记录在映射。
- `edits.snapshot.json`、`qa.json`、`receipt.json`：导出冻结记录、真实探测/完整解码/帧数/时长检查、来源散列；主观切点听审与用户确认仍单列 pending。
- `fine-cut.handoff.json`：粗剪 MP4、SRT、原片→粗剪映射的路径和散列，直接用于 [fine-cut.md](fine-cut.md) 的 `plan/render`。精剪另产生粗剪→精剪映射，两段映射都保留；再按 [edit-source.md](edit-source.md) 补图/MG/B-roll。

导出结果可直接在面板播放。输出不写回历史工程，不自动登记核心版本或批准语义修改。已有正式核心项目继续由核心 CLI 校对、计划、路由、登记版本与用户确认；只有真实状态允许时登记实际新视频，不修改合同 JSON 冒充合法状态。整句核心剪辑与本面板词级决定不能被同时当作两份渲染来源。

当前边界：本机单用户、原片顺序不变、两小时内1–60fps素材、最多500条删除，非零音视频起点需先核查。推荐 H.264/AAC 的 MP4；其他封装/编码取决于本机浏览器解码能力，无法播放时先创建兼容副本并保留原片依据。浏览器预览精度、ASR 时码、内容真实性和听审不以技术 PASS 替代。多机协作、自动改序、云端识别和原生剪辑软件导出没有接入。
