# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Planned
- 在真实 DSH profile 上完成拦截半的挂载验证（当前唯一未验证项）
- 跨会话趋势图（按天/周统计急切动手率）
- 把无源断言的启发式判定替换为显式引用标记（`[1]` / 脚注）
- 设置界面（`@deepseek-ai/dsh-client-ui-settings` 插槽）

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
- 插件骨架：prompt 注入（尽力而为）+ `deepthink_report` 工具（多候选 API 注册）。
- 自检：15 项断言。
