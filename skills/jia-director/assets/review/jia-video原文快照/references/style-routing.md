# 风格控制与生产后端落位

四层分别保存：视觉规范（颜色、字体、构图、材质）→动作规则（起中末、节奏、相机、跨镜）→具体镜头内容→渲染后端。风格Skill不等于动画引擎；保持已认可规则，不把旧片画面机械换文案。

## 当前可用的风格与动作能力

- `HeiGe-Design`：本机已启用，离线list已核对50套。可作为品牌/产品/信息视觉的DESIGN.md来源；网页交互与无限循环规则需要转换成确定性视频时间线，不能直接当成片。只读预设不修改Skill根目录。
- `video-recreation`：参考片反推构图、材质、动作、节奏与跨镜，交出原创迁移方案。
- `hand-drawn`：手绘静帧、角色与场景基准；通过当前内置生图工具产出图片，不宣称负责角色动画。需要动画再交相应后端。
- `motion-reference-studio`：检索动作/参数/源码参考并适配到HyperFrames或Remotion，不自建第二条时间线。
- `video-shotcraft`：产品与界面镜头配方；`gsap`负责确定性动作实现；`hyperframes`负责HTML视频工程。按需要读取，不全部加载。
- `jia-video`的motion-direction、motion-quality负责导演判断与实际帧审查，不以模板数量替代镜头表达。

## 样片与黑哥工具的具体落位

| 风格/任务 | Skill、工程或后端 | 应放的位置 |
|---|---|---|
| 完整代码动画、连续主体与讲解 | `heige-video` / HeiGe-Video，当前上游v4.0.0-alpha.3 | 无口播动画生产后端候选；口播可制作已锁定精剪时间段的解释插段。与HyperFrames按项目选择，不让两者争夺最终字幕/音轨/时钟 |
| 版画/套色/纸张质感与连续场景 | 上游`riso-film` | 风格专用电影制作Skill候选，属于riso-windowseat整个项目；依赖rules/docs/tools，不能只复制单个SKILL.md |
| 版画关键构图与海报 | 上游`riso-still` | 静态风格基准/关键帧候选；不负责整片时间线 |
| 版画声音与音乐 | 上游`riso-score` | 按需的Web Audio配乐/声音候选；最终混音由项目owner统一，没有音乐需求就不启用 |
| 草图抖线 | Rough.js | 绘制库，不是独立Skill；在代码镜头中实现指定线条与填充规则 |
| 水彩/水墨/笔刷 | p5.js+p5.brush；ClaudeAnimationBase | 笔刷后端与角色动作起步工程。后者含ANIMATION_GUIDE，未见独立SKILL.md，不虚构Skill名 |
| 数学板书/公式 | Manim；中央有Hermes专用`manim-video` | 公式/几何后端；Hermes包不等于Codex已启用，需目标宿主适配 |
| 三维/黏土/空间运镜 | Three.js、Blender | 场景与渲染后端；三维相机、灯光、材质规则写入项目design与分镜 |
| 音乐MV | librosa + 选定画面后端 | 拍点分析，不是自动导演；拍点与切镜需实际校听 |

2026-10-17本机复核：中央库没有heige-video/riso-film/riso-still/riso-score正式入口，Codex未启用；不从本任务下载的研究快照执行它们。p5js/manim-video仅查到Hermes作用域；不将它们列为Codex可直接调用。需要正式接入时通过manage-skills审查、安装与运行验收。

## 每个项目的风格交接

design.md记录色板、字体、构图、材质、角色比例、光照与禁止项；motion记录主体变化、运动曲线、起中末、声音/阅读锚点、相机目的及跨镜承接；分镜表记录本期内容、源资产与验收条件。可以合并成一份短文档，不为形式拆文件。

AI先提出少量有理由的风格方向；新风格制作代表段，实际查看中间帧与连续播放，王杰复核认可后按规则扩展。已有认可风格默认沿用，不每次重选；新主题画面仍需从内容出发设计。

来源（2026-10-17固定快照）：HeiGeAi/HeiGe-Video@0bf7f2eb51ee881636a0155e84938fdf9128d85f；sevenevesai/riso-windowseat@1275fdaf81eb1817b729ee69cbf7b6b6fe535a4e；JohnHeibel/ClaudeAnimationBase@0ac8bf2b31942376cb6b8c4074715595d512acd2。它们是研究资料，不因在此出现就已安装或可执行。
