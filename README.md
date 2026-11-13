# dsh-deep-think

**量化 Agent「动手前到底想了几句话」。**

不是让模型更慢，是让「偷懒」变成可测量的数字。

- 解析 DeepSeek Harness 的会话日志（`session.v4.jsonl.zstd`，多帧 zstd，逐帧解压）
- 算出每轮的核心指标：**动手前推理字数**、**急切动手率**、**无源断言率**
- 输出 Markdown / JSON，可以接进任何看板或 CI
- 同时提供 DSH 插件形态（注册 `deepthink_report` 工具 + 注入思考协议）

> 依赖：Node ≥ 22.15（需要 `zlib.zstdDecompressSync`）。零第三方依赖。

---

## 为什么有这个项目

起因是一句用户抱怨：**「你每次都很快说话，但思考程度很浅，基本都是想一下就说。」**

于是去查证据，不是猜。解压本机会话日志（706 个 zstd frame → 4.6 MB JSONL），拿到三条硬事实：

1. **把 effort 加到最大也没用。** 请求头显示已从 `reasoningEffort: "high"` 切到 `"max"`。
2. **推理块确实存在**：`assistant/message` 的 content 里有 `{"type":"reasoning","text":"..."}`。
3. **但第一步的推理极短。** 会话第一条推理块原文：

   > "The user asks me to read '交接文档.md'. Let me find that file in the workspace. Let me first check the working directory and locate the file."

   两句，然后立刻调用工具。

**结论：`reasoningEffort` 控制的是上限，不是使用意愿。真正的病灶是「第一步动手太早」。** 而市面上没有工具在测这个，所以写了这个。

---

## 指标定义

| 指标 | 定义 | 为什么重要 |
|---|---|---|
| **thinkingBeforeActing** | 本 turn **第一步**里、第一次调用工具之前写的推理字数 | 直接对应「想两句就动手」。用 max 会被后续步骤的长推理掩盖，所以只取第一步 |
| **eagerActingRate** | `thinkingBeforeActing < 阈值`（默认 120 字）的轮次占比 | 一句话概括：这个 Agent 有多急 |
| **depthRatio** | 推理总字数 ÷ 回答总字数 | 先想后写 vs 边写边想 |
| **unsourcedClaimRate** | 含数字、且整行没有任何来源标记的行 占比 | 对应「编数据」 |

阈值可通过配置调整，默认 120 字是经验值。

---

## 快速开始

```bash
# 分析最近一个会话
node lib/cli.js

# 分析指定会话
node lib/cli.js --session ~/.dsh/sessions/<ws>/<session>/session.v4.jsonl.zstd

# 最近 5 个会话，写进文件
node lib/cli.js --limit 5 --out report.md

# 机器可读
node lib/cli.js --json
```

装成全局命令：

```bash
npm i -g .   # 或 pnpm link --global
deep-think --limit 3
```

### 真实输出（本机实测，63 轮）

```
| 指标 | 值 |
|---|---:|
| 轮次 | 63 |
| 深度指数 | 3.558 |
| 平均动手前推理 | 2686 字 |
| 急切动手率 | 0 |
| 无源断言率 | 0.871 |
| 工具调用合计 | 173 |

逐轮明细（最急的前 3 轮）
| turn | 动手前推理 | 工具 | 回答 |
|---:|---:|---:|---:|
| 1 | 149 | 9 | 779 |   ← 想 149 字就开了 9 次工具调用
| 59 | 899 | 2 | 343 |
| 2 | 914 | 9 | 2879 |
```

**turn 1 那一行就是病灶本身：149 字 → 9 次工具调用。**

---

## 已知局限（请先读再信）

1. **无源断言率是启发式的**，会误报。中文 Markdown 表格、代码块、列表里的数字容易被误判。已做的降噪：跳过表格行、跳过 <16 字的碎行、跳过已标 `【推断】/【未核实】` 的行。**但请只看趋势，别把单点当真理。** 本机实测 0.87 偏高的原因大概率在此，欢迎 PR 改进。
2. **`thinkingBeforeActing` 依赖日志里保存了 reasoning 块。** 若宿主或模型关闭了推理输出，该值会退化为 0——这时它不代表"没思考"，只代表"没记录"。
3. **`user/message` 只有 `source.kind === 'user'` 才算真人输入**，`runtime-context` / `user-approval` 是系统注入，会被跳过。若你的宿主用了别的 kind 名，需要相应调整。
4. **只读本地文件，不上传任何内容。**

---

## 作为 DSH 插件安装

```bash
# 1. 放进 profile 的 node_modules
cp -r dsh-deep-think ~/.dsh/profiles/desktop/node_modules/

# 2. 在 profile 的 package.json 里加入 dsh.profile.bundles
#    "dsh": { "profile": { "bundles": ["dsh-deep-think"] } }

# 3. 重启 DSH
```

挂载后：

- 注册工具 `deepthink_report`（Agent 可以自己查"我这轮想够了吗"）
- 尝试向系统提示注入「深度思考协议」（若 `ctx.systemPrompt.section` 不存在则静默降级，只记 debug 日志）

**插件半是尽力而为的**：宿主 API 变化会让它降级，但 CLI 与 `/core` 永远可用，不依赖宿主。

---

## 路线图

- [x] **L4 可测量**：解析日志 + 四项指标 + Markdown 报告
- [ ] **L2 外部否决**：每轮后用独立模型调用做审计，不合格则把驳回意见注入下一轮强制重做
- [ ] **L3 硬拦截**：工具调用前 gate（需宿主提供 beforeCall hook）
- [ ] 跨会话趋势图（每天/每周的急切动手率）
- [ ] 无源断言率的替换方案：用引用标记（`[1]` 或脚注）而不是关键词判定

**顺序不是随便定的**：先有测量，才知道该在哪一层设阈值。否则审计规则本身又是一次拍脑袋。

---

## License

MIT
