# 本人声音：明确参考录音，逐句本地生成与检查

在新视频需要本人旁白、补录或用户明确选择本人音色时读取。口播原片默认保留原声，不为换成TTS而克隆。当前已选 `local-first-personal-sample-required`，远程声音和自动付费关闭；Huihui仅明确的离线试读，不冒充本人。

## 分开核对三个状态

1. **运行环境：** 当前 `config.voice.local` 的 engine、modelId、pythonPath、launcherPath、modelPath、runtimeReportPath及实际离线验证回执。配置填好或模型下载完不代表已运行。
2. **本人样本与合成：** 用户明确选定的本人录音、用途和本地推理范围，与所用模型/参考文字关联；输出实际新WAV和合成回执，检查可解码、时长与实际文字。
3. **正式音色接受：** 用户试听并认可相似度、自然度与发音。技术运行、ASR文本或音频指标通过不能将 `personalVoiceValidated`、`personalListeningAccepted` 改成已确认。

没有明确样本时不把历史参考视频的人声、系统音色或开源demo人物当作本人。缺样本只阻断本人旁白，仍继续独立镜头/工程制作；正式成片是否暂用无口播由当前授权与交付要求决定。

## 本轮引擎与兼容边界

本轮按用户给出的[配音工作流文章](https://mp.weixin.qq.com/s/5qqqp9r9EbpJiHmpJoGg7g)补足短参考录音、准确原话、持久档案、逐句合成、ASR 回读和坏句单独重做。文章的 MLX 命令与 `.dtprofile` 面向 Apple Silicon，不能直接用于这台 Windows/AMD 电脑，也不能移用作者的合成速度和内存数据。

新引擎为 `dots-tts-audio-cpp`，模型为 `audio-cpp/audio.cpp-gguf:DotTTS-SOAR-GGUF/dots-tts-soar-q8_0.gguf`。使用作者 [audio.cpp v0.9.1](https://github.com/0xShug0/audio.cpp/releases/tag/v0.9.1)，模型固定 revision `e479ac197bae727f69574261a8025696bc51de48`，Q8 文件 SHA-256 `0633a6b4b705accee3858ffb129f403dc5aa64e634a80f713f4bde6f002fc2f0`；源码、二进制/DLL、权重和运行回执各自核验。CPU 与 RX 9070 XT 的 Vulkan 路线已分别实跑短中文及完整参考录音续写，主配置选择明确的 `vulkan` / `deviceIndex: 0`；CPU 保留为同引擎的明确配置选项。读取当前配置、doctor 的 `verifiedBackends` 和实测回执，不用 `best` 或自动回退，不能从文档或目录存在推断本机验证仍有效，也不移用短句速度到整片。

旧 `moss-tts-nano-onnx` / `OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX` 保留为明确选择的兼容路线，其样本规则及回执继续适用；新引擎失败不自动换 MOSS、Huihui、远程 API 或其他声音。模型专有缓存与旧回执不互通，不能用 MOSS 的 offline/verified 报告证明 DotTTS 已运行。

## 从明确本人录音建档

使用原创工作区 `scripts/voice-workflow.mjs enroll`。先让用户明确选择本人原始 WAV、MP3 或 MP4，再从中选干净、单人、无背景音乐的片段；建议 8–10 秒，接口接受 3–15 秒。参考文本使用该实际截取片段的准确原话，由人校对；不能将整段 60 秒的转写配给 8 秒样本，也不把 ASR 自动稿当作已校对文本。

```powershell
$workflow = Join-Path $workspaceRoot 'scripts\voice-workflow.mjs'
node $workflow enroll --config $workspaceConfig --source-file $explicitOwnRecording `
  --start $startSeconds --duration $durationSeconds --reference-text-file $exactReferenceUtf8Text `
  --scope $actualProjectPurpose --own-voice-confirmed true --output-dir $newProfileDirectory
```

`--config` 可省略以使用工作区配置，目标必须为新目录。实际输出为 48kHz 单声道 PCM `reference.wav`、`reference.txt`、`voice-profile.json`、`enrollment.manifest.json`。manifest 保存源文件哈希、所选起点/时长及输出关联，原片不改写。

这里的档案是明确参考录音、对应文本、来源、用途与引擎绑定的 JSON，不是 MLX `.dtprofile`、已缓存的模型 embedding 或可脱离参考音频使用的 voice ID。登记不代表已克隆、已试听或模型已支持该参考。本人样本尚未提交时，不能生成空壳档案后声称本人声音已建立。

## 逐句合成、识别回读与坏句重做

用同一个已登记 profile 对锁定全文生成新批次：

```powershell
node $workflow batch --config $workspaceConfig --profile-input $enrolledProfile `
  --text-file $lockedUtf8Text --output-dir $newBatchDirectory `
  --seed 42 --max-attempts 2 --pause-ms 120
```

`--seed` 可调；`--max-attempts` 只能为 1 或 2，计入首次生成，默认最多两次总尝试；段间停顿可按内容调整。每句调用本人声音准备与合成入口，DotTTS 使用 10 次推理步。保留各句、各次 take 的准备计划、实际音频、seed、合成回执与本地 Whisper 回读结果。文字回读只在比较时去标点、空白并统一大小写，对照锁定原稿；不改稿、不自动润色，也不把数字改写、同音词或漏字当作等价通过。

仅错误句允许第二次用不同 seed 重生成，保存首次失败证据，不整片重跑。ASR 差异或 ASR 不可用只能标为候选，不能称全文检查通过。Whisper 可能输出繁体而原稿为简体，目前严格比较会标出差异并触发一次重试；这需要人工复核，不能直接认定为实际误读，也不静默改稿或放宽同音词。整批输出 `candidate.wav`、`cue.json`、`batch.receipt.json`、`qa.json`；cue 根据实际 WAV 时长建立，不伪造词级强制对齐。当前没有跨批 resume 或自动替换旧批次的接口，不承诺任意断点续跑。

本地生成没有第三方 API 账单，仍耗本机计算时间。每句音准、声纹相似度、情绪、断句、数字及保险术语读法都需要本人试听；ASR 通过只支持文字检查，不自动改变 `personalVoiceValidated` 或 `personalListeningAccepted`。批次输出继续交最终音轨 owner 混音，字幕 owner 使用真实 cue 校对。

## 底层准备与单次执行接口

原创工作区 `scripts/personal-voice.mjs` 的 doctor/prepare 不读凭证、不联网、不合成，也不自动下载模型或换后端：

```powershell
$voice = Join-Path $workspaceRoot 'scripts\personal-voice.mjs'
node $voice doctor --config $workspaceConfig
node $voice prepare --config $workspaceConfig --profile-input $explicitLocalProfile `
  --text-file $lockedUtf8Text --output-dir $newPreparationDirectory
```

profile 须与实际 doctor 当前读回的模型一致。优先使用 enroll 的实际输出；以下仅说明 DotTTS 的准备字段，不能代替真实录音、完整登记产物或用户用途：

```json
{
  "provider": "local",
  "engine": "dots-tts-audio-cpp",
  "model": "audio-cpp/audio.cpp-gguf:DotTTS-SOAR-GGUF/dots-tts-soar-q8_0.gguf",
  "mode": "clone-from-sample",
  "samplePath": "实际本人的本地音频文件路径",
  "sampleTranscript": "与实际截取的参考录音逐字一致并已校对的文字",
  "consent": {
    "ownVoiceConfirmed": true,
    "scope": "实际项目与用途",
    "localInferenceAllowed": true
  }
}
```

准备器检查录音格式/实际音轨与时长、本地文件、runner散列、model匹配和offline报告，保存 `profile.redacted.json`、`request.dryrun.json`、`estimate.json`、`pending.md`。父目录须存在，目标目录须为新目录。退出码0表示doctor完成或准备完整，2表示存在待补项，1表示参数/文件错误；准备完整仍不是合成或试听通过。

只有 doctor 和准备计划核实当前 runtime 后，使用原创分发入口执行本地推理；它重新核对原 profile、锁定稿件、明确样本和离线验证，固定调用配置中的运行器与模型：

```powershell
node $voice synthesize --config $workspaceConfig --prepared-dir $preparedDirectory `
  --profile-input $explicitLocalProfile --text-file $lockedUtf8Text
```

准备与执行受当前引擎白名单及实际源码/模型锁验证约束，输出该准备目录中新的 `speech.wav`、`synthesis.receipt.json`、`dispatch.receipt.json`；旧输出存在则拒绝。低层 runner 的接口从当前 `--help`、实现和离线回执读取，不自行绕过准备合同。DotTTS 需要明确的参考音频与准确参考文本，其原生 cached_voice_id 不受支持；缺文本不得静默退化成只用声纹的模式。MOSS 使用其已验证接口和独立回执，不能共用新引擎的执行参数。模型、样本、稿子、二进制/DLL 或 runner 变更时重新核对，不静默换声。

本地本人音色未建立或未试听时，状态仍保持待样本/待接受。合成WAV之后依据实际音轨重新安排字幕与镜头，按 [voice-and-timing.md](voice-and-timing.md) 检查音量、尾音、误读与 cue；字幕和最终混音各有唯一 owner。每个正式输出保留样本/锁定文字/runner/模型标识与音频散列、真实推理回执和实际试听记录，来源和状态不写进视频画面。

本轮不接远程 Fish/MiniMax 声音作为替代，不因已有API key上传本人录音。用户之后明确选择远程路线时另核实时价、本人录音/文字上传范围、音色创建与有效voice ID；既有视频生成预算不自动转用到音色克隆或TTS。
