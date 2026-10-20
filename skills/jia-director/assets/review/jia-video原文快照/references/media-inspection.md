# 最终文件检查与关键帧取样

用 `scripts/inspect-video.mjs` 检查已经导出的本地 MP4。它只生成检查证据，不能写入核心项目的验收、确认或发布状态。准备技术小样或正式审片时都可以使用；正式交付仍执行已有核心 `qa-media` 和项目验收流程。

## 调用

需要 Node、FFmpeg 和 FFprobe。可以使用工作区 `config/video-workflow.json` 中的 `tools.ffmpegCommand`、`tools.ffprobeCommand`，也可以省略 `--config` 使用 PATH 中的工具。命令通过参数数组执行，不经过 shell；输入只接受本地 `.mp4`。输出必须是不存在的新目录，已有目录、文件或联接入口都会拒绝覆盖。

```powershell
node '<SKILL目录>\scripts\inspect-video.mjs' `
  --input 'E:\视频文档\项目\renders\review-v02.mp4' `
  --output 'E:\视频文档\项目\qa\inspection-v02' `
  --config 'E:\开发项目\视频剪辑skill\config\video-workflow.json' `
  --times '0,1.2,5.5' `
  --boundaries '3,6' `
  --expect-width 1920 --expect-height 1080 --expect-fps 30 --expect-duration 9
```

先替换 `<SKILL目录>` 和项目路径。时间单位为秒，相对于主视频流起点；参数必须是有限数字。宽高要求正整数，帧率和时长要求正数。宽高按精确值检查，帧率容差为 `0.00001`，时长容差为一帧加 `0.001` 秒。越界的自选时间或边界会报错。

默认取第一帧和实际最后一帧。`--times` 增加自选时间，`--boundaries` 对每个边界取前一帧、边界、后一帧；接近首尾的取样会限制到有效视频范围，并记录限制前的请求。合并去重后最多 64 张。没有边界资料时不要编造，可以先按镜头时间表选关键时间。可变帧率文件以平均帧率计算边界前后偏移，需查看记录的实际 PTS，不可据此声称完成帧级剪辑验收。

## 输出与证据范围

- `inspection.json`：文件 SHA256、流参数、完整命令数组、期望值检查、取样时间与实际解码 PTS、响度测量以及检查范围。
- `probe.json`：完整 FFprobe 流与容器信息。
- `frames/*.png`：从本次最终 MP4 解码出的实际图片，包含图片 SHA256。
- `logs/*`：每次 FFprobe / FFmpeg 调用的 stdout 和 stderr，包括完整解码与响度分析记录。

取尾帧时先读取视频尾部的实际解码 PTS。容器总时长只用于定位尾部，不用来代替视频尾帧时刻，因此音频较长也不会把取样放到视频结束之后。尾帧缺少持续时间时，用平均帧周期估算并在报告标明。工具对视频和音频流整段解码到空输出，检查损坏、解码错误及期望参数；字幕和数据流不在解码覆盖范围。

存在音频时默认测量第一路音频的 EBU R128 综合响度和真峰值。`--skip-loudness` 可以显式跳过测量。测量不会改混音，也不自行批准平台响度目标；静音音轨的非有限峰值会如实记录。没有音轨时标记 `NOT_APPLICABLE_NO_AUDIO`，允许纯动效技术小样通过；成片是否缺少要求的配音由脚本、brief 和听音检查判断。

`TECHNICAL_CHECKS_PASSED` 仅表示本次技术检查通过。期待值不符、解码或取样失败会生成 `TECHNICAL_CHECKS_FAILED` 报告并返回非零退出码。参数或输出路径等前置校验失败也返回非零；修正后用新的 QA 目录重跑，不覆盖失败证据。

## 人工或多模态验收

工具报告固定记录 `framesViewed: false`、`subjectiveVisualReviewed: false`、`subjectiveAudioReviewed: false`。导出了截图不等于已经看过，响度数值也不等于已经听过。

检查者随后打开 `frames` 里的首尾、主要镜头和转场帧，核对文字可读性、内容完整、遮挡、黑屏、错误闪帧、字幕与人像位置；播放最终 MP4，核对配音完整、节奏、字幕、转场、音乐及音量。静态截图不能证明运动连续性，必须按视频回放范围记录自己的视觉和听音结论、未检查部分及待改问题。将这份检查证据纳入已有核心 QA；由核心正式入口维护项目状态，用户确认定稿仍需真实确认。
