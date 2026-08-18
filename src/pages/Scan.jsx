import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, fmt$, fmt2 } from '../lib/supabase'
import { verdict, decaySignals, pacingCheck, scanLine, lastN } from '../lib/signals'

function daysAgoIso(n) {
  const d = new Date(); d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

export default function Scan() {
  const [clients, setClients] = useState(null)
  const [metrics, setMetrics] = useState({})
  const [adMetrics, setAdMetrics] = useState({})
  const [revenue, setRevenue] = useState({})
  const [alerts, setAlerts] = useState([])
  const [logged, setLogged] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    const { data: cs } = await supabase.from('clients').select('*').eq('active', true).order('name')
    setClients(cs || [])
    if (!cs?.length) return
    const ids = cs.map(c => c.id)
    const since = daysAgoIso(22)
    const [dm, am, re, al] = await Promise.all([
      supabase.from('daily_metrics').select('*').in('client_id', ids).gte('date', since).order('date'),
      supabase.from('ad_metrics').select('*').in('client_id', ids).gte('date', daysAgoIso(8)).order('date'),
      supabase.from('revenue_entries').select('*').in('client_id', ids).gte('date', since),
      supabase.from('alerts').select('*').in('client_id', ids).eq('resolved', false).order('created_at', { ascending: false }).limit(20),
    ])
    setAlerts(al.data || [])
    const group = rows => {
      const g = {}
      for (const r of rows || []) (g[r.client_id] ||= []).push(r)
      return g
    }
    setMetrics(group(dm.data))
    setAdMetrics(group(am.data))
    setRevenue(group(re.data))
  }

  const rows = useMemo(() => {
    if (!clients) return []
    return clients.map(c => {
      const days = metrics[c.id] || []
      const ads = adMetrics[c.id] || []
      const revMap = Object.fromEntries((revenue[c.id] || []).map(r => [r.date, Number(r.shopify_revenue)]))
      const v = verdict(c, days, ads, revMap)
      const flags = decaySignals(days, ads, revMap)
      const yesterday = days.length ? days[days.length - 1] : null
      const pacing = pacingCheck(yesterday, c.planned_daily_spend)
      if (pacing && pacing.level === 'warn') flags.unshift({ type: 'pacing', text: pacing.text })
      return { c, v, flags, pacing, days }
    }).sort((a, b) => {
      const order = { red: 0, yellow: 1, green: 2 }
      return order[a.v.light] - order[b.v.light]
    })
  }, [clients, metrics, adMetrics, revenue])

  async function logScan() {
    setBusy(true)
    const today = new Date().toISOString().slice(0, 10)
    const entries = rows.map(({ c, v, flags, pacing }) => ({
      client_id: c.id,
      date: today,
      line: scanLine(c, v, pacing, flags),
      flags: flags,
    }))
    await supabase.from('scan_log').upsert(entries, { onConflict: 'client_id,date' })
    setLogged(true)
    setBusy(false)
  }

  if (clients === null) return null
  if (!clients.length) {
    return (
      <>
        <h1>Daily scan</h1>
        <div className="empty">No clients yet. Add your first one under <Link to="/clients" style={{ textDecoration: 'underline' }}>Clients</Link>, then run a Meta backfill.</div>
      </>
    )
  }

  const flaggedCount = rows.filter(r => r.flags.length || r.v.light !== 'green').length

  return (
    <>
      <h1>Daily scan</h1>
      <p className="sub">
        7-day view only. Daily numbers get observed, 7-day numbers get judged.
        {flaggedCount === 0 ? ' Nothing tripped a threshold — the scan is over, touch nothing.' : ` ${flaggedCount} account${flaggedCount > 1 ? 's' : ''} need${flaggedCount === 1 ? 's' : ''} a look.`}
      </p>

      {alerts.length > 0 && (
        <div className="panel" style={{ marginBottom: 16, borderColor: 'var(--red)' }}>
          <h2 style={{ marginTop: 0, color: 'var(--red)' }}>Alerts — account health (checklist item #1)</h2>
          {alerts.map(a => {
            const c = clients.find(x => x.id === a.client_id)
            return (
              <div key={a.id} className="flag">
                <span className="tag" style={{ color: 'var(--red)' }}>{a.type}</span>
                <span style={{ flex: 1 }}><strong>{c?.name || '—'}</strong> — {a.message}</span>
                <button
                  className="btn ghost"
                  style={{ padding: '2px 10px', fontSize: 11 }}
                  onClick={async () => {
                    await supabase.from('alerts').update({ resolved: true }).eq('id', a.id)
                    setAlerts(as => as.filter(x => x.id !== a.id))
                  }}
                >
                  Resolve
                </button>
              </div>
            )
          })}
        </div>
      )}

      <div className="board">
        {rows.map(({ c, v, flags }) => (
          <Link to={`/client/${c.id}`} key={c.id} className="strip">
            <div className={`light ${v.light}`} />
            <div>
              <div className="name">{c.name}</div>
              <div className="meta">
                {flags.length ? flags.map(f => f.type).join(' · ') : 'no flags'}
                {v.w7.revenueSource === 'meta' && v.w7.spend > 0 ? ' · meta-attributed rev' : ''}
                {c.stock_flag ? <span style={{ color: 'var(--amber)' }}> · 📦 {c.stock_flag}</span> : null}
              </div>
            </div>
            <div className="metric">
              <div className={`v ${v.w7.mer !== null ? (v.w7.mer >= c.beroas ? 'good' : 'bad') : ''}`}>{fmt2(v.w7.mer)}</div>
              <div className="k">7d MER / BE {fmt2(c.beroas)}</div>
            </div>
            <div className="metric">
              <div className="v">{fmt$(v.w7.spend)}</div>
              <div className="k">7d spend</div>
            </div>
            <div className={`stamp ${v.call.replace(/[^A-Z]/g, '')}`}>{v.call}</div>
          </Link>
        ))}
      </div>

      <div style={{ marginTop: 20, display: 'flex', gap: 12, alignItems: 'center' }}>
        <button className="btn" onClick={logScan} disabled={busy || logged}>
          {logged ? 'Scan logged' : 'Log today\u2019s scan'}
        </button>
        <span className="sub" style={{ margin: 0 }}>
          One line per account, dated — your receipts when a client asks if you're watching.
        </span>
      </div>
    </>
  )
}
