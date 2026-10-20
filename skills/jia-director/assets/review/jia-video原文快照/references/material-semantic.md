# 已保存视频的本地中文检索

只承担“描述→本地候选和源时间段”，不接管ASR、音轨、字幕和成片时间线。使用固定VideoSeek `a9597a81c160fc7694c2c1814e09a4802f13ab68`与官方中文CLIP，CPU、1fps采样。模型、venv、上游源码在工作区`runtime/videoseek`，不依赖checks旧测试目录，不自动下载、升级或开启云端理解。

先按[素材库](material-library.md)导入有来源的文件，再显式索引：

```powershell
& $entry -Command materials -ToolArgs @('index')
& $entry -Command materials -ToolArgs @('search','--provider','semantic',
  '--query','妈妈帮女儿整理头发','--limit','5')
```

候选含`assetId`、原文件、`start_sec/end_sec`、raw时刻、邻近窗口、score、来源及`reviewRequired=true`。实际查看后调用materials cut选具体区间，不自动采用Top1或插入时间线。

适配器使用库内`index-data`与独立进程配置，不改用户默认VideoSeek配置、不扫整盘或私有库，无常驻HTTP和远程LLM/VLM/ASR。缺模型/依赖明确报错，不降级云端。上轮临时上游HTTP API已实测；日常入口调用同一离线检索核心。

四段小库4条具体描述Top1正确，约0.125–0.172秒；不保证大库相同速度或正确率。采样命中是候选时刻，不证明动作完整发生。无航天员时“航天员在月球上行走”仍返回打印片尾，score0.346，默认阈值也放行；分数不是正确率，允许没有采用结果，不能只提高阈值宣称解决。

默认copy裁片对5–8秒请求加余量，实测输出10.093秒。Jia-video不用该默认结果，按显式入出点重编码、静音、核对实际时长，继承精剪帧率。

VideoSeek代码AGPL-3.0，版权文件留在外部runtime；对外产品融合需另评估许可，不自动并入闭源产品。素材许可与软件许可分别记录。
