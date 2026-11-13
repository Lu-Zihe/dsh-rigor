/* dsh-deep-think — 浏览器半（手写 __ModuleLoader__ bundle）
 *
 * 只注册一个设置区块：三个按钮切 off / warn / reject。
 * 数据走宿主 loopback 接口 /api/dsh-deep-think/{mode,state}。
 * 参考实现：@a9i5k4/dsh-auto-memory 的 settings.section。
 */
window.__ModuleLoader__.load({
  id: 'dsh-deep-think',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var API_MODE = '/api/dsh-deep-think/mode'
    var API_STATE = '/api/dsh-deep-think/state'

    var MODES = [
      { id: 'off', title: '关闭', desc: '不判断、不记录，只保留命令行与工具' },
      { id: 'warn', title: '只记账', desc: '照常回答，违规写进记录，不打断对话' },
      { id: 'reject', title: '打回重做', desc: '不合格就驳回，强制带检索重写（每轮最多 1 次）' },
    ]

    function card(active) {
      return {
        flex: '1 1 160px',
        minWidth: '150px',
        textAlign: 'left',
        padding: '12px 14px',
        borderRadius: '10px',
        border: active ? '1px solid var(--dsw-color-primary, #2f6fb5)' : '1px solid rgba(128,128,128,.35)',
        background: active ? 'rgba(47,111,181,.10)' : 'transparent',
        cursor: 'pointer',
        lineHeight: 1.5,
      }
    }

    function ModeSection() {
      var st = useState(null)
      var mode = st[0]
      var setMode = st[1]
      var b = useState(null)
      var busy = b[0]
      var setBusy = b[1]
      var e = useState(null)
      var err = e[0]
      var setErr = e[1]
      var s = useState(null)
      var extra = s[0]
      var setExtra = s[1]

      useEffect(function () {
        fetch(API_STATE, { headers: { accept: 'application/json' } })
          .then(function (r) {
            return r.json()
          })
          .then(function (d) {
            setMode(d.mode)
            setExtra(d)
          })
          .catch(function (x) {
            setErr(String(x && x.message ? x.message : x))
          })
      }, [])

      function pick(id) {
        setBusy(id)
        setErr(null)
        fetch(API_MODE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: id }),
        })
          .then(function (r) {
            return r.json()
          })
          .then(function (d) {
            if (d && d.error) setErr(d.error)
            else setMode(d.mode)
          })
          .catch(function (x) {
            setErr(String(x && x.message ? x.message : x))
          })
          .then(function () {
            setBusy(null)
          })
      }

      var children = [
        h(
          'div',
          { key: 'h', style: { marginBottom: '10px' } },
          h('div', { style: { fontWeight: 600, fontSize: '15px' } }, '深度思考 · 拦截模式'),
          h(
            'div',
            { style: { opacity: 0.65, fontSize: '12px', marginTop: '2px' } },
            '切换立即生效，不需要重启。当前：',
            h('b', null, mode === null ? '读取中…' : mode),
          ),
        ),
        h(
          'div',
          { key: 'cards', style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
          MODES.map(function (m) {
            return h(
              'button',
              {
                key: m.id,
                type: 'button',
                onClick: function () {
                  pick(m.id)
                },
                disabled: busy !== null,
                style: card(mode === m.id),
              },
              h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, m.title),
              h('div', { style: { fontSize: '12px', opacity: 0.7 } }, m.desc),
            )
          }),
        ),
      ]

      if (err) {
        children.push(
          h('div', { key: 'err', style: { marginTop: '10px', fontSize: '12px', color: '#e2503b' } }, '出错了：' + err),
        )
      }
      if (extra && extra.configPath) {
        children.push(
          h(
            'div',
            { key: 'path', style: { marginTop: '10px', fontSize: '11px', opacity: 0.5, wordBreak: 'break-all' } },
            '配置：' + extra.configPath,
          ),
        )
      }

      return h('div', { style: { padding: '4px 0 8px' } }, children)
    }

    exports.inject = ['slots']
    exports.apply = function (ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'deep-think', order: 30, label: 'Deep Think' },
          ModeSection,
        )
      })
    }
    return module.exports
  },
})
