import { useEffect, useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase, fmt$, fmt2 } from '../lib/supabase'
import { verdict, decaySignals, growthSignals, windowStats, lastN, economics } from '../lib/signals'
import CatalogPanel from '../components/CatalogPanel'

function daysAgoIso(n) {
  const d = new Date(); d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

export default function ClientDetail() {
  const { id } = useParams()
  const [client, setClient] = useState(null)
  const [days, setDays] = useState([])
  const [ads, setAds] = useState([])
  const [revRows, setRevRows] = useState([])
  const [revDate, setRevDate] = useState(daysAgoIso(1))
  const [revAmount, setRevAmount] = useState('')
  const [note, setNote] = useState('')
  const [saved, setSaved] = useState('')

  useEffect(() => { load() }, [id])

  async function load() {
    const [{ data: c }, { data: dm }, { data: am }, { data: re }] = await Promise.all([
      supabase.from('clients').select('*').eq('id', id).single(),
      supabase.from('daily_metrics').select('*').eq('client_id', id).gte('date', daysAgoIso(35)).order('date'),
      supabase.from('ad_metrics').select('*').eq('client_id', id).gte('date', daysAgoIso(8)).order('date'),
      supabase.from('revenue_entries').select('*').eq('client_id', id).gte('date', daysAgoIso(35)),
    ])
    setClient(c); setDays(dm || []); setAds(am || []); setRevRows(re || [])
    setNote(c?.pulse_note || '')
  }

  const revMap = useMemo(
    () => Object.fromEntries(revRows.map(r => [r.date, Number(r.shopify_revenue)])),
    [revRows]
  )
  const v = useMemo(() => (client ? verdict(client, days, ads, revMap) : null), [client, days, ads, revMap])
  const eco = useMemo(() => {
    const w7dates = new Set(lastN(days, 7).map(d => d.date))
    return economics(lastN(days, 7), revRows.filter(r => w7dates.has(r.date)))
  }, [days, revRows])
  const decay = useMemo(() => decaySignals(days, ads, revMap), [days, ads, revMap])
  const growth = useMemo(() => growthSignals(days, revMap), [days, revMap])

  async function saveRevenue(e) {
    e.preventDefault()
    if (!revAmount) return
    await supabase.from('revenue_entries').upsert(
      { client_id: id, date: revDate, shopify_revenue: Number(revAmount) },
      { onConflict: 'client_id,date' }
    )
    setRevAmount(''); setSaved('Revenue saved.')
    load()
  }

  async function savePulseNote() {
    await supabase.from('clients').update({ pulse_note: note }).eq('id', id)
    setSaved('Pulse note updated.')
  }

  if (!client || !v) return null

  const w7 = v.w7
  const prev7 = windowStats(lastN(days, 7, 7), revMap)
  const pulseUrl = `${window.location.origin}/p/${client.pulse_code}`

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div className={`light ${v.light}`} />
        <h1 style={{ marginBottom: 0 }}>{client.name}</h1>
        <div className={`stamp ${v.call.replace(/[^A-Z]/g, '')}`} style={{ marginLeft: 'auto' }}>{v.call}</div>
      </div>
      <p className="sub">Break-even ROAS {fmt2(client.beroas)}{client.becpa ? ` · BE CPA ${fmt$(client.becpa)}` : ''}</p>

      <div className="grid4">
        <div className="panel">
          <div className="bignum">{fmt2(w7.mer)}</div>
          <div className="metric"><div className="k">7d MER {w7.revenueSource === 'store' ? '(store rev)' : '(meta rev)'}</div></div>
          {(() => {
            const w7days = lastN(days, 7)
            const metaRev = w7days.reduce((s, d) => s + Number(d.meta_revenue), 0)
            const roas = w7.spend > 0 ? metaRev / w7.spend : null
            return <div className="metric" style={{ textAlign: 'left', marginTop: 6 }}><div className="k">Meta ROAS {fmt2(roas)} (attributed — reference only)</div></div>
          })()}
        </div>
        <div className="panel"><div className="bignum">{fmt$(w7.spend)}</div><div className="metric"><div className="k">7d spend</div></div></div>
        <div className="panel"><div className="bignum">{fmt$(w7.revenue)}</div><div className="metric"><div className="k">7d revenue</div></div></div>
        <div className="panel"><div className="bignum">{fmt$(w7.cpa)}</div><div className="metric"><div className="k">7d CPA{client.target_cpa ? ` / tgt ${fmt$(client.target_cpa)}` : ''}</div></div></div>
      </div>

      {eco && (
        <>
          <h2>Customer economics (7d, from Shopify)</h2>
          <div className="grid4">
            <div className="panel"><div className="bignum">{fmt2(eco.nMer)}</div><div className="metric"><div className="k">nMER (new-customer) / BE {fmt2(client.beroas)}</div></div></div>
            <div className="panel"><div className="bignum">{fmt$(eco.ncpa)}</div><div className="metric"><div className="k">Cost per new customer</div></div></div>
            <div className="panel"><div className="bignum">{eco.pctNewRev !== null ? eco.pctNewRev.toFixed(0) + '%' : '—'}</div><div className="metric"><div className="k">% new-customer revenue</div></div></div>
            <div className="panel"><div className="bignum">{fmt$(eco.naov)}<small> / {fmt$(eco.raov)}</small></div><div className="metric"><div className="k">nAOV / rAOV</div></div></div>
          </div>
          {v.w7.mer !== null && eco.nMer !== null && v.w7.mer >= client.beroas && eco.nMer < client.beroas && (
            <div className="panel" style={{ marginTop: 10, borderColor: 'var(--amber)' }}>
              <div className="flag"><span className="tag">nMER</span>Blended looks fine but new-customer MER is below break-even — repeat orders are hiding an unprofitable acquisition engine. Fix CPA or AOV before scaling.</div>
            </div>
          )}
        </>
      )}

      <h2>The call, per the playbook</h2>
      <div className="panel">
        {v.reasons.map((r, i) => <div key={i} className="flag"><span className="tag">rule</span>{r}</div>)}
      </div>

      {(decay.length > 0 || growth.length > 0) && (
        <>
          <h2>Signals</h2>
          <div className="panel">
            {growth.map((s, i) => <div key={'g' + i} className="flag growth"><span className="tag">growth</span>{s.text}</div>)}
            {decay.map((s, i) => <div key={'d' + i} className="flag"><span className="tag">{s.type}</span>{s.text}</div>)}
          </div>
        </>
      )}

      <h2>Last 14 days</h2>
      <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr><th>Date</th><th>Spend</th><th>Purch</th><th>Meta rev</th><th>Store rev</th><th>Freq</th><th>CPM</th></tr>
          </thead>
          <tbody>
            {lastN(days, 14).slice().reverse().map(d => (
              <tr key={d.date}>
                <td>{d.date.slice(5)}</td>
                <td>{fmt$(d.spend)}</td>
                <td>{d.purchases}</td>
                <td>{fmt$(d.meta_revenue)}</td>
                <td>{revMap[d.date] !== undefined ? fmt$(revMap[d.date]) : '—'}</td>
                <td>{d.frequency ? Number(d.frequency).toFixed(1) : '—'}</td>
                <td>{d.cpm ? fmt$(d.cpm) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid2" style={{ marginTop: 28 }}>
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Store revenue (truth)</h2>
          <p className="sub">
            {client.shopify_domain
              ? 'Shopify is connected — revenue syncs automatically every morning. Manual entry below only overrides a day if needed.'
              : 'Meta undercounts. Shopify is truth. MER is the referee. Connect Shopify on the Clients page to automate this, or enter it manually (10 seconds a day).'}
          </p>
          <form onSubmit={saveRevenue}>
            <label>Date</label>
            <input type="date" value={revDate} onChange={e => setRevDate(e.target.value)} />
            <label>Total store revenue that day</label>
            <input type="number" step="0.01" min="0" placeholder="0.00" value={revAmount} onChange={e => setRevAmount(e.target.value)} />
            <button className="btn" style={{ marginTop: 14 }}>Save revenue</button>
          </form>
        </div>

        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Client pulse page</h2>
          <p className="sub">Daily visibility, not daily judgment. 7-day MER + status light, never 1-day ROAS.</p>
          <label>Share link</label>
          <input readOnly value={pulseUrl} onFocus={e => e.target.select()} />
          <label>Pulse note (the mandatory second line)</label>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="Nothing needs action — new tests reading by Thursday." />
          <button className="btn ghost" style={{ marginTop: 14 }} onClick={savePulseNote}>Update note</button>
        </div>
      </div>
      {saved && <div className="ok">{saved}</div>}

      {(() => {
        const withOrders = revRows.filter(r => Number(r.orders) > 0)
        const rev30 = withOrders.reduce((s, r) => s + Number(r.shopify_revenue), 0)
        const ord30 = withOrders.reduce((s, r) => s + Number(r.orders), 0)
        const aov = ord30 > 0 ? rev30 / ord30 : null
        return <CatalogPanel client={client} aov={aov} onApplied={load} />
      })()}

      <p style={{ marginTop: 24 }}><Link to="/" className="sub">← Back to scan</Link></p>
    </>
  )
}
