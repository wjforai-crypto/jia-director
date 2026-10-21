## 安全修订 · 2026-10-21

当前分发的锁文件已应用 GHSA-68fv-2mgg-jv7q 修复：`source-map-js` 从1.2.1更新至1.2.2。它是PostCSS的间接依赖；Remotion、React、场景代码与渲染脚本未改。下文“原字节”描述最初导入状态，锁文件已由本段明确修订。来源清单保留原锁文件的upstreamSha256，并记录当前哈希与localPatches。历史快照携带的可安装模板也应用同一补丁；未删除历史资料。

[GitHub安全公告](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)。已有工程须在自己的模板目录更新依赖并复核，更新Skill不会自动重写项目的node_modules。

---

# LiveCanvas 模板来源

本目录的 data、package/lock、render、tsconfig 和 src 文件复制自 `pengchujin/livecanvas` 提交 `d75df0a90a295fc7cf634e7775df47a323ad0bea` 的 `livecanvas/assets/remotion`，原代码未改。Copyright © 2026 pengchujin；完整 [MIT许可](LICENSE.txt) 随包保留。

本目录只携带源码模板，不携带原仓库演示图片、视频、商标或 emoji，不转授这些媒体的权利。[原仓库署名说明](https://github.com/pengchujin/livecanvas/blob/d75df0a90a295fc7cf634e7775df47a323ad0bea/THIRD_PARTY_NOTICES.md) 另按原字节保存为 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)；其原仓库相对路径应从上述网页访问。

Remotion 和 React 未打包，使用时遵循其许可和已有工程运行约定。[Remotion 许可](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md)。本次导入未安装模板依赖或声称原模板已在本机渲染。文件哈希见 Skill 的 [sources.json](../motion-library/sources.json)。

后续配置记录（2026-10-03，Skill 1.1.1）：已在工作区独立runtime按上述原lock安装依赖并实际运行原render脚本；本目录上游源码继续保持原字节。自有适配器仅在新工程副本添加Windows中文字体后备，不改原模板；调用与比例限制见 [data-charts.md](../../references/data-charts.md)。
