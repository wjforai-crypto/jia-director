---
name: jia-director
description: 王杰的导演系统。承接本人给定选题，组织口播与无口播视频的研究脚本、风格分镜、剪辑或动画、合成与审片；分开AI执行和人工复核，保留可修改工程、素材来源与版本。用户提到导演系统、视频制作、参考片复刻或视频续改时使用。
metadata:
  version: "1.3.1"
  display_name: "导演系统"
  source_module: "jia-video@3.1.1"
---

# 导演系统 · Jia Director

## 当前生效：王杰已采用的花叔13项规则

开工先读[已采用的13项规则](references/huashu-rules.md)，按其适用范围执行：限制蓝紫与通用角色、主体突出、统一画风、人物生帧、模型分档、新方向三构图、具体事件首尾、重点字数、镜头时长、艺术母题、快速运动阈值及新风格登记。它取代旧说明中“不固定三方案”等冲突描述。新方向先交三种不同构图供王杰选择；其他已授权工作照常推进。规则已采用与自动脚本已安装/视频已通过分开记录。


这是完整视频工作流入口，英文调用名`jia-director`。继承jia-video 3.1.1的执行脚本、资产与完整参考内容，保留40个复核节点及原有执行能力；两条主线下按素材剪辑、原创动画、混合制作选择，原创动画模块为jia-motion。旧jia-video保留兼容，不再叠加调用旧入口形成第二套流程；物理工作区、素材库与程序名沿用既有路径。

## 先选路线与真实断点

| 输入或成片主线 | 路线 | 先读 |
|---|---|---|
| 真人讲述、访谈、人物表达为主，或准备录制本人讲解 | 路线一：口播 | [talking-head.md](references/talking-head.md) → [edit-source.md](references/edit-source.md) |
| 动画、产品片、录屏、实拍/资料混剪、MV与画面叙事，可含旁白/音乐/无声 | 路线二：无口播 | [no-talking-head.md](references/no-talking-head.md) → [create-video.md](references/create-video.md) |
| 现有工程、初稿、修改意见 | 延续原路线和版本，不重新起片 | 工程记录与对应路线 |
| 只要完整流程复核或修改流程 | 复核模式，不自动制作视频 | [完整流程与Skill落位](references/full-workflow.md)、[可点击流程图](assets/review/完整流程图与复核.html) |

无口播暂指“无真人出镜口播”，不等于无旁白。用户另有定义时以当前要求为准。有视频文件不自动等于口播剪辑；无真人A-roll的动画使用独立工程，不伪装原片推进核心状态。

## 无口播内部的制作方式

先由王杰选择素材剪辑、原创动画或混合制作；已有明确委托内AI自行执行。素材剪辑复用取材/选段/剪辑，原创动画由已启用的`jia-motion`承担动作脚本、代表段、逐镜实现与调试；混合按镜头分配。动画也可给口播提供解释插段，最终时间线、字幕和音轨仍统一。详见[制作方式与接口](references/production-modes.md)、[项目去留与Skill落位图](assets/review/制作方式与项目落位.html)。

## 人工负责什么，AI负责什么

选题由王杰自己做，AI不默认搜热点、评分或换题。AI承接选题后研究写稿、查事实、制作、渲染与自检；本人复核核心表达、必要的素材方案、新风格代表段和新音色，完整看听初稿，反馈后复核二稿并决定定稿和发布。详见[分工表](references/ai-human-review.md)。

已有确认和连续制作授权内继续，不逐工具增加审批。分别记录“AI执行/AI自检覆盖/人工待复核/人工已确认”；保存、下载、技术PASS不能代签人工认可。封装安装不代表用户已认可全部待决定项或任何作品风格。

## 开工与宿主检查

1. 读brief、锁定稿、design、分镜、事实/资产、工程状态、已有反馈和本轮授权。保留旧版本与用户改动。
2. 读[宿主适配](references/hosts.md)和[运行说明](references/runtime.md)，从本包实际位置调用`scripts/run-video.ps1 -Command doctor`。配置不匹配时说明缺口，不重装或升级全局环境。
3. 新工程使用`E:\视频文档\YYYY-MM-DD_项目名`；素材库、动效库、模型与外部runtime保持原位置，不塞进Skill。不同宿主确认自己真实可用的CLI、浏览器和图像工具。

## 两条路线的执行顺序

- **口播：** 原片登记与转写校对 → 有理由的语义粗剪并导出 → 帧级精剪、原声与切点并导出底片 → 再补证据图/MG/B-roll → 合成、自检、人工审片与修改。原片未提供时先交录制准备，不称已剪辑。粗剪/精剪及原片→粗剪→精剪映射分别保留。
- **无口播：** 参考拆解（如有）→ 事实与脚本 → 视觉规则与真实声音/阅读时钟 → 分镜 → 代表段和完整可播放预演 → 按任务选择素材/代码/图片/图表/必要生成 → 合成、自检、人工审片与修改。新增本人旁白先由本人选样本与准确原话，再逐句合成、回读和试听。

一个最终时间线、一个字幕负责人、一个最终音轨负责人。改稿、换声或改切点后更新受影响的时间映射、资产绑定和检查证据。

有源码参考和已选画面时，优先走[源码驱动制作](references/source-backed.md)：先确认是忠实复现、源码改编还是截图原创，保留有效原栈，固定源码与提示词，在独立副本修改，先验证高风险动作再全片输出。新入口`source-doctor/source-check/source-render`承接浏览器代码画面和原生命令渲染，不改变两条主线或强制替换已有合成器。输出带实际源文件哈希、时间映射、错误记录与最终MP4检查。

开工先问会实质改变目标的缺项：参考中哪些必须保留、内容/声音是否锁定、必要授权或额外成本是否确定。已有明确参考、委托和连续制作授权时自行完成可逆实现与纠错；遇到关键效果无法达到、必须改变风格/时长/声音或产生额外费用时，先给出实际证据、可选方案和具体影响再问王杰。保持短提示词的创作空间，技术检查由执行流程承担。

## 执行与独立审核交接

多 Agent 制作、参考复刻或新动作能力按 [执行与审核](references/execution-review.md) 明确本轮源码编辑者、执行者和审核者。先固定角色/场景/画面规则、可见事件、绘制/时间线/导出分工及分层更新节奏；新能力先验最能暴露风险的短段。执行自检、独立看片、返修复验和本人确认分别留证，不用文件 fps 或 Skill 读取记录代替效果审核。已有授权内继续纠错，不新增逐镜审批。

## 按阶段加载能力

| 任务 | 本包内容与Skill落位 |
|---|---|
| 参考片 | 宿主已启用时用`video-recreation`；否则用本包[参考拆解方法](references/reference-recreation/workflow.md)，不执行隔离区上游 |
| 美术与动作 | [风格路由](references/style-routing.md)、[镜头导演](references/motion-direction.md)、[配方](references/shot-recipes.md)、[动作审查](references/motion-quality.md)；按需使用已启用的HeiGe-Design、video-shotcraft、motion-reference-studio、gsap、hand-drawn |
| 素材与本地找片段 | [素材库](references/material-library.md)、[VideoSeek](references/material-semantic.md)，实际查看候选、核许可、SHA及选段；不默认用Top1 |
| 原创动画与上游整合 | 宿主已启用的`jia-motion`；对象行为、连续形变、空间事件与逐镜调试。[接口](references/production-modes.md)，不整包并装上游总控 |
| 动效复用与制作 | [外部动效库](references/motion-archive.md)、[案例检索](references/motion-library.md)、[镜头执行层](references/directed-runtime.md)、[局部组件](references/motion-components.md) |
| 数据 | [LiveCanvas折线](references/data-charts.md)，真实数据/缺失值/口径先核实；按需data-visualization |
| 声音 | [本人声音](references/personal-voice.md)、[声音与构图](references/voice-and-timing.md)，原声优先；不自动换系统声、MOSS或远程声音 |
| 本地审片与补图 | [粗剪](references/rough-review.md)、[精剪](references/fine-cut.md)、[面板与结果登记](references/review-stages.md)、[Talkcraft可选桥](references/talkcraft-adapter.md) |
| 合成、检查与交付 | [合成](references/composition.md)、[最终验收](references/acceptance.md)、[实际文件取样](references/media-inspection.md)、[能力边界](references/capabilities.md) |

外部Skill只按本宿主实际发现和启用状态调用，不要求一次加载全部。未启用但非必要时按本包方法继续；必要能力缺失时说明准确缺口。HeiGe-Video与riso-film/riso-still/riso-score目前是待接入候选，不能从“列入流程”推断安装或验通。专项库与程序不冒充Skill。

## 运行与交付边界

- 现有本机工具优先；ChatCut不进入这两条路线。图片使用当前宿主真实内置图像工具，缺工具时不冒称已生图或静默换模型；在Claude/WorkBuddy里不能假定Codex的image_gen存在。
- MiniMax等付费生成默认关闭，只用于有必要的镜头；当前服务接入、项目claim、载荷、预算与用户授权分别核对，不从历史回执推定可执行，不绕核心合同。
- ASR只辅助定位，token不是准确中文逐词或修改稿强制对齐。改字不等于删音频，面板保存不等于用户确认；当前面板功能以其真实边界为准。
- 一般解释/阅读镜头不强制五层、受力或运镜；艺术风格画面另按H11执行一个主动作加两个母题循环。先检查真实动作与跨镜，再按H12检查快速运动占比，未测不报通过。
- 视频画面不加“初稿/样片/未定稿/AI示意”等制作状态标签，版本与生成性质放交付文件；数据单位、合同条件、真实来源和必要合成数据说明正常保留。

交付实际MP4、可修改源码与运行说明、素材来源、技术QA、真实看/听覆盖、问题与修订。口播另有粗剪/精剪底片及映射；初稿待确认→反馈→修改与复检→第二稿待确认→本人明确确认定稿。最终文件检查后才能报告技术通过，未听审如实说明。正式核心confirm/archive未自动强制核对全部QA，本系统主动检查，不手改状态跳过。

归档按真实合同和文件清单完成并回读；技术通过作品只入待审，具体版本获本人认可后才进入已确认动效库。定稿、归档、上传、平台接受与发布分别记录，不互相推导授权。

完整原文、模块沿用关系与尚待复核项见[来源与封装范围](references/package-provenance.md)。
