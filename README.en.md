# dsh-rigor

**Measure how much an agent thinks before it acts.**

Not a "make the model slower" tool — it turns *laziness* into a number.

- Parses DeepSeek Harness session logs (`session.v4.jsonl.zstd`, multi-frame zstd)
- Computes per-turn: **thinking-before-acting**, **eager-acting rate**, **unsourced-claim rate**
- Emits Markdown / JSON for dashboards or CI
- Ships an experimental **reject-and-redo** interceptor for DSH agents

> Requires Node ≥ 22.15 (`zlib.zstdDecompressSync`). Zero third-party dependencies.

---

## Why this exists

A user complained: *"You answer fast, but your thinking is shallow — you basically think for a second and then talk."*

Instead of guessing, we measured. Decompressing a 706-frame session log (4.6 MB JSONL) produced three hard facts:

1. **Max effort did not help.** Request headers showed `reasoningEffort` already escalated from `"high"` to `"max"`.
2. **Reasoning blocks do exist**: assistant messages contain `{"type":"reasoning","text":"..."}`.
3. **But the very first step reasons for two sentences.** The first reasoning block in the session reads: *"The user asks me to read a file. Let me find that file… let me first check the working directory."* — then it calls `glob`.

**Conclusion: `reasoningEffort` sets a ceiling, not a willingness.** The real defect is *acting too early in the first step*, and no existing tool measures it.

---

## Metrics

| Metric | Definition |
|---|---|
| **thinkingBeforeActing** | Reasoning characters written in **step 1** of a turn, before the first tool call. Only step 1 — taking the max across steps hides the problem |
| **eagerActingRate** | Share of turns where `thinkingBeforeActing < threshold` (default 120 chars) |
| **depthRatio** | Total reasoning chars ÷ total answer chars |
| **unsourcedClaimRate** | Share of lines containing numbers with no source marker |

---

## Quick start

```bash
node lib/cli.js                       # latest session
node lib/cli.js --session <file>      # specific session
node lib/cli.js --limit 5 --out r.md  # last 5 sessions → file
node lib/cli.js --json                # machine-readable
npm test                              # 23 assertions
```

Real output (63 turns):

```
| 指标 | 值 |
| 轮次 | 63 |
| 深度指数 | 3.56 |
| 平均动手前推理 | 2686 字 |
| 急切动手率 | 0 |
| 无源断言率 | 0.871 |

turn 1  →  thinkingBeforeActing 149 chars → 9 tool calls
```

That `turn 1` row **is** the defect: 149 characters of thought, then nine tool calls.

---

## Experimental interceptor (reject-and-redo)

There is **no output guard** in the host, so "block before display" is impossible. What is possible:

```
answer produced → evaluated before the turn ends
  ├─ compliant → turn ends normally
  └─ violation → a rejection message is injected into the agent's `next-step` inbox
                 → the turn cannot end → the model must redo it with retrieval
                 → after maxRejections (default 2) it is let through and logged
```

The extension point is documented upstream: the bundled `dsh-agent-loop` README states that bounding runaway turns *"must be done from an existing lifecycle extension point such as `agent/turn-stopping`"*. We use exactly that.

API surface used (read from `app.asar`, not guessed):

```js
ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => …)
agent.inject(msg)   // → send(msg, "next-step", false)
agent.steer(msg)    // → send(msg, "next-step", true)
agent.inbox.splice(target, start, removedCount, [msg])
```

**Status: logic tested (8 assertions with a fake agent), host-mount not yet verified.** Event name is confirmed by upstream docs; the injection path degrades to logging if the host rejects it.

---

## Fixes found by our own tests

1. **Ghost turns** — `runtime-context` injections were counted as human input (63 turns became 118). Now only `source.kind === 'user'`.
2. **First-step masking** — taking the max across steps let a long third step hide a two-sentence first step. Now step 1 only.
3. **Negation false negative** — *"no source given"* contains the word "source" and was scored as sourced.
4. **`--out` crash** — missing parent directory threw ENOENT; now `mkdir -p`.

---

## Known limitations

- **unsourcedClaimRate is heuristic** and over-reports on Chinese Markdown tables. Trend, not truth.
- If the host stops persisting reasoning blocks, `thinkingBeforeActing` degrades to 0 — that means "not recorded", not "not thinking".
- Turn/user alignment is a 1:1 approximation; an aborted turn shifts it by one.
- Reads local files only. Nothing is uploaded.

## Roadmap

- [x] L4 observability: parse logs, four metrics, Markdown report
- [x] L2 reject-and-redo interceptor (experimental)
- [ ] Verify host mount on a real profile
- [ ] Cross-session trend chart
- [ ] Replace the heuristic with explicit citation markers

## License

MIT
