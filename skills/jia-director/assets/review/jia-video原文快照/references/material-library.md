# 素材检索、获取与复用

用于两条通路中的取材。精剪前可列镜头需求，精剪内容成立后才按输出时间放入。已有主时间线、原声、字幕与状态门继续由原工程维护。

## 默认顺序与分工

1. 用户实拍、产品录屏、已获许可且采用过的本地文件。
2. 本地目录标签搜索；找片内视觉候选时使用 [本地语义检索](material-semantic.md)。
3. 不足时正常网页选片，或显式查询Commons/NASA无key公开API。Mixkit支持给定详情页的正常720P下载，未实现站内搜索API。Dareful和中文图库用正常下载→本地导入；不将一次HLS实验称为任意条目自动下载器。
4. 仍不足才考虑图片、代码动效或经授权的极少数生成镜头。

需求写可见主体、动作、环境、情绪、服务的台词及不能暗示的事实，如“母亲为孩子整理头发，支持日常照护”。不逐句铺B-roll；态度、判断、情绪和结论常需保留原人物。真实资料保留事件日期，NASA字幕/Commons片尾需实际选段。

## 统一入口

`$entry`是本次Skill的`scripts/run-video.ps1`。配置`materials.libraryRoot`默认`E:\视频素材库\Jia-video`，SQLite清单、SHA命名原文件、来源、回执和索引保留在该外部目录。

```powershell
& $entry -Command materials -ToolArgs @('doctor')
& $entry -Command materials -ToolArgs @('list')
& $entry -Command materials -ToolArgs @('search','--provider','local','--query','家庭')
& $entry -Command materials -ToolArgs @('search','--provider','commons','--query','3D printing','--limit','3')
& $entry -Command materials -ToolArgs @('search','--provider','nasa','--query','spacewalk','--limit','3')
```

将JSON候选保存为项目文件，实际看来源和许可，选定其中一个`id`后调用：

```powershell
& $entry -Command materials -ToolArgs @('download','--input',$candidateJson,'--id',$selectedCandidateId,
  '--license-review',$actualUsageAndLicenseReview)
& $entry -Command materials -ToolArgs @('download','--page',$selectedMixkitDetailPage,
  '--license-review',$actualUsageAndLicenseReview)
```

搜索只取元数据，不整库下载；授权取材范围内下载具体选定免费条目。Mixkit仅接所选版本明确Free的条目，Restricted停止。HTTP403/429或验证时停该途径；不注册、读Cookie、猜私有接口或产生费用。Coverr/Pexels/Pixabay/Vecteezy不是默认前提。

下载上限100MiB、90秒总读取期限、25秒socket超时；证书正常校验，限定来源host，不自动重试。完整长度、媒体验证和SHA通过才登记，失败留回执且返回非零。Commons逐文件保存许可、作者、署名和衍生条件，不统一写CC0；NASA按媒体指南及具体版权标注，不推定机构背书。`license-review`是调用者的用途与核对记录，不是程序的法律判定；跨项目复用再核对许可。

## 本地导入和缓存

来源JSON填写`provider`、`title`、`sourcePage`和具体`license`；作者、许可URL、授权书、用途一起保存。自有视频注明实际来源路径与权利，来源不明不伪填可商用。

```powershell
& $entry -Command materials -ToolArgs @('import','--input',$licensedVideo,'--origin',$originJson,
  '--tags','家庭','照护')
& $entry -Command materials -ToolArgs @('verify','--id',$libraryAssetId)
```

支持MP4/WebM/MOV/MKV；图片用既有补图导入。本库按内容SHA去重并保留多个来源/标签，已有来源再次采用也验SHA与全流解码。坏缓存报`CACHE_INVALID`并保留用于有范围的修复，不自动覆盖用户数据。24小时搜索响应缓存与长期已选素材不同；当前入口不缓存在线搜索响应，不借MPT实测而假称实现。

## 选段并接回补图

实际查看起态、动作中段、落态及上下文。选择原素材内起止点，记录镜头目的与复核意见：

```powershell
& $entry -Command materials -ToolArgs @('cut','--id',$libraryAssetId,'--start','4','--end','11',
  '--fps','30','--width','1280','--review-note',$actualShotReview,'--output',$newClipMp4)
& $entry -Command visual-asset-import -ToolArgs @('--project-dir',$reviewProject,'--input',$newClipMp4)
```

按源区间重编码，默认静音、30fps、1280宽，保持源画幅。fps继承精剪，不照抄示例；横竖版需重排而不是拉伸。核对实际时长、SHA与解码，输出MP4和`.asset.json`，含原资产、源入出点、作者/许可、改动、复核、用户接受状态。拒绝覆盖或写回被索引的原文件目录。

导入调用已有素材登记。刷新第03步素材列表，再选条目和安排精剪输出区间；不会自动选定或插入时间线。当前面板从素材0秒播放，所以先导出已选源区间的独立MP4；sidecar和来源留在项目。已有任务结果也可走`visual-import-results`，不另起剪辑器。

## 上游取舍

laohan-sucai参考需求/候选/下载/复核/清单接口；实测缺源失败仍退出0，因此接入端自己验状态与文件。MoneyPrinterTurbo参考缓存分层；实测旧坏缓存直接命中，因此复验，不接其LLM/TTS/字幕/整套制作。VideoSeek只提供本地候选与时段。都不整包塞进Skill。

四来源下载、裁片余量、误匹配、坏缓存负例快照在工作区`research/2026-10-12/material-library-broll/素材下载与本地检索实测.md`，不当作常驻服务或所有条目授权保证。
