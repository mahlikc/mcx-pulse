import { useEffect, useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase, fmt$, fmt2, humanize } from '../lib/supabase'
import { verdict, decaySignals, growthSignals, windowStats, lastN, economics, actionPlan, funnelRead } from '../lib/signals'
import CatalogPanel from '../components/CatalogPanel'

function daysAgoIso(n) {
  const d = new Date(); d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}


function FunnelFlag({ flag, rank, total }) {
  const [idx, setIdx] = useState(0)
  const [outcome, setOutcome] = useState(null)
  const done = outcome !== null || idx >= flag.qna.length
  const verdictText = outcome !== null ? outcome : flag.allPass
  const badge = flag.urgent ? '🚨 URGENT' : rank === 0 ? 'PRIORITY' : `#${rank + 1}`
  return (
    <div className="panel" style={{ marginTop: 8, borderColor: flag.urgent ? 'var(--red)' : rank === 0 ? 'var(--amber)' : 'var(--line)' }}>
      <div className="flag" style={{ borderBottom: 'none', paddingBottom: 4 }}>
        <span className="tag" style={{ color: flag.urgent ? 'var(--red)' : rank === 0 ? 'var(--amber)' : undefined }}>{badge} · {flag.stage}</span>
        <span>
          <strong>{flag.text}</strong>
          {flag.est > 0.5 && <span style={{ color: 'var(--dim)' }}> ~{Math.round(flag.est)} more purchases/wk recoverable.</span>}
        </span>
      </div>
      {!done && (
        <div style={{ paddingLeft: 12, marginTop: 6 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--faint)', marginBottom: 6 }}>
            DIAGNOSE · {idx + 1} of {flag.qna.length}
          </div>
          <div style={{ marginBottom: 10 }}>{flag.qna[idx].q}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn ghost" style={{ padding: '5px 16px' }} onClick={() => setIdx(i => i + 1)}>Yes</button>
            <button className="btn ghost" style={{ padding: '5px 16px' }} onClick={() => setOutcome(flag.qna[idx].ifNo)}>No</button>
          </div>
        </div>
      )}
      {done && (
        <div style={{ paddingLeft: 12, marginTop: 6 }}>
          <div className="flag growth" style={{ borderBottom: 'none' }}>
            <span className="tag" style={{ color: 'var(--text)' }}>{outcome !== null ? 'Fix' : 'All pass'}</span>
            <span>{verdictText}</span>
          </div>
          <button className="btn ghost" style={{ padding: '3px 12px', fontSize: 11, marginTop: 4 }} onClick={() => { setIdx(0); setOutcome(null) }}>Start over</button>
        </div>
      )}
    </div>
  )
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
        <div className="panel tile">
          <div className="bignum">{fmt2(w7.mer)}</div>
          <div className="tlabel">7d MER {w7.revenueSource === 'store' ? '· store revenue' : '· meta revenue'}</div>
          {(() => {
            const w7days = lastN(days, 7)
            const metaRev = w7days.reduce((s, d) => s + Number(d.meta_revenue), 0)
            const roas = w7.spend > 0 ? metaRev / w7.spend : null
            return <div className="tsub">Meta ROAS {fmt2(roas)} · attributed, reference only</div>
          })()}
        </div>
        <div className="panel tile"><div className="bignum">{fmt$(w7.spend)}</div><div className="tlabel">7d spend</div></div>
        <div className="panel tile"><div className="bignum">{fmt$(w7.revenue)}</div><div className="tlabel">7d revenue</div></div>
        <div className="panel tile"><div className="bignum">{fmt$(w7.cpa)}</div><div className="tlabel">7d CPA{client.target_cpa ? ` · target ${fmt$(client.target_cpa)}` : ''}</div></div>
      </div>

      {eco && (
        <>
          <h2>Customer economics (7d, from Shopify)</h2>
          <div className="grid4">
            <div className="panel tile"><div className="bignum">{fmt2(eco.nMer)}</div><div className="tlabel">nMER · new customers · BE {fmt2(client.beroas)}</div></div>
            <div className="panel tile"><div className="bignum">{fmt$(eco.ncpa)}</div><div className="tlabel">Cost per new customer</div></div>
            <div className="panel tile"><div className="bignum">{eco.pctNewRev !== null ? eco.pctNewRev.toFixed(0) + '%' : '—'}</div><div className="tlabel">New-customer revenue share</div></div>
            <div className="panel tile"><div className="bignum">{fmt$(eco.naov)}<small> / {fmt$(eco.raov)}</small></div><div className="tlabel">nAOV / rAOV</div></div>
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

      {(() => {
        const f = funnelRead(days)
        const s = f.stages
        const pct = r => (r === null ? '—' : (r * 100).toFixed(1) + '%')
        const stageTiles = [
          [s.topLabel, s.topCur, null],
          ['Added to cart', s.cur.atc, s.topToAtc],
          ['Reached checkout', s.cur.ic, s.atcToIc],
          ['Purchased', s.cur.pur, s.icToPur],
        ]
        return (
          <>
            <h2>Funnel — paid traffic (7d, Meta events)</h2>
            <div className="grid4">
              {stageTiles.map(([label, count, r], i) => (
                <div key={i} className="panel tile">
                  <div className="bignum">{count}</div>
                  <div className="tlabel">{label}</div>
                  {r !== null && <div className="tsub">{pct(r)} of previous stage</div>}
                </div>
              ))}
            </div>
            {f.thin && <p className="sub" style={{ marginTop: 8 }}>Under 50 top-of-funnel events this week — rates too thin to judge yet.</p>}
            {!f.thin && f.flags.length === 0 && <p className="sub" style={{ marginTop: 8 }}>No stage below healthy range. Funnel isn't the constraint this week.</p>}
            {f.flags.map((fl, i) => <FunnelFlag key={fl.stage + i} flag={fl} rank={i} total={f.flags.length} />)}
            <p className="sub" style={{ marginTop: 6 }}>Meta-attributed events only (the paid funnel you control) — counts won't match Shopify's all-traffic chart, but the leak diagnosis is the same.</p>
          </>
        )
      })()}

      <h2>This week's moves</h2>
      <div className="panel" style={{ borderColor: 'var(--faint)' }}>
        {actionPlan(client, v, decay, growth, ads).map((m, i) => (
          <div key={i} className="flag growth">
            <span className="tag" style={{ color: 'var(--text)' }}>{i + 1}. {humanize(m.tag)}</span>
            {m.text}
          </div>
        ))}
      </div>

      {ads.length > 0 && (() => {
        const byAd = {}
        for (const r of ads) {
          const a = (byAd[r.ad_id] ||= { name: r.ad_name, spend: 0, purchases: 0, fr: [], ctr: [] })
          a.spend += Number(r.spend) || 0
          a.purchases += Number(r.purchases) || 0
          if (r.frequency) a.fr.push(Number(r.frequency))
          if (r.link_ctr) a.ctr.push(Number(r.link_ctr))
        }
        const rows = Object.values(byAd).sort((a, b) => b.spend - a.spend).slice(0, 8)
        const avg = arr => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null)
        return (
          <>
            <h2>Top ads — last 7 days (the receipts)</h2>
            <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
              <table>
                <thead><tr><th>Ad</th><th>Spend</th><th>Purch</th><th>CPA</th><th>Freq</th><th>CTR</th></tr></thead>
                <tbody>
                  {rows.map((a, i) => (
                    <tr key={i}>
                      <td style={{ fontFamily: 'var(--display)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</td>
                      <td>{fmt$(a.spend)}</td>
                      <td>{a.purchases}</td>
                      <td>{a.purchases > 0 ? fmt$(a.spend / a.purchases) : '—'}</td>
                      <td>{avg(a.fr) ? avg(a.fr).toFixed(1) : '—'}</td>
                      <td>{avg(a.ctr) ? avg(a.ctr).toFixed(2) + '%' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      })()}

      {(decay.length > 0 || growth.length > 0) && (
        <>
          <h2>Signals</h2>
          <div className="panel">
            {growth.map((s, i) => <div key={'g' + i} className="flag growth"><span className="tag">Growth</span>{s.text}</div>)}
            {decay.map((s, i) => <div key={'d' + i} className="flag"><span className="tag">{humanize(s.type)}</span>{s.text}</div>)}
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
            <input type="number" step="0.01" min="0" value={revAmount} onChange={e => setRevAmount(e.target.value)} />
            <button className="btn" style={{ marginTop: 14 }}>Save revenue</button>
          </form>
        </div>

        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Client pulse page</h2>
          <p className="sub">Daily visibility, not daily judgment. 7-day MER + status light, never 1-day ROAS.</p>
          <label>Share link</label>
          <input readOnly value={pulseUrl} onFocus={e => e.target.select()} />
          <label>Pulse note (the mandatory second line)</label>
          <input value={note} onChange={e => setNote(e.target.value)} />
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
