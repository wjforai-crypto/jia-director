# 渲染模板依赖安全

2.0.2修复GHSA-68fv-2mgg-jv7q：主LiveCanvas模板与历史快照中的source-map-js都锁定为1.2.2；PostCSS原声明^1.2.1允许此兼容补丁，无需强制升级Remotion或React。场景、数据和渲染脚本保持原样。上游原锁文件哈希留在两份sources.json的upstreamSha256字段，当前哈希与修订记录单列。

在本Skill目录运行：

```sh
node scripts/check-render-dependencies.mjs
```

这是上述公告的离线版本回归检查，不代表未来所有漏洞均已排除。发布前还须分别进入两份assets/livecanvas-remotion模板目录运行`npm audit --package-lock-only --audit-level=high`，再在独立工程用`npm ci`检查锁文件、类型与实际渲染。不要通过关闭审计或运行`npm audit fix --force`掩盖告警。

已有使用者先更新Skill；已经复制成项目的模板不会随Skill自动更新。对已有LiveCanvas工程，提交或备份自己的改动后，在该项目的package.json所在目录运行`npm update source-map-js --package-lock-only`，检查diff只改此间接依赖；再执行`npm ci`及`npm audit --audit-level=high`。有新漏洞、版本冲突或其他改动时应单独核对，不能复用本次检查结论。

[GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) · [上游1.2.2发布记录](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2)。
