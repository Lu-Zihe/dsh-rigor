# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Planned
- 跨会话趋势图（按天/周统计急切动手率）
- 把无源断言的启发式判定替换为显式引用标记（`[1]` / 脚注）
- 工具卡片里直接渲染报告（当前是纯文本）

## [0.6.0] — 2026-11-13

### Changed（breaking）
- **项目改名 `dsh-deep-think` → `dsh-rigor`**。旧名描述的是「想要的效果」（让模型想得深），新名描述的是「被度量的标准」（严谨度：过程想够不够 + 结论有没有来源）。功能未变。
- 工具名 `deepthink_report` → `rigor_report`；命令 `deep-think` → `rigor`
- 配置与记账文件改到 `~/.dsh/rigor.config.json`、`~/.dsh/rigor-violations.log`
- HTTP 接口改到 `/api/dsh-rigor/{state,mode}`；客户端插槽 id 改为 `rigor`
- 诊断探针改为 `RIGOR_PROBE=1` 才启用（此前写死文件路径，开源前清理）

## [0.5.0] — 2026-11-13

### Added
- **浏览器半**：设置页新增区块，三个按钮切换 关闭 / 只记账 / 打回重做，点击即时生效。
- 宿主侧 loopback 接口 `/api/dsh-rigor/{state,mode}`。
- `test/validate-client.mjs`：复刻宿主 `client-modules` 校验，能在安装前发现「声明了 `dsh.client` 却没有 `exports["./client"]`」这类会让应用起不来的错误。

### Fixed
- `exports["./client"]` 缺失导致 DSH 启动崩溃（第三方插件被系统整体禁用）。
- 工具选择错误会话：改为按 mtime 取最新，而不是目录遍历顺序。

## [0.2.0] — 2026-11-13

### Added
- **拦截半**：`agent/turn-stopping` 触发评估，违规时通过 `agent.inject()` 把驳回指令注入 `next-step` inbox，使 turn 无法结束、模型必须重做。
- 驳回策略可配：`minToolCalls` / `maxUnsourcedCount` / `maxUnsourcedRate` / `maxRejections` / `mode`（`reject` / `warn` / `off`）。
- 驳回上限（默认 2 次），防止烧钱死循环。
- `lib/core/intercept.js`：纯函数判定层，可独立单测。
- TypeScript 类型声明（`lib/types/*.d.ts`）。
- 英文 README。

### Changed
- `thinkingBeforeActing` 只取 turn 的第一步（原为各步最大值，会被后续长推理掩盖）。
- 无源断言的短行阈值从 16 字降到 8 字；跳过标题行与纯符号行。

### Fixed
- 幽灵轮次：`runtime-context` 等系统注入被当作真人输入（63 轮被算成 118 轮）。
- 否定误判：句中出现「没有写来源」时，"来源"二字被误判为已标注来源。
- `--out` 目标目录不存在时抛 ENOENT。

## [0.1.0] — 2026-11-13

### Added
- 多帧 zstd 解压（单次 `zstdDecompressSync` 只能拿到首个 frame）。
- 四项指标：`thinkingBeforeActing` / `eagerActingRate` / `depthRatio` / `unsourcedClaimRate`。
- CLI：`--session` / `--root` / `--limit` / `--json` / `--out` / `--title`。
- Markdown 报告与逐轮明细（最急的 12 轮）。
- 插件骨架：prompt 注入（尽力而为）+ `rigor_report` 工具（多候选 API 注册）。
- 自检：15 项断言。
