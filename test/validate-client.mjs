/**
 * 客户端半的本地校验：完全照宿主 @deepseek-ai/dsh-client-modules 的检查逻辑复刻。
 * 目的：在把插件挂进 profile 之前，先证明它不会把启动搞挂。
 *
 * 复刻的三个断言（源码出处：app.asar 内 client-modules/lib/index.js）：
 *   1. dsh.client 必须是对象，且 platform 是字符串（我们要求 'web'）
 *   2. dsh.client.inject / external 若存在必须是字符串数组
 *   3. exports['./client'] 必须存在，且是字符串，或是带字符串 default 的对象
 * 另外再补两条运行时自检（宿主不查，但崩了也难看）：
 *   4. bundle 文件存在、可解析、顶层调用 window.__ModuleLoader__.load({id, factory})
 *   5. factory 返回 { apply, inject }，且 apply 在假 ctx 上能注册 settings.section
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

let pass = 0
let fail = 0
const lines = []
function check(name, fn) {
  try {
    fn()
    pass++
    lines.push(`  ✅ ${name}`)
  } catch (err) {
    fail++
    lines.push(`  ❌ ${name}\n       ${err?.message ?? err}`)
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

// ---------- 1. dsh.client 声明 ----------
check('dsh.client 是对象且 platform === "web"', () => {
  const c = pkg.dsh?.client
  assert(c && typeof c === 'object', 'dsh.client 必须是对象')
  assert(typeof c.platform === 'string', 'platform 必须是字符串')
  assert(c.platform === 'web', `platform 必须是 "web"，实际 "${c.platform}"`)
})

check('dsh.client.inject 是字符串数组', () => {
  const inj = pkg.dsh?.client?.inject
  if (inj === undefined) return
  assert(Array.isArray(inj) && inj.every((x) => typeof x === 'string'), 'inject 必须是字符串数组')
})

// ---------- 2. exports["./client"] ----------
let clientRel
check('exports["./client"] 存在且形状合法', () => {
  const ex = pkg.exports
  assert(ex && typeof ex === 'object', 'package.json 必须有 exports 对象')
  const c = ex['./client']
  assert(c !== undefined, '缺少 exports["./client"] —— 这正是上次启动崩溃的原因')
  if (typeof c === 'string') clientRel = c
  else {
    assert(c && typeof c === 'object' && typeof c.default === 'string', './client 必须是字符串或带 default 的对象')
    clientRel = c.default
  }
})

check('client bundle 文件真实存在', () => {
  assert(clientRel, '上一步未解析出路径')
  const p = path.join(root, clientRel)
  assert(fs.existsSync(p), `文件不存在: ${p}`)
})

// ---------- 3. bundle 能被加载并注册 ----------
check('bundle 顶层调用 __ModuleLoader__.load({ id, factory })', () => {
  const p = path.join(root, clientRel)
  const src = fs.readFileSync(p, 'utf8')
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (rec) => { captured = rec } } },
    console,
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    setTimeout,
    clearTimeout,
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)
  assert(captured, 'bundle 没有调用 window.__ModuleLoader__.load')
  assert(typeof captured.id === 'string' && captured.id.length > 0, 'load 缺少 id')
  assert(typeof captured.factory === 'function', 'load 缺少 factory')
})

check('factory 返回 { apply, inject }，且 apply 能注册 settings.section', () => {
  const p = path.join(root, clientRel)
  const src = fs.readFileSync(p, 'utf8')
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (rec) => { captured = rec } } },
    console,
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    setTimeout,
    clearTimeout,
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)

  // 极简 react 替身：factory 只用 createElement / useState / useEffect
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
  }
  const requireShim = (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  }
  const mod = captured.factory(requireShim)
  assert(mod && typeof mod.apply === 'function', 'factory 没有返回 apply')
  assert(Array.isArray(mod.inject), 'factory 没有返回 inject 数组')

  let registered = null
  const ctx = {
    slots: {
      inject: (slotName, fn) => {
        assert(slotName === 'settings.section', `意外插槽 ${slotName}`)
        fn()
      },
      register: (meta, component) => {
        registered = { meta, component }
        return () => {}
      },
    },
  }
  mod.apply(ctx)
  assert(registered, 'apply 没有注册任何 settings.section')
  assert(registered.meta.id === 'rigor', '注册的 id 不对')
  assert(typeof registered.component === 'function', '注册的组件不是函数')
})

console.log('\n=== client 半校验（复刻宿主规则）===\n')
for (const l of lines) console.log(l)
console.log(`\n通过 ${pass} / ${pass + fail}${fail ? `，失败 ${fail}` : ''}\n`)
process.exit(fail ? 1 : 0)
