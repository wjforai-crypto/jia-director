# 口播精剪底片：本地帧级接口

在语义粗剪已确定后读取。入口是工作区原创 `scripts/fine-cut.mjs`，使用已有 Node、FFmpeg/FFprobe，不下载模型、调用服务或执行上游 Skill。先读取本次工作区配置，以 `workspaceRoot` 定位脚本；迁移时显式选择工作区，不能凭此文档假定路径可用。

## 输入合同与顺序

输入必须是有原声音轨、恒定帧率 CFR 的真实粗剪视频。核心 `plan-cut/review-cut/render-rough` 仍负责语义保留/删除；本工具只细调技术切点、呼吸与连接处，不重排句子或删除新的整句观点。

`cuts.json` 使用粗剪视频帧号，右边界不包含该帧：

```json
{
  "scope": "technical-edge-refinement",
  "segments": [
    {"id": "clip-1", "startFrame": 0, "endFrameExclusive": 30, "reason": "实际核查后的技术切点说明"}
  ]
}
```

这些是保留区间，不是删除区间。id唯一、帧界为整数、按原有顺序且不重叠；数量/范围按真实视频，示例的一段不代表整片计划。先实际观看/回听，核对尾音和表情，再生成计划与明确的文件摘要。

```powershell
$fine = Join-Path $workspaceRoot 'scripts\fine-cut.mjs'
node $fine plan --input $roughMp4 --cuts $cutsJson --source-srt $reviewedRoughSrt --output $newPlanJson
$reviewedDigest = (Get-FileHash -LiteralPath $newPlanJson -Algorithm SHA256).Hash.ToLowerInvariant()
# digest只绑定文件；上述实际检查与项目授权仍须另有真实记录。
node $fine render --plan $newPlanJson --reviewed-plan-sha256 $reviewedDigest `
  --output $newFineMp4 --srt $newFineSrt --mapping $newMappingJson `
  --qa $newQaJson --receipt $newReceiptJson
```

`--source-srt` 可选；有时使用已校对粗剪输出时间的 SRT，不传原片时间码。渲染的五个输出必须是不同且尚不存在的文件。计划绑定粗剪、cuts 和字幕文件的真实 SHA-256；输入或计划变化时重新生成并核查，不沿用旧摘要。

## 输出与当前边界

- MP4 保留裁切后的原声；只做 AAC 编码和48kHz重采样，不生成 TTS、不做 loudnorm、不替换人物声音。
- SRT 保留输入文字，重映射时间，并列出裁短、跨段或未映射问题；整条 cue 被删会阻断并要求回到语义粗剪。切点舒适与剩余文字是否仍完整，需要实际听审，不能由机器摘要判定。
- mapping 是粗剪帧/秒 → 精剪帧/秒。原片 → 粗剪映射另从核心计划和粗剪产物保留，两级组合后才定位原片来源。MG/B-roll、补图和音效使用精剪输出时间。
- QA 和 receipt 保存实际输出散列、帧数/音画参数与执行合同，`subjectiveListeningCompleted` 和 `userApprovalRecorded` 不自动置 true。
- 它不登记核心版本、批准计划或修改核心状态。底片通过后再补图，完整版本通过正式 `record-version/qa-media` 交接；仅要求精剪时直接交付底片及映射。

输入 VFR、音轨过短、轨道起点不符、无原声或超出范围会失败；不自动将原片强转或删除字幕来绕过。技术检查通过后还要真实播放与回听。工具可用性与测试范围从当前代码及检查回执核对，不把结构小样当作真实口播的剪辑质量验收。
