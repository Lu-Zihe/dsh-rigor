# dsh-rigor

**量化 Agent「动手前到底想了几句话」。**

不是让模型更慢，是让「偷懒」变成可测量的数字。

- 解析 DeepSeek Harness 的会话日志（`session.v4.jsonl.zstd`，多帧 zstd，逐帧解压）
- 算出每轮的核心指标：**动手前推理字数**、**急切动手率**、**无源断言率**
- 输出 Markdown / JSON，可以接进任何看板或 CI
- 同时提供 DSH 插件形态（注册 `rigor_report` 工具 + 注入思考协议）

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
rigor --limit 3
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

## v0.2「打回重做」——它到底能拦到什么程度

**必须说清：宿主没有 output guard，所以「拦住不让显示」做不到。** 能做到的是**打回**：

```
模型给出回答 → turn 即将结束前评估
   ├─ 合规 → 正常结束
   └─ 违规 → 往 agent 的 next-step inbox 注入一条驳回指令
              → turn 不结束 → 模型必须带检索重答
              → 连续驳回超过上限（默认 2 次）则放行并记 warn，防止烧钱死循环
```

**三个已从 `app.asar` 读到的宿主 API**（不是猜的）：

| API | 形态 | 用途 |
|---|---|---|
| `ctx.on("agent/pre-step", async (payload, next) => …)` | 步骤中间件，有 `next()` | 在步骤边界插逻辑 |
| `agent.inject(msg)` / `agent.steer(msg)` / `agent.followup(msg)` | `send(msg, target, wakeup)`，`target ∈ {next-step, next-turn}` | 把驳回指令塞进下一步 |
| `agent.inbox.splice(target, start, removed, [msg])` | 直接操作 inbox | 兜底路径 |

> **`agent/turn-stopping` 这个钩子是上游官方文档承认的扩展点。** `dsh-agent-loop` 自带 README 原文：
> 「没有内置轮次预算——工具调用或 steering 会让当前轮次继续；限制失控轮次的策略必须从既有生命周期扩展点（如 `agent/turn-stopping`）执行取消。」

**驳回规则（可配）**：

| 规则 | 默认 | 说明 |
|---|---|---|
| `minToolCalls` | 1 | 本轮 0 次检索却给数字 → 直接驳回 |
| `maxUnsourcedCount` | 3 | 无源断言绝对条数 |
| `maxUnsourcedRate` | 0.25 | 无源断言占比 |
| `maxRejections` | 2 | 驳回上限，超过就放行（防死循环） |
| `mode` | `reject` | `warn` 只记账不驳回；`off` 关闭 |

**已验证到什么程度**：拦截判定 + 注入闭环（用假 agent）有 8 项测试；真实宿主挂载**未验证**。

---

## ⚠️ 事故记录（2026-11-13，必读）

**v0.2 的拦截半在真机上造成过「自跑循环」，已停用（默认 off）。**

现象：模型不等用户输入，连续跑完整个会话的步数。

实测（本机会话日志）：某单轮 **30 步 / 28 次工具调用 / 29 条回答**，全程无用户输入；插件共注入驳回 **4 次**，其中多次内容逐字相同。

根因两条：

1. 状态**未按 turn 重置** → 每步用同一段旧文本重复驳回；
2. 注入 `next-step` 会让 **turn 无法结束** → 模型继续下一步 → 再触发钩子 → 再注入。**这是机制性的，不是参数没调好。**

已加的五道刹车（`lib/index.js`）：同 turn 最多驳一次、同文本哈希去重、状态按 `event.data.turn` 重置、会话级熔断、默认 `mode: warn`。测试覆盖（29 项全绿），但**不因此恢复拦截**——要恢复必须换成 `agent/pre-step` 的 `decision.reject` 路线：在模型调用前否决，而不是事后往 inbox 塞消息。

**结论：观测半（CLI）可用；拦截半仅供研究参考，默认不启用。**

---

## 三种模式，由你选（切换不用重启）

拦截策略不是写死的，运行时可切。配置落在 `~/.dsh/rigor.config.json`，每轮读取（1 秒缓存），改完立即生效。

**两种切法**：

1. **图形界面**：设置 → 侧栏 `严谨度 Rigor` → 三个按钮（关闭 / 只记账 / 打回重做），点完立即生效
2. **命令行**：

```bash
rigor --status          # 看当前模式 + 最近的记账
rigor --mode off        # 完全不动
rigor --mode warn       # 只记账，不打断（推荐先用这个）
rigor --mode reject     # 不合格就打回重做
```

| 模式 | 行为 | 适用 |
|---|---|---|
| `off` | 什么都不做，只有 CLI/工具可用 | 只想要观测数据 |
| `warn` | 判定照算，把违规写进 `~/.dsh/rigor-violations.log`，**不打断会话** | 先观察一周误报率 |
| `reject` | 注入驳回指令、强制重做（每轮最多 1 次，全会话 3 次熔断） | 已知误报率低之后 |

`warn` 的记账用 `rigor --status` 直接看，不用翻日志文件。

---

## 验证状态（v0.3 实测）

```bash
npm test     # 29 项断言，全绿
```

| 项 | 状态 |
|---|---|
| 合成数据精确断言（轮次归属 / 首步推理 / 急切率 / effort 历史 / 无源断言 / 防自跑） | ✅ 29/29 |
| 真实会话跑通（本机 64 轮、800+ 个 zstd frame） | ✅ |
| `--limit N` / `--json` / `--out`（含自动建目录） | ✅ |
| 坏路径 / 空输入 | ✅ 非零退出 + 可读报错 |
| **插件半在真实宿主挂载 + 工具被模型调用** | ✅ DSH 桌面 0.2.0-rc.2：工具数 **169 → 170**，`rigor_report` 实际返回报告 |
| 拦截半（打回重做） | ⚠️ 默认 `off`，未启用（见上方事故记录） |

### 真机挂载踩到的四个坑（写下来省别人的时间）

1. **必须 `export const inject = ['tools', 'systemPrompt']`**。不声明时 `apply` 收到的 `ctx` 只有一个自有键 `fiber`，`ctx.tools` 是 `undefined`。注意 `ctx.on` 是原型方法、不需要注入——所以「钩子能跑、工具注册不上」是同一个原因造成的假象。
2. **`ctx.harness` / `ctx.agents` / `ctx.sessions` 未注入时，访问即抛**（`typeof` 得到 `'throw'`，报 `cannot get property "harness" without inject`）。任何探测都要包 `try/catch`，否则一次属性读取就让 `apply` 当场中断。
3. **`ctx.tools.register(definition)` 强制要求 `output: { schema, render, presentationMeta? }`**，缺了直接 `TypeError`。`render(args, value)` 必须返回**内容块数组**：`[{ type: 'text', text: String(value) }]`。
4. **不要用 `Object.keys(ctx)` 判断服务是否存在**——注入的服务是非枚举属性，`Object.keys` 看不到；要用 `typeof ctx.tools === 'object'` 直接探，并包 `try/catch`。

### CLI 开发中改掉的三个 bug（都会让指标失真）

1. **幽灵轮次**：`runtime-context` 注入消息被当成人输入，63 轮被算成 118 轮。修法：只认 `source.kind === 'user'`。
2. **首步被掩盖**：原来取「本 turn 所有步骤的最大推理字数」，第一步想两句、第三步想三千字时指标显示后者。改为只取**第一步**。
3. **否定误判**：句子里出现「没有写来源」时，"来源"二字被当成有来源。加了否定词护栏。

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
cp -r dsh-rigor ~/.dsh/profiles/desktop/node_modules/

# 2. 在 profile 的 package.json 里加入 dsh.profile.bundles
#    "dsh": { "profile": { "bundles": ["dsh-rigor"] } }

# 3. 重启 DSH
```

挂载后：

- 注册工具 `rigor_report`（Agent 可以自己查"我这轮想够了吗"）
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
