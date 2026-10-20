# Claude与WorkBuddy适配

正式源：`E:\AI-workspace\All-skills\shared\jia-director`。客户端只读取中央管理器生成的发现入口，不独立维护复制源。

Claude入口是`C:\Users\MSN\.claude\skills\jia-director`；WorkBuddy桌面入口是`C:\Users\MSN\.workbuddy\skills\jia-director`。在新对话中调用`jia-director`或说“使用导演系统”。目录与文件检查、客户端发现和实际成片是不同验证状态。

这是同一台Windows机器的封装，不附带模型、Node/Python依赖、浏览器、录音或密钥。先用当前可用PowerShell7执行本包`scripts/run-video.ps1 -Command doctor`，读取真实`E:\开发项目\视频剪辑skill`配置。不要安装到WorkBuddy自带解释器、改全局PATH或重建另一套视频runtime。

Claude/WorkBuddy应分别确认自身实际图像、文件、浏览器和外部Skill能力。`image_gen`是Codex的工具名，不能当作其他宿主已有工具；没有可用生图时沿用现有图片素材，人物按H05仅出手或背影；无人物的代码画面可继续，缺少必要人物资产时交提示词并明确未成图，不用通用代码小人替代。视频制作CLI由本机共用，不需要远程模型调用。

需要其他Skill时先原生发现。未开放的可选Skill不读取隔离区或管理程序镜像替代。参考拆解可用本包自带的方法；风格、数据等按本包对应参考与已有工具继续，不能把独立工具接口说成已执行另一Skill。

受支持的客户端新对话/技能列表中需要可见才算原生发现验收；若仅完成目录挂载，如实报告，不重启或中断用户正在运行的任务。WorkBuddy“已安装/启用”开关不得通过改缓存伪造。
