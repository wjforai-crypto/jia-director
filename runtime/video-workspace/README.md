# 视频剪辑工作区 · Public runtime

这里是“视频剪辑 skill”原本调用的执行工作区，**不包含TTS或音色克隆实现**。

- `scripts/rough-review.mjs`：原片、原声波形、词级校对、粗剪与SRT导出。
- `scripts/fine-cut.mjs`：帧级精剪、保留原声音轨、字幕映射和技术QA。
- `scripts/review-stages.mjs`、`ui/rough-review`：粗剪/精剪/补图审片面板。
- `scripts/local-asr.mjs`：从原语音适配器独立提取的ASR接口，不依赖TTS。
- `runtime/source-film`：按时间求值、逐帧采样、自定义Canvas/HTML源码出片。
- `runtime/visual-lab`：Canvas/WebGL/Three.js/p5等视觉库与可选渲染适配。
- `runtime/livecanvas-remotion`：已保留2.0.2安全修复的图表工程模板。
- `runtime/hyperframes`：固定版本的可选HyperFrames启动适配。

从仓库根目录运行 `scripts/setup.ps1`，详见[安装与使用](../../docs/安装与使用.md)。
配置在本机生成，不要求原作者的盘符。Whisper可选，未配置时可显式导入现有转写；
转写导入不等于已核对。原片、客户资料、音色样本、模型权重与历史项目均未包含。
