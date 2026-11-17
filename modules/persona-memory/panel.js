const { useEffect, useRef, useState } = React
const formatTime = at => at ? new Date(at).toLocaleString() : ''

const styles = `
.pm-preview{display:grid;gap:14px;min-width:0;color:var(--ab-text,inherit)}
.pm-preview h2,.pm-preview p,.pm-preview ul{margin:0}
.pm-preview .pm-meta{color:var(--ab-sub,#68758a);font-size:13px}
.pm-preview .pm-rows{display:grid;gap:8px;padding:0;list-style:none}
.pm-preview .pm-rows li{display:grid;gap:5px;min-width:0;padding:14px 16px;border:1px solid var(--ab-line,#e4eaf1);border-radius:12px;background:var(--ab-card,transparent)}
.pm-preview .pm-rows p{white-space:pre-wrap;overflow-wrap:anywhere}
.pm-preview .pm-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pm-preview button{min-height:38px}
.pm-preview button:focus-visible{outline:2px solid var(--ab-sea,#3074bd);outline-offset:2px}
`

return function Panel() {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(true)
  const [message, setMessage] = useState('')
  const request = useRef(0)

  async function load(offset = 0) {
    const serial = ++request.current
    setBusy(true)
    setMessage('')
    setData(null)
    try {
      const result = await call('/state?offset=' + encodeURIComponent(offset))
      if (serial !== request.current) return
      if (!result?.ok) throw new Error(result?.message || '读取失败，请刷新重试。')
      setData(result)
    } catch (error) {
      if (serial === request.current) setMessage(error.message || '读取失败，请刷新重试。')
    } finally {
      if (serial === request.current) setBusy(false)
    }
  }

  useEffect(() => {
    load()
    return () => { request.current++ }
  }, [])

  const button = (label, offset, disabled = false) => h('button', {
    type: 'button', className: 'ab-btn', disabled: busy || disabled, onClick: () => load(offset),
  }, label)

  return h('section', { className: 'pm-preview', 'aria-busy': busy },
    h('style', null, styles),
    h('h2', null, '人设记忆预览'),
    h('p', { className: 'pm-meta' }, '只读查看当前人格与主人的私聊原生记忆。'),
    busy && h('p', { role: 'status' }, '正在读取…'),
    message && h('p', { role: 'alert' }, message),
    data && !data.available && h('p', { role: 'status' }, data.message),
    data?.available && h(React.Fragment, null,
      h('p', { className: 'pm-meta' }, '当前人格 ', data.personaId,
        data.delivery ? ' · 确认送达 ' + data.delivery.count + ' 次' : ' · 送达回执暂不可用',
        data.delivery?.at ? ' · 最近送达 ' + formatTime(data.delivery.at) : ''),
      data.items.length
        ? h('ul', { className: 'pm-rows' }, ...data.items.map(item => h('li', { key: item.id },
          h('p', null, item.text),
          item.at ? h('time', { className: 'pm-meta', dateTime: new Date(item.at).toISOString() }, formatTime(item.at)) : null)))
        : h('p', { role: 'status' }, '这一页没有可预览的记忆。')),
    h('div', { className: 'pm-actions' },
      data?.available && button('上一页', Math.max(0, data.offset - data.pageSize), data.offset === 0),
      data?.available && button('下一页', data.nextOffset, data.nextOffset == null),
      button('刷新', 0)),
  )
}
