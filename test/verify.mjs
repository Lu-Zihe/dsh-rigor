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

// ---------- 输出 ----------
console.log('\n=== deep-think 功能自检 ===\n')
for (const line of results) console.log(line)
console.log(`\n通过 ${pass} / ${pass + fail}${fail ? `，失败 ${fail}` : ''}\n`)
process.exit(fail ? 1 : 0)
