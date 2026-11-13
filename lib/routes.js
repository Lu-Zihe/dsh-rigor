/**
 * 宿主侧 HTTP 接口（loopback-only），给浏览器半的按钮用。
 * 路由形状与注册方式照 auto-memory 的写法：
 *   { kind: 'exact', path, handler } → ctx.webServer.register(route)
 */
import { readRuntimeConfig, setMode, currentMode, recentViolations, CONFIG_PATH } from './core/config.js'

export const API_MODE = '/api/dsh-deep-think/mode'
export const API_STATE = '/api/dsh-deep-think/state'

function loopbackOnly(req) {
  const ip = req?.socket?.remoteAddress || ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === ''
}

function json(res, code, body) {
  try {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  } catch {
    // 连接可能已关闭
  }
}

async function readBody(req) {
  return await new Promise((resolve) => {
    let raw = ''
    let done = false
    const finish = (v) => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    try {
      req.on('data', (c) => {
        raw += c
        if (raw.length > 64 * 1024) {
          finish({})
          try {
            req.destroy()
          } catch {}
        }
      })
      req.on('end', () => {
        try {
          finish(raw ? JSON.parse(raw) : {})
        } catch {
          finish({})
        }
      })
      req.on('error', () => finish({}))
    } catch {
      finish({})
    }
  })
}

export function buildRoutes() {
  return [
    {
      kind: 'exact',
      path: API_STATE,
      handler: async (req, res) => {
        if (!loopbackOnly(req)) return json(res, 403, { error: 'forbidden: loopback-only' })
        return json(res, 200, {
          mode: currentMode('off'),
          config: readRuntimeConfig({ force: true }),
          configPath: CONFIG_PATH,
          recent: recentViolations(5),
        })
      },
    },
    {
      kind: 'exact',
      path: API_MODE,
      handler: async (req, res) => {
        if (!loopbackOnly(req)) return json(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method || 'GET') === 'GET') return json(res, 200, { mode: currentMode('off') })
        const body = await readBody(req)
        try {
          const m = setMode(body?.mode)
          return json(res, 200, { mode: m })
        } catch (err) {
          return json(res, 400, { error: String(err?.message ?? err) })
        }
      },
    },
  ]
}
