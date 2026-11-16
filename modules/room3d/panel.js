// 房间面板：iframe 外面加一块素材状态——素材没就绪时页面只剩阴影，这里要能一眼看出原因并手动重下。
const { useEffect, useState } = React

return function Panel({ toast }) {
  const [assets, setAssets] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try {
      const r = await call('/health')
      if (r && r.assets) setAssets(r.assets)
    } catch (e) {
      setAssets(null)
    }
  }
  useEffect(() => { load() }, [])
  const redownload = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await call('/api/room/fetch-assets', {})
      if (toast) toast((r && (r.message || (r.ok ? '素材包下载完成' : '素材包下载失败'))) || '素材包下载失败')
      await load()
    } finally {
      setBusy(false)
    }
  }
  const status = !assets
    ? '动作素材状态：检查中…'
    : assets.ready
      ? `动作素材：已就绪（${assets.count || 0} 个视频）`
      : `动作素材：未就绪${assets.downloading ? '（正在下载）' : ''}${assets.lastError ? '；上次失败：' + assets.lastError : ''}`
  return h('div', null,
    h(ui.Card, { title: '房间' },
      h('div', { className: 'ab-note', style: { marginBottom: '10px' } },
        '房间页面、3D 资产和房间状态都由 Aurabot 自己托管。屋里一开始是空的，'
        + '右上角「✎ 家具」可以自己摆放。'
      ),
      h('div', { className: 'ab-note', style: { marginBottom: '10px', color: assets && !assets.ready ? '#ff9b9b' : undefined } }, status),
      h(ui.Row, null,
        h(ui.Btn, { onClick: redownload }, busy ? '下载中…' : '重新下载素材')
      ),
      assets && assets.hint ? h('div', { className: 'ab-note ab-muted', style: { marginTop: '6px' } }, assets.hint) : null,
      assets && assets.url ? h('div', { className: 'ab-note ab-muted ab-small' }, '素材地址：' + assets.url) : null
    ),
    h('iframe', {
      src: '/aurabot/api/ext/room3d/page',
      style: { width: '100%', height: '80vh', border: '0', borderRadius: '10px', background: '#05070f' },
      title: '房间',
    })
  )
}
