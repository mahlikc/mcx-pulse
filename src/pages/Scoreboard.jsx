import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, fmt$, fmt2 } from '../lib/supabase'
import { verdict, economics, windowStats } from '../lib/signals'
import { weightedGpm, simpleGpm } from '../lib/margins'

const WINDOWS = {
  '7d': () => [daysAgo(7), daysAgo(1)],
  '30d': () => [daysAgo(30), daysAgo(1)],
  'This month': () => [monthStart(0), daysAgo(1)],
  'Last month': () => [monthStart(-1), monthEnd(monthStart(-1))],
}
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10) }
function monthStart(off) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + off); return d.toISOString().slice(0, 10) }
function monthEnd(iso) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10) }
const daysBetween = (a, b) => Math.max(1, Math.round((new Date(b) - new Date(a)) / 86400000) + 1)
const p0 = n => (n === null || n === undefined ? '—' : (n * 100).toFixed(1) + '%')

export default function Scoreboard() {
  const [view, setView] = useState('acquisition')
  const [win, setWin] = useState('7d')
  const [rows, setRows] = useState(null)

  useEffect(() => { load() }, [win])

  async function load() {
    setRows(null)
    const [start, end] = WINDOWS[win]()
    const finMonth = monthStart(0)
    const { data: clients } = await supabase.from('clients').select('*').eq('active', true).order('name')
    if (!clients?.length) { setRows([]); return }
    const ids = clients.map(c => c.id)
    const [dm, re, am, fin, skus, mix] = await Promise.all([
      supabase.from('daily_metrics').select('*').in('client_id', ids).gte('date', start).lte('date', end).order('date'),
      supabase.from('revenue_entries').select('*').in('client_id', ids).gte('date', start).lte('date', end),
      supabase.from('ad_metrics').select('*').in('client_id', ids).gte('date', daysAgo(8)),
      supabase.from('client_finance').select('*').in('client_id', ids).in('month', [finMonth, monthStart(-1)]),
      supabase.from('skus').select('*').in('client_id', ids),
      supabase.from('sku_sales').select('*').in('client_id', ids).eq('month', monthStart(-1)),
    ])
    const g = (data, key = 'client_id') => {
      const out = {}
      for (const r of data.data || []) (out[r[key]] ||= []).push(r)
      return out
    }
    const dmG = g(dm), reG = g(re), amG = g(am), finG = g(fin), skuG = g(skus), mixG = g(mix)
    const nDays = daysBetween(start, end)

    const built = clients.map(c => {
      const days = dmG[c.id] || []
      const revRows = reG[c.id] || []
      const revMap = Object.fromEntries(revRows.map(r => [r.date, Number(r.shopify_revenue)]))
      const stats = windowStats(days, revMap)
      const eco = economics(days, revRows)
      const v = verdict(c, days, amG[c.id] || [], revMap)

      // margin: this month's saved finance row, else derive from catalog + last month's mix
      const finRow = (finG[c.id] || []).sort((a, b) => (a.month < b.month ? 1 : -1))[0]
      let gpm = finRow?.weighted_gpm ?? null
      if (!gpm) {
        const w = weightedGpm(skuG[c.id] || [], mixG[c.id] || [])
        gpm = w.gpm ?? simpleGpm(skuG[c.id] || [])
      }
      const feesPct = Number(finRow?.fees_pct ?? 0.03)
      const shipPer = Number(finRow?.avg_ship_cost ?? 0)
      const opexPro = Number(finRow?.monthly_opex ?? 0) * (nDays / 30.44)
      const orders = revRows.reduce((s, r) => s + (Number(r.orders) || 0), 0)

      let pnl = null
      if (gpm && stats.revenue > 0) {
        const gross = stats.revenue * gpm
        const fees = stats.revenue * feesPct
        const ship = shipPer * orders
        const commission = stats.revenue * (Number(c.commission_rate) || 0.1)
        const net = gross - fees - ship - opexPro - stats.spend
        pnl = { gross, fees, ship, opex: opexPro, commission, clientNet: net - commission, netMargin: (net - commission) / stats.revenue }
      }

      return { c, stats, eco, v, gpm, pnl }
    })
    setRows(built)
  }

  const totals = useMemo(() => {
    if (!rows) return null
    const t = { spend: 0, rev: 0, newRev: 0, retRev: 0, commission: 0, clientNet: 0 }
    for (const r of rows) {
      t.spend += r.stats.spend; t.rev += r.stats.revenue
      if (r.eco) { t.newRev += r.eco.newRev; t.retRev += r.eco.retRev }
      if (r.pnl) { t.commission += r.pnl.commission; t.clientNet += r.pnl.clientNet }
    }
    return t
  }, [rows])

  return (
    <>
      <h1>Scoreboard</h1>
      <p className="sub">Every client, one table, auto-computed from synced data — no manual tracker entries. Margin math uses this month's finance inputs, else the catalog + last month's sales mix.</p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {['acquisition', 'profitability'].map(t => (
          <button key={t} className={view === t ? 'btn' : 'btn ghost'} onClick={() => setView(t)} style={{ textTransform: 'capitalize' }}>{t}</button>
        ))}
        <span style={{ flex: 1 }} />
        {Object.keys(WINDOWS).map(w => (
          <button key={w} className={win === w ? 'btn' : 'btn ghost'} style={{ padding: '6px 12px' }} onClick={() => setWin(w)}>{w}</button>
        ))}
      </div>

      {rows === null && <div className="empty">Crunching…</div>}
      {rows?.length === 0 && <div className="empty">No active clients yet.</div>}

      {rows?.length > 0 && view === 'acquisition' && (
        <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Client</th><th>Spend</th><th>New ord</th><th>$ New rev</th><th>nAOV</th><th>CAC</th><th>BECPA</th><th>nMER</th>
                <th>Ret ord</th><th>$ Ret rev</th><th>rAOV</th><th>% NC rev</th><th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ c, stats, eco, v }) => (
                <tr key={c.id}>
                  <td style={{ fontFamily: 'var(--display)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                    <span className={`light ${v.light}`} style={{ display: 'inline-block', width: 9, height: 9, marginRight: 8, verticalAlign: 'middle' }} />
                    <Link to={`/client/${c.id}`}>{c.name}</Link>
                  </td>
                  <td>{fmt$(stats.spend)}</td>
                  <td>{eco ? eco.newOrders : '—'}</td>
                  <td>{eco ? fmt$(eco.newRev) : '—'}</td>
                  <td>{eco ? fmt$(eco.naov) : '—'}</td>
                  <td>{eco ? fmt$(eco.ncpa) : '—'}</td>
                  <td>{c.becpa ? fmt$(c.becpa) : '—'}</td>
                  <td>{eco ? fmt2(eco.nMer) : '—'}</td>
                  <td>{eco ? eco.retOrders : '—'}</td>
                  <td>{eco ? fmt$(eco.retRev) : '—'}</td>
                  <td>{eco ? fmt$(eco.raov) : '—'}</td>
                  <td>{eco && eco.pctNewRev !== null ? eco.pctNewRev.toFixed(1) + '%' : '—'}</td>
                  <td><span className={`stamp ${v.call.replace(/[^A-Z]/g, '')}`} style={{ minWidth: 0, padding: '2px 8px' }}>{v.call}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows?.length > 0 && view === 'profitability' && (
        <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Client</th><th>Revenue</th><th>Wtd GPM</th><th>Gross profit</th><th>Fees</th><th>Ship</th><th>OpEx*</th><th>Ad spend</th>
                <th>Commission</th><th>Client net</th><th>Net margin</th><th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ c, stats, gpm, pnl, v }) => (
                <tr key={c.id}>
                  <td style={{ fontFamily: 'var(--display)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                    <span className={`light ${v.light}`} style={{ display: 'inline-block', width: 9, height: 9, marginRight: 8, verticalAlign: 'middle' }} />
                    <Link to={`/client/${c.id}`}>{c.name}</Link>
                  </td>
                  <td>{fmt$(stats.revenue)}</td>
                  <td>{p0(gpm)}</td>
                  <td>{pnl ? fmt$(pnl.gross) : '—'}</td>
                  <td>{pnl ? fmt$(pnl.fees) : '—'}</td>
                  <td>{pnl ? fmt$(pnl.ship) : '—'}</td>
                  <td>{pnl ? fmt$(pnl.opex) : '—'}</td>
                  <td>{fmt$(stats.spend)}</td>
                  <td>{pnl ? fmt$(pnl.commission) : '—'}</td>
                  <td style={{ color: pnl ? (pnl.clientNet >= 0 ? 'var(--green)' : 'var(--red)') : undefined }}>{pnl ? fmt$(pnl.clientNet) : '—'}</td>
                  <td>{pnl ? p0(pnl.netMargin) : '—'}</td>
                  <td><span className={`stamp ${v.call.replace(/[^A-Z]/g, '')}`} style={{ minWidth: 0, padding: '2px 8px' }}>{v.call}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totals && rows?.length > 0 && (
        <p className="sub" style={{ marginTop: 12, fontFamily: 'var(--mono)' }}>
          Totals — spend {fmt$(totals.spend)} · revenue {fmt$(totals.rev)} · your commission {fmt$(totals.commission)}
          {view === 'profitability' ? ` · combined client net ${fmt$(totals.clientNet)}` : ''}
          {'  '}(*OpEx prorated to the window; "—" means no margin inputs yet — add the client's catalog or monthly finance inputs)
        </p>
      )}
    </>
  )
}
