/**
 * 功能自检（无第三方依赖，node lib/../test/verify.mjs 直接跑）
 * 覆盖：合成数据精确断言 / 轮次归属 / 指标定义 / 无源断言判定 / 插件降级不抛错
 */
import assert from 'node:assert/strict'
import { analyze, countUnsourcedClaims } from '../lib/core/analyze.js'
import { apply, DEFAULT_CONFIG } from '../lib/index.js'

let pass = 0
let fail = 0
const results = []

function test(name, fn) {
  try {
    fn()
    pass++
    results.push(`  ✅ ${name}`)
  } catch (err) {
    fail++
    results.push(`  ❌ ${name}\n       ${err.message}`)
  }
}

// ---------- 构造合成记录 ----------
const R = (text) => ({ type: 'reasoning', text })
const T = (t) => ({ type: 'text', text: t })
const TC = (id = 'c1') => ({ type: 'tool-call', id, name: 'glob', arguments: '{}' })

const records = [
  { type: 'session', version: 4, id: 's1' },
  { type: 'request/header', data: { header: { config: { model: 'deepseek-flash', reasoningEffort: 'high' } } } },
  // 真人消息 + 一条系统注入（应被忽略）
  {
    type: 'user/message',
    data: { source: { kind: 'runtime-context' }, role: 'user', content: [{ type: 'text', text: 'SHOULD BE IGNORED' }] },
  },
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: '真实问题一' }] } },
  // 同一 turn 第一步：10 字推理后立刻调用工具
  {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [R('x'.repeat(10)), TC()] } },
  },
  // 同 turn 第二步：长推理（不应污染 thinkingBeforeActing）
  {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 2,
      message: {
        role: 'assistant',
        content: [
          R('y'.repeat(1000)),
          T('系统整体完成率达到了 95% 但没有任何标注'),
          T('见 README.md 第 12 行，完成率 95%'),
        ],
      },
    },
  },
  { type: 'request/header', data: { header: { config: { model: 'deepseek-flash', reasoningEffort: 'max' } } } },
  { type: 'turn/start', data: { turn: 2 } },
  {
    type: 'user/message',
    data: { source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: '真实问题二' }] },
  },
  // turn 2：200 字推理，无工具调用
  {
    type: 'assistant/message',
    data: { turn: 2, step: 1, message: { role: 'assistant', content: [R('z'.repeat(200)), T('简短回答')] } },
  },
]

const res = analyze(records, { thinActingThreshold: 120 })

// ---------- 断言 ----------
test('轮次归属：系统注入消息不产生幽灵轮', () => {
  assert.equal(res.turns.length, 2, `期望 2 轮，实际 ${res.turns.length}`)
  assert.equal(res.turns[0].userText, '真实问题一')
  assert.equal(res.turns[1].userText, '真实问题二')
})

test('thinkingBeforeActing 只取第一步，不被后续长推理掩盖', () => {
  assert.equal(res.turns[0].thinkingBeforeActing, 10, `期望 10，实际 ${res.turns[0].thinkingBeforeActing}`)
  assert.equal(res.turns[0].reasoningChars, 1010, '总推理字数应累加')
})

test('工具调用计数与回答字数', () => {
  assert.equal(res.turns[0].toolCalls, 1)
  assert.equal(res.turns[1].toolCalls, 0)
  assert.equal(res.turns[0].answerChars, 49, `期望 49，实际 ${res.turns[0].answerChars}`)
})

test('急切动手率 = 1/2', () => {
  assert.equal(res.summary.thinActingRate, 0.5, `实际 ${res.summary.thinActingRate}`)
  assert.equal(res.summary.thinActingTurns, 1)
})

test('effort 历史被记录 high → max', () => {
  assert.deepEqual(res.summary.effortHistory, ['high', 'max'])
})

test('无源断言：1 无源 / 2 含数字行', () => {
  assert.equal(res.turns[0].numericLines, 2, `实际 ${res.turns[0].numericLines}`)
  assert.equal(res.turns[0].unsourced, 1, `实际 ${res.turns[0].unsourced}`)
  assert.equal(res.summary.unsourcedRate, 0.5)
})

test('无源断言判定：已标【推断】的行不计', () => {
  const r = countUnsourcedClaims('据推测完成率 88%【推断】因为样本小')
  assert.equal(r.unsourced, 0)
})

test('无源断言判定：表格行不计', () => {
  const r = countUnsourcedClaims('| 模块 | 95% | 3 小时 |')
  assert.equal(r.numericLines, 0)
})

test('无源断言判定：来源标记命中', () => {
  const r = countUnsourcedClaims('完成率 95%，见 docs/report.md 第三行')
  assert.equal(r.unsourced, 0)
  assert.equal(r.numericLines, 1)
})

test('无源断言判定：否定说法（"没有来源"）不算有来源', () => {
  const r = countUnsourcedClaims('完成率 95% 但整段没有写来源，纯属估计')
  assert.equal(r.unsourced, 1, '出现"来源"二字但被否定，应判为无源')
})

test('空输入不崩', () => {
  const e = analyze([])
  assert.equal(e.turns.length, 0)
  assert.equal(e.summary.depthRatio, null)
  assert.equal(e.summary.thinActingRate, null)
})

// ---------- 插件半：注入桩 ctx，验证「不抛错 + 降级」 ----------
test('插件 apply：空 ctx 不抛错（全降级）', () => {
  const logs = []
  const ctx = { logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: (m) => logs.push(m) } }
  const dispose = apply(ctx, DEFAULT_CONFIG)
  assert.equal(typeof dispose, 'function')
  assert.ok(logs.some((l) => String(l).includes('deep-think')), '应留下日志')
})

test('插件 apply：systemPrompt.section 存在时被调用一次', () => {
  let called = 0
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    systemPrompt: { section: () => { called++ }, removeSection() {} },
  }
  apply(ctx, DEFAULT_CONFIG)
  assert.equal(called, 1)
})

test('插件 apply：tools.register 存在时注册工具', () => {
  let registered = null
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    tools: { register: (t) => { registered = t; return true } },
  }
  apply(ctx, DEFAULT_CONFIG)
  assert.ok(registered, '应注册工具')
  assert.equal(registered.name, 'deepthink_report')
  assert.equal(typeof registered.execute, 'function')
})

test('插件注入的 prompt 包含三条铁律关键词', () => {
  let text = ''
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    systemPrompt: { section: (s) => { text = s.text }, removeSection() {} },
  }
  apply(ctx, DEFAULT_CONFIG)
  for (const kw of ['真实问题', '假设清单', '检索计划', '判据', '【未核实】']) {
    assert.ok(text.includes(kw), `prompt 缺少关键词「${kw}」`)
  }
})

// ---------- 拦截层 ----------
import { DEFAULT_POLICY, evaluateTurn, buildRejectionMessage, buildInjectedMessage } from '../lib/core/intercept.js'

test('拦截：0 次检索 + 带数字结论 → 驳回', () => {
  const v = evaluateTurn({ answerText: '完成率 95%，一共 3 个模块', toolCalls: 0 })
  assert.equal(v.ok, false)
  assert.equal(v.action, 'reject')
  assert.ok(v.violations.length >= 1)
})

test('拦截：检索过且来源齐全 → 放行', () => {
  const v = evaluateTurn({ answerText: '完成率 95%，见 docs/r.md 第 12 行', toolCalls: 3 })
  assert.equal(v.ok, true)
})

test('拦截：无源断言超阈值 → 驳回并带样例', () => {
  const text = [
    '这一批的完成率是 95%，但整段没有任何出处。',
    '错误率稳定在 3% 左右，这个数字没有人核对过。',
    '单次耗时 120 分钟，也是凭印象给的。',
    '最后一句没有任何数字，纯属废话。',
  ].join('\n')
  const v = evaluateTurn({ answerText: text, toolCalls: 5 })
  assert.equal(v.ok, false)
  assert.ok(v.detail.unsourced >= 3, `unsourced=${v.detail.unsourced}`)
})

test('拦截：达到驳回上限 → give_up（不死循环）', () => {
  const v = evaluateTurn({ answerText: '完成率 95% 无出处', toolCalls: 0, rejections: DEFAULT_POLICY.maxRejections })
  assert.equal(v.action, 'give_up')
  assert.equal(v.ok, false)
})

test('拦截：mode=off 直接放行', () => {
  const v = evaluateTurn({ answerText: '完成率 95% 无出处', toolCalls: 0 }, { mode: 'off' })
  assert.equal(v.ok, true)
})

test('驳回指令包含四项要求', () => {
  const msg = buildRejectionMessage(['违规一'], 1)
  for (const kw of ['驳回', '检索', '【未核实】', '重新组织']) assert.ok(msg.includes(kw), `缺少 ${kw}`)
})

test('注入消息形态正确', () => {
  const m = buildInjectedMessage('hi', 1)
  assert.equal(m.role, 'user')
  assert.equal(m.content[0].type, 'text')
  assert.ok(m.id.startsWith('deep-think-reject-'))
})

test('插件拦截闭环：session/event 累积 → turn-stopping 触发注入', async () => {
  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on: (name, h) => {
      handlers.set(name, h)
      return () => {}
    },
  }
  apply(ctx, {
    injectPrompt: false,
    registerTool: false,
    policy: { mode: 'reject', minToolCalls: 1, maxUnsourcedCount: 1 },
  })

  const onSession = handlers.get('session/event')
  const onStop = handlers.get('agent/turn-stopping')
  assert.ok(onSession && onStop, '两个事件都应注册')

  const session = { id: 's-test' }
  onSession(session, { type: 'turn/start', data: { turn: 1 } })
  onSession(session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '完成率 95% 完全没出处' }] } } })

  let injected = null
  const agent = { id: 'a-test', inject: (m) => { injected = m; return true } }
  await onStop({ agent, session, turn: 1 })

  assert.ok(injected, '应当注入驳回消息')
  assert.ok(injected.content[0].text.includes('驳回'), '注入内容应为驳回指令')
})

// ---------- 标识符误报（实测被自己插件驳回后修的） ----------
test('标识符/版本/哈希里的数字不算断言', () => {
  for (const line of [
    'id: "deep-think-reject-1794541465618-1"',
    '当前版本 v0.2.0 已经发布出去',
    '校验值 40c3df57c499 已经写入文件',
    '提交 9f2a1c8b3d4e5f60 已经合并进主干',
  ]) {
    const r = countUnsourcedClaims(line)
    assert.equal(r.numericLines, 0, `不该计入: ${line}`)
  }
})

test('真正的统计数字仍会被抓到', () => {
  const r = countUnsourcedClaims('这一批的完成率是 95%，但整段没有任何出处。')
  assert.equal(r.numericLines, 1)
  assert.equal(r.unsourced, 1)
})

// ---------- 事故回归：防自跑 ----------
function makeCtx() {
  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on: (name, h) => {
      handlers.set(name, h)
      return () => {}
    },
  }
  return { ctx, handlers }
}

test('默认策略是 warn：不注入，只记账', async () => {
  const { ctx, handlers } = makeCtx()
  apply(ctx, { injectPrompt: false, registerTool: false })
  const onSession = handlers.get('session/event')
  const onStop = handlers.get('agent/turn-stopping')
  const session = { id: 's1' }
  onSession(session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '完成率 95% 完全没出处' }] } } })
  let called = 0
  const agent = { id: 'a1', inject: () => { called++; return true } }
  await onStop({ agent, session, turn: 1 })
  assert.equal(called, 0, 'warn 模式不该注入')
})

test('同一 turn 重复 turn-stopping 只注入一次（防自跑）', async () => {
  const { ctx, handlers } = makeCtx()
  apply(ctx, { injectPrompt: false, registerTool: false, policy: { mode: 'reject', maxUnsourcedCount: 1 } })
  const onSession = handlers.get('session/event')
  const onStop = handlers.get('agent/turn-stopping')
  const session = { id: 's2' }
  const msg = { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '完成率 95% 完全没出处' }] } } }
  onSession(session, msg)
  let called = 0
  const agent = { id: 'a2', inject: () => { called++; return true } }
  for (let i = 0; i < 5; i++) await onStop({ agent, session, turn: 1 })
  assert.equal(called, 1, `同一 turn 只该注入一次，实际 ${called}`)
})

test('同一段文本不重复驳回（哈希去重）', async () => {
  const { ctx, handlers } = makeCtx()
  apply(ctx, { injectPrompt: false, registerTool: false, policy: { mode: 'reject', maxUnsourcedCount: 1, maxRejectionsPerTurn: 99 } })
  const onSession = handlers.get('session/event')
  const onStop = handlers.get('agent/turn-stopping')
  const session = { id: 's3' }
  const text = '完成率 95% 完全没出处'
  const agent = { id: 'a3', inject: () => true }
  let called = 0
  agent.inject = () => { called++; return true }
  for (let i = 0; i < 3; i++) {
    onSession(session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text }] } } })
    await onStop({ agent, session, turn: 1 })
  }
  assert.equal(called, 1, `同样文本只该驳一次，实际 ${called}`)
})

test('turn 变化后状态重置，可再次评估', async () => {
  const { ctx, handlers } = makeCtx()
  apply(ctx, { injectPrompt: false, registerTool: false, policy: { mode: 'reject', maxUnsourcedCount: 1 } })
  const onSession = handlers.get('session/event')
  const onStop = handlers.get('agent/turn-stopping')
  const session = { id: 's4' }
  let called = 0
  const agent = { id: 'a4', inject: () => { called++; return true } }
  onSession(session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '完成率 95% 完全没出处' }] } } })
  await onStop({ agent, session, turn: 1 })
  onSession(session, { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: '错误率 88% 也没有出处' }] } } })
  await onStop({ agent, session, turn: 2 })
  assert.equal(called, 2, `两个不同 turn 各驳一次，实际 ${called}`)
})

// ---------- 运行时模式切换（三种形态，用户自选） ----------
import os from 'node:os'
import path from 'node:path'
import { setMode, currentMode, appendViolation, recentViolations, configPath } from '../lib/core/config.js'

test('模式可切换：off / warn / reject，非法值报错', () => {
  const dir = path.join(os.tmpdir(), `dt-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  process.env.DEEP_THINK_HOME = dir
  try {
    assert.equal(currentMode('off'), 'off', '空配置时回落到 fallback')
    setMode('warn')
    assert.equal(currentMode('off'), 'warn')
    setMode('reject')
    assert.equal(currentMode('off'), 'reject')
    setMode('off')
    assert.equal(currentMode('off'), 'off')
    assert.throws(() => setMode('bad'), /只能是/)
  } finally {
    delete process.env.DEEP_THINK_HOME
  }
})

test('warn 记账：写入后可读回', () => {
  const dir = path.join(os.tmpdir(), `dt-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  process.env.DEEP_THINK_HOME = dir
  try {
    appendViolation({ turn: 7, summary: '无源断言 3 处' })
    const lines = recentViolations(5)
    assert.equal(lines.length, 1)
    assert.ok(lines[0].includes('turn=7'))
    assert.ok(lines[0].includes('无源断言'))
  } finally {
    delete process.env.DEEP_THINK_HOME
  }
})

// ---------- 输出 ----------
console.log('\n=== deep-think 功能自检 ===\n')
for (const line of results) console.log(line)
console.log(`\n通过 ${pass} / ${pass + fail}${fail ? `，失败 ${fail}` : ''}\n`)
process.exit(fail ? 1 : 0)
