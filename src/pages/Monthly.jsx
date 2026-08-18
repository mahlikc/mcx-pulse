import { useEffect, useMemo, useState } from 'react'
import { supabase, fmt$, fmt2 } from '../lib/supabase'
import { windowStats, economics, trendArrow } from '../lib/signals'
import { weightedGpm, simpleGpm } from '../lib/margins'

function monthStart(offset = 0) {
  const d = new Date()
  d.setDate(1); d.setMonth(d.getMonth() + offset)
  return d.toISOString().slice(0, 10)
}
function monthEnd(startIso) {
  const d = new Date(startIso + 'T00:00:00Z')
  d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0)
  return d.toISOString().slice(0, 10)
}
const label = iso => new Date(iso + 'T00:00:00Z').toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const r0 = n => (n === null || n === undefined ? '—' : '$' + Math.round(n).toLocaleString())
const p1 = n => (n === null || n === undefined ? '—' : n.toFixed(1) + '%')

async function pull(clientId, start, end) {
  const [{ data: dm }, { data: re }] = await Promise.all([
    supabase.from('daily_metrics').select('*').eq('client_id', clientId).gte('date', start).lte('date', end).order('date'),
    supabase.from('revenue_entries').select('*').eq('client_id', clientId).gte('date', start).lte('date', end),
  ])
  const days = dm || []
  const revRows = re || []
  const revMap = Object.fromEntries(revRows.map(r => [r.date, Number(r.shopify_revenue)]))
  const stats = windowStats(days, revMap)
  const eco = economics(days, revRows)
  const orders = revRows.reduce((s, r) => s + (Number(r.orders) || 0), 0)
  const aov = orders > 0 ? stats.revenue / orders : null
  return { stats, eco, aov, days, revRows }
}

export default function Monthly() {
  const [clients, setClients] = useState([])
  const [selected, setSelected] = useState('')
  const [monthIso, setMonthIso] = useState(monthStart(-1)) // default: last month
  const [cur, setCur] = useState(null)
  const [prev, setPrev] = useState(null)
  const [finance, setFinance] = useState({ weighted_gpm: '', fees_pct: '0.03', avg_ship_cost: '', monthly_opex: '' })
  const [inputs, setInputs] = useState({ list_size: '', list_rev_pct: '', events_planned: '', events_done: '', new_skus: '', returning_pct: '', buyer_insight: '' })
  const [cohortRows, setCohortRows] = useState([])
  const [body, setBody] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    supabase.from('clients').select('*').eq('active', true).order('name')
      .then(({ data }) => { setClients(data || []); if (data?.length) setSelected(data[0].id) })
  }, [])

  const client = useMemo(() => clients.find(c => c.id === selected), [clients, selected])

  useEffect(() => { if (client) load() }, [selected, monthIso])

  async function load() {
    setMsg('')
    const prevIso = (() => { const d = new Date(monthIso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10) })()
    const [c, p, { data: fin }, { data: inp }, { data: co }] = await Promise.all([
      pull(client.id, monthIso, monthEnd(monthIso)),
      pull(client.id, prevIso, monthEnd(prevIso)),
      supabase.from('client_finance').select('*').eq('client_id', client.id).eq('month', monthIso).maybeSingle(),
      supabase.from('client_monthly_inputs').select('*').eq('client_id', client.id).eq('month', monthIso).maybeSingle(),
      supabase.from('cohorts').select('*').eq('client_id', client.id).order('cohort_month', { ascending: false }).limit(4),
    ])
    setCur(c); setPrev(p); setCohortRows(co || [])
    if (fin) setFinance({ weighted_gpm: fin.weighted_gpm ?? '', fees_pct: fin.fees_pct ?? '0.03', avg_ship_cost: fin.avg_ship_cost ?? '', monthly_opex: fin.monthly_opex ?? '' })
    else setFinance({ weighted_gpm: '', fees_pct: '0.03', avg_ship_cost: '', monthly_opex: '' })
    if (inp) setInputs({
      list_size: inp.list_size ?? '', list_rev_pct: inp.list_rev_pct ?? '',
      events_planned: inp.events_planned ?? '', events_done: inp.events_done ?? '',
      new_skus: inp.new_skus ?? '', returning_pct: inp.returning_pct ?? '', buyer_insight: inp.buyer_insight ?? '',
    })
    else setInputs({ list_size: '', list_rev_pct: '', events_planned: '', events_done: '', new_skus: '', returning_pct: '', buyer_insight: '' })
  }

  async function computeGpm() {
    const [{ data: skus }, { data: sales }] = await Promise.all([
      supabase.from('skus').select('*').eq('client_id', client.id),
      supabase.from('sku_sales').select('*').eq('client_id', client.id).eq('month', monthIso),
    ])
    if (!skus?.length) { setMsg('No catalog yet — add SKUs with COGS + price on the client page first.'); return }
    const w = weightedGpm(skus, sales || [])
    const gpm = w.gpm ?? simpleGpm(skus)
    if (!gpm) { setMsg('Could not compute — check SKU prices.'); return }
    setFinance(f => ({ ...f, weighted_gpm: Number(gpm.toFixed(3)) }))
    setMsg(w.gpm !== null
      ? `Weighted GPM ${(gpm * 100).toFixed(1)}% from ${label(monthIso)} sales mix (${(w.coverage * 100).toFixed(0)}% of revenue matched). Save inputs to lock it.`
      : `No sales mix for ${label(monthIso)} — used unweighted catalog average ${(gpm * 100).toFixed(1)}%. Save inputs to lock it.`)
  }

  async function saveInputs() {
    const numOrNull = v => (v === '' || v === null ? null : Number(v))
    await Promise.all([
      supabase.from('client_finance').upsert({
        client_id: client.id, month: monthIso,
        weighted_gpm: numOrNull(finance.weighted_gpm), fees_pct: numOrNull(finance.fees_pct),
        avg_ship_cost: numOrNull(finance.avg_ship_cost), monthly_opex: numOrNull(finance.monthly_opex),
      }, { onConflict: 'client_id,month' }),
      supabase.from('client_monthly_inputs').upsert({
        client_id: client.id, month: monthIso,
        list_size: numOrNull(inputs.list_size), list_rev_pct: numOrNull(inputs.list_rev_pct),
        events_planned: numOrNull(inputs.events_planned), events_done: numOrNull(inputs.events_done),
        new_skus: numOrNull(inputs.new_skus), returning_pct: numOrNull(inputs.returning_pct),
        buyer_insight: inputs.buyer_insight || null,
      }, { onConflict: 'client_id,month' }),
    ])
    setMsg('Inputs saved.')
  }

  // ---- derived P&L (Part 9a/9e) ----
  const pnl = useMemo(() => {
    if (!cur || !client) return null
    const rev = cur.stats.revenue
    const spend = cur.stats.spend
    const gpm = Number(finance.weighted_gpm) || null
    if (!gpm) return { rev, spend, incomplete: true }
    const fees = (Number(finance.fees_pct) || 0) * rev
    const orders = cur.revRows.reduce((s, r) => s + (Number(r.orders) || 0), 0)
    const ship = (Number(finance.avg_ship_cost) || 0) * orders
    const opex = Number(finance.monthly_opex) || 0
    const grossProfit = rev * gpm
    const netBeforeCommission = grossProfit - fees - ship - opex - spend
    const commission = rev * (Number(client.commission_rate) || 0.10)
    const clientNet = netBeforeCommission - commission
    const cm = rev > 0 ? (grossProfit - fees - ship) / rev : null
    const beMer = cm && cm > 0 ? 1 / cm : null
    return { rev, spend, grossProfit, fees, ship, opex, commission, clientNet, cm, beMer }
  }, [cur, finance, client])

  function draftBody() {
    if (!cur || !prev || !client) return
    const c = cur.stats, p = prev.stats
    const be = Number(client.beroas)
    const newPct = cur.eco?.pctNewRev ?? null
    const repeatPct = cur.eco?.returningPct ?? (inputs.returning_pct ? Number(inputs.returning_pct) : null)
    const newestCohort = cohortRows[1] || cohortRows[0] // most recent complete-ish cohort
    const row = (m, a, b, t) => `${m}: ${a} (last: ${b}${t ? `, target/BE: ${t}` : ''})`
    const lines = [
      `MONTHLY REVIEW — ${client.name} — ${label(monthIso)}`,
      ``,
      `1) EXECUTIVE SUMMARY`,
      `[3–5 sentences. How it went, the one thing that mattered most, headline for next month.]`,
      ``,
      `2) SCOREBOARD VS TARGETS`,
      row('Spend', r0(c.spend), r0(p.spend), client.planned_daily_spend ? r0(client.planned_daily_spend * 30) + ' planned' : null),
      row('Revenue (store)', r0(c.revenue), r0(p.revenue), null),
      row('MER', fmt2(c.mer), fmt2(p.mer), `BE ${fmt2(be)}${client.target_roas ? ` / tgt ${fmt2(client.target_roas)}` : ''}`),
      cur.eco ? row('nMER (new-customer)', fmt2(cur.eco.nMer), fmt2(prev.eco?.nMer), `BE ${fmt2(be)}`) : `nMER: — (connect Shopify for the new/returning split)`,
      row('CPA', c.cpa ? '$' + c.cpa.toFixed(0) : '—', p.cpa ? '$' + p.cpa.toFixed(0) : '—', client.becpa ? `BE $${client.becpa}` : null),
      row('AOV', cur.aov ? '$' + cur.aov.toFixed(0) : '—', prev.aov ? '$' + prev.aov.toFixed(0) : '—', null),
      newPct !== null ? row('% new-customer revenue', p1(newPct), p1(prev.eco?.pctNewRev), null) : null,
      ``,
      `3) CLIENT P&L`,
      ...(pnl && !pnl.incomplete ? [
        `Gross profit: ${r0(pnl.grossProfit)} · fees ${r0(pnl.fees)} · shipping ${r0(pnl.ship)} · opex ${r0(pnl.opex)} · ad spend ${r0(pnl.spend)}`,
        `Your net after my commission (${((client.commission_rate || 0.1) * 100).toFixed(0)}%): ${r0(pnl.clientNet)} (${pnl.rev > 0 ? ((pnl.clientNet / pnl.rev) * 100).toFixed(1) + '% net margin' : '—'})${pnl.clientNet < 0 ? '  ⚠ negative — this is the number we fix first' : ''}`,
        `Contribution margin ${p1(pnl.cm * 100)} → true break-even MER ${fmt2(pnl.beMer)}${pnl.beMer && Math.abs(pnl.beMer - be) > 0.15 ? `  ⚠ differs from configured BEROAS ${fmt2(be)} — update thresholds` : ''}`,
      ] : ['[Enter weighted GPM + costs in the inputs panel to unlock the P&L section.]']),
      ``,
      `4) WHAT DROVE IT`,
      `[Cause and effect. Best ad and worst ad of the month, one sentence each on why.]`,
      ``,
      `5) WHAT WE LEARNED ABOUT YOUR BUYER`,
      inputs.buyer_insight || `[One insight minimum: which angle, product, or persona is pulling.]`,
      ``,
      `6) GROWTH SCORECARD`,
      `Ads — MER ${fmt2(c.mer)} vs BE ${fmt2(be)} ${trendArrow(c.mer, p.mer)}`,
      `Drops — ${inputs.events_done || 0}/${inputs.events_planned || 0} revenue events completed vs planned`,
      `List — ${inputs.list_size ? Number(inputs.list_size).toLocaleString() + ' contacts' : '—'}${inputs.list_rev_pct ? `, ${inputs.list_rev_pct}% of revenue` : ''}`,
      `Repeat — ${repeatPct !== null ? p1(repeatPct) + ' returning' : '—'}${newestCohort?.repeat_60d_pct !== undefined && newestCohort?.repeat_60d_pct !== null ? ` · ${label(newestCohort.cohort_month)} cohort: ${newestCohort.repeat_60d_pct}% repeated within 60d` : ''}`,
      `Catalog — ${inputs.new_skus || 0} new SKUs / restocks live`,
      ``,
      `7) ROADMAP CHECK`,
      `[Month 1 / 2–3 / 4–12 — on, ahead of, or behind pace, with the honest version.]`,
      ``,
      `8) NEXT MONTH + ONE ASK`,
      `[Tests going live, drops on the calendar, budget intention, and the one thing I need from you.]`,
    ].filter(l => l !== null)
    setBody(lines.join('\n'))
  }

  async function saveReview() {
    await supabase.from('monthly_reviews').upsert(
      { client_id: client.id, month: monthIso, body, payload: { finance, inputs } },
      { onConflict: 'client_id,month' }
    )
    setMsg('Review saved.')
  }
  async function copy() {
    await navigator.clipboard.writeText(body)
    setMsg('Copied — paste into your Loom doc or client thread.')
  }

  const monthOptions = [0, -1, -2, -3].map(o => monthStart(o))

  return (
    <>
      <h1>Monthly review</h1>
      <p className="sub">Summary first, details second, future last. Scoreboard and P&L prefill from synced data; the growth scorecard takes five numbers from you.</p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <select value={selected} onChange={e => setSelected(e.target.value)} style={{ maxWidth: 280 }}>
          {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={monthIso} onChange={e => setMonthIso(e.target.value)} style={{ maxWidth: 220 }}>
          {monthOptions.map(m => <option key={m} value={m}>{label(m)}</option>)}
        </select>
      </div>

      {cur && (
        <div className="grid2" style={{ marginBottom: 20 }}>
          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Profit inputs (9a — recalc when pricing changes)</h2>
            <label>Weighted GPM (0–1, e.g. 0.62)</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="number" step="0.01" min="0" max="1" value={finance.weighted_gpm} onChange={e => setFinance(f => ({ ...f, weighted_gpm: e.target.value }))} />
              <button type="button" className="btn ghost" style={{ whiteSpace: 'nowrap' }} onClick={computeGpm}>From catalog</button>
            </div>
            <div className="grid2">
              <div>
                <label>Fees % of revenue</label>
                <input type="number" step="0.005" value={finance.fees_pct} onChange={e => setFinance(f => ({ ...f, fees_pct: e.target.value }))} />
                <label>Avg ship cost / order ($)</label>
                <input type="number" step="0.5" value={finance.avg_ship_cost} onChange={e => setFinance(f => ({ ...f, avg_ship_cost: e.target.value }))} />
              </div>
              <div>
                <label>Client monthly opex ($)</label>
                <input type="number" step="10" value={finance.monthly_opex} onChange={e => setFinance(f => ({ ...f, monthly_opex: e.target.value }))} />
              </div>
            </div>
            {pnl && !pnl.incomplete && (
              <div style={{ marginTop: 12, fontFamily: 'var(--mono)', fontSize: 13 }}>
                Client net: <span style={{ color: pnl.clientNet >= 0 ? 'var(--green)' : 'var(--red)' }}>{r0(pnl.clientNet)}</span>
                {' · '}net margin {pnl.rev > 0 ? ((pnl.clientNet / pnl.rev) * 100).toFixed(1) + '%' : '—'}
                {' · '}true BE MER {fmt2(pnl.beMer)}
              </div>
            )}
          </div>

          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Growth scorecard inputs (Part 7)</h2>
            <div className="grid2">
              <div>
                <label>List size</label>
                <input type="number" value={inputs.list_size} onChange={e => setInputs(i => ({ ...i, list_size: e.target.value }))} />
                <label>Email/SMS % of revenue</label>
                <input type="number" step="0.5" value={inputs.list_rev_pct} onChange={e => setInputs(i => ({ ...i, list_rev_pct: e.target.value }))} />
                <label>New SKUs / restocks</label>
                <input type="number" value={inputs.new_skus} onChange={e => setInputs(i => ({ ...i, new_skus: e.target.value }))} />
              </div>
              <div>
                <label>Revenue events planned</label>
                <input type="number" value={inputs.events_planned} onChange={e => setInputs(i => ({ ...i, events_planned: e.target.value }))} />
                <label>Revenue events done</label>
                <input type="number" value={inputs.events_done} onChange={e => setInputs(i => ({ ...i, events_done: e.target.value }))} />
                <label>Returning % (manual, if no Shopify)</label>
                <input type="number" step="0.5" value={inputs.returning_pct} onChange={e => setInputs(i => ({ ...i, returning_pct: e.target.value }))} />
              </div>
            </div>
            <label>Buyer insight of the month</label>
            <input value={inputs.buyer_insight} onChange={e => setInputs(i => ({ ...i, buyer_insight: e.target.value }))} placeholder="Which angle, product, or persona is pulling" />
          </div>
        </div>
      )}

      {cohortRows.length > 0 && (
        <>
          <h2>Cohorts (60-day repeat — the LTV early-warning system)</h2>
          <div className="panel" style={{ padding: 0, overflowX: 'auto', marginBottom: 8 }}>
            <table>
              <thead><tr><th>Cohort</th><th>New customers</th><th>60d repeat</th><th>60d revenue</th><th>60d LTV</th><th>LTV : CAC</th></tr></thead>
              <tbody>
                {cohortRows.map(c => {
                  const ltv = c.new_customers > 0 ? Number(c.rev_60d) / c.new_customers : null
                  const isSelectedMonth = c.cohort_month === monthIso
                  const cac = isSelectedMonth ? cur?.eco?.ncpa ?? null : null
                  return (
                    <tr key={c.cohort_month}>
                      <td>{label(c.cohort_month)}</td>
                      <td>{c.new_customers}</td>
                      <td>{c.repeat_60d_pct !== null ? c.repeat_60d_pct + '%' : '—'}</td>
                      <td>{r0(c.rev_60d)}</td>
                      <td>{ltv !== null ? '$' + ltv.toFixed(0) : '—'}</td>
                      <td>{ltv !== null && cac ? (ltv / cac).toFixed(2) + 'x' : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="sub">60d LTV = cohort revenue in first 60 days ÷ new customers. LTV:CAC fills in for the selected month once its ad spend + new-customer counts are synced; recent cohorts' LTV keeps growing until their 60-day window closes.</p>
        </>
      )}

      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <button className="btn ghost" onClick={saveInputs}>Save inputs</button>
        <button className="btn" onClick={draftBody}>Draft the review</button>
        {msg && <span className="ok" style={{ margin: 'auto 0' }}>{msg}</span>}
      </div>

      {body && (
        <>
          <textarea className="report" value={body} onChange={e => setBody(e.target.value)} style={{ minHeight: 480 }} />
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button className="btn" onClick={copy}>Copy review</button>
            <button className="btn ghost" onClick={saveReview}>Save to history</button>
          </div>
        </>
      )}
    </>
  )
}
