# 可选 Talkcraft：口播辅助与文件交换

仅在口播预剪候选、字词时间、局部动效配方或 Remotion 后期需要时读取。它补充原片 → 转写校对 → 粗剪 → 精剪 → 补图的主线，不替换粗剪/精剪、核心审批或本人原声。

## 身份、状态与许可

实际项目是 [Vincentwei1021/video-talkcraft](https://github.com/Vincentwei1021/video-talkcraft)，用户最初写的 `Vincentweil021` 返回404。审查固定 SHA `4cd673df4b7a6a35784a0881df223721789c5e23`；仓库根 `SKILL.md` 是上游入口，完整依赖声明/lock和许可已作为独立包受控 staged。

状态从工作区 `config.upstreamAdapters.talkcraft` 和中央回执核对：上游 optional、runtime disabled、未 promote/enable；原创 `scripts/talkcraft-bridge.mjs` 的本机文件交换已实现并测试，两者不能混称“上游已运行”。本 jia-video 只保留该接口说明，不复制928文件上游包。

[固定提交 LICENSE](https://github.com/Vincentwei1021/video-talkcraft/blob/4cd673df4b7a6a35784a0881df223721789c5e23/LICENSE) 为 PolyForm Noncommercial 1.0.0，并注明工具商业使用需作者事先授权。产出视频归创作者不等于业务生产或融合商业产品已获工具授权。复制任何代码/素材须保留 LICENSE、Required Notice 与适用第三方声明；商用授权从 `commercialAuthorizationVerified` 及真实记录核对，未取得时不要投入商业执行或分发。原创桥不复制上游执行代码。

## 原创离线桥的已实现接口

```powershell
$bridge = Join-Path $workspaceRoot 'scripts\talkcraft-bridge.mjs'
node $bridge export-words --transcript $coreTranscript --source $originalVideo --output $newWordsJson
node $bridge import-edl --edl $cutsJson --source $originalVideo `
  --edl-source $sameRecordingWav --edl-source-base $recordingProjectRoot `
  --rendered-video $trimmedSilentPicture --output $newCandidateJson
```

`export-words` 导出扁平 `[{text,start,end}]`，绑定真实源文件与核心 `sourceAssetHash`；使用 ASR 原始 words 文本，不拿已校对 segment.text 替换词表。缺失/无效时刻会阻断，不插值伪造强制对齐。`*.binding.json` 另存原片、transcript、词表的真实文件 SHA-256、engine、审核状态与能力边界。

`import-edl` 核 cuts 排序/不重叠、keep 是完整保留补集、目标映射连续以及实际媒体时长/帧率。EDL 的 source若是提取WAV，显式传 `--edl-source`；source为相对路径时用 `--edl-source-base` 说明其工程根。原视频、源WAV、EDL、候选均记录真实文件散列。同长只证明时长相符，不能证明不同文件同录/零偏移。

`--rendered-video` 可选检查已裁切画面；缺少音轨会提醒重新混入清理后的本人原声。候选 `pending-review`、`approvedEdl:false`、`executable:false`，不能直接变成核心整句 drop 或已批准剪辑单。所有新输出拒绝覆盖，无网络、TTS 或核心状态写入。

## 上游可参考能力与不能照搬的部分

- `voice_trim.py` 可按稿子与词表识别稿外口水词、紧邻重说与长静音，不删 ASR replace 误识别；仅预剪，不能代替完整语义取舍和精剪。已有 whisper.cpp 词表可以转换，无需先增加 FireRed 模型。
- 上游 EDL 有 cuts 与 keep 的源→目标映射；最安静窗口与核心中心压缩不同，字内删除也不能映射为整句 drop。正式脚本会重算方案，没有读入已批准 EDL 原样执行的参数；dry-run不构成机器审批闸。
- `--video` 裁切会去掉原音轨，要求同录与一致 CFR；源声和画面需正确回混。细剪仍用 [fine-cut.md](fine-cut.md) 的受控本地接口或实际工程。
- 上游 timestamp工具采用 ASR、字符/拼音匹配与插值，不是修改稿专用强制对齐；时间与词义仍需人工核查。小段偏差/速度等 README 数字是上游测量，不是本机验收。
- 上游工作台/配方可在许可、Windows适配与对应运行验证完成后按需要选少量组件；主项目只保留一条时间线、一位字幕owner和一位音轨owner。

不得运行上游每片自动 `--upgrade`。它会装/升依赖、下载浏览器、使用 Bash/链接并可能移除旧 node_modules；上游 Remotion4.0.519/React19.2.8 与本地 LiveCanvas4.0.530/React19.1.0 不同，不共用覆写。Windows工作台导出还依赖 rsync与Unix CLI入口，浏览页打开不证明导出可用。

上游 Fish TTS 只调用已有 reference_id，没有完整本人音色创建流程，还存在自动重试与独立费用。当前本人声音选择本地路线，见 [personal-voice.md](personal-voice.md)，不新增 Fish 依赖或把它作为默认音色。插件/Skill说明存在、已staged或静态审查通过均不是执行授权。
