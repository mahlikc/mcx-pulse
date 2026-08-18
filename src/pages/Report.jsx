import { useEffect, useMemo, useState } from 'react'
import { supabase, fmt2, mondayOf } from '../lib/supabase'
import { windowStats, decaySignals, verdict } from '../lib/signals'

function daysAgoIso(n) {
  const d = new Date(); d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

const LIGHTS = { green: '\u{1F7E2} On track', yellow: '\u{1F7E1} Watching something', red: '\u{1F534} Action needed' }

export default function Report() {
  const [clients, setClients] = useState([])
  const [selected, setSelected] = useState('')
  const [body, setBody] = useState('')
  const [light, setLight] = useState('green')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    supabase.from('clients').select('*').eq('active', true).order('name')
      .then(({ data }) => { setClients(data || []); if (data?.length) setSelected(data[0].id) })
  }, [])

  const client = useMemo(() => clients.find(c => c.id === selected), [clients, selected])

  useEffect(() => { if (client) draft() }, [selected])

  async function draft() {
    const [{ data: dm }, { data: am }, { data: re }] = await Promise.all([
      supabase.from('daily_metrics').select('*').eq('client_id', client.id).gte('date', daysAgoIso(15)).order('date'),
      supabase.from('ad_metrics').select('*').eq('client_id', client.id).gte('date', daysAgoIso(8)).order('date'),
      supabase.from('revenue_entries').select('*').eq('client_id', client.id).gte('date', daysAgoIso(15)),
    ])
    const days = dm || []
    const revMap = Object.fromEntries((re || []).map(r => [r.date, Number(r.shopify_revenue)]))
    const w7 = windowStats(days.slice(-7), revMap)
    const v = verdict(client, days, am || [], revMap)
    const flags = decaySignals(days, am || [], revMap)
    setLight(v.light)

    const weekOf = mondayOf()
    const roas = w7.spend > 0 ? (days.slice(-7).reduce((s, d) => s + Number(d.meta_revenue), 0) / w7.spend) : null
    const lines = [
      `WEEK OF ${weekOf} \u2014 ${client.name}`,
      ``,
      `Spend: $${Math.round(w7.spend).toLocaleString()}`,
      `Revenue (attributed): $${Math.round(w7.revenue).toLocaleString()}${w7.revenueSource === 'store' ? ' (store)' : ' (Meta)'}`,
      `ROAS: ${roas ? roas.toFixed(2) : '\u2014'} | MER: ${w7.mer ? w7.mer.toFixed(2) : '\u2014'} (break-even: ${Number(client.beroas).toFixed(1)})`,
      `CPA: ${w7.cpa ? '$' + w7.cpa.toFixed(0) : '\u2014'}${client.target_cpa ? ` (target: $${client.target_cpa})` : ''}`,
      ``,
      `WHAT HAPPENED: ${flags.length ? flags[0].text : '[1\u20132 sentences \u2014 what we tested, what won/lost.]'}`,
      `WHAT'S NEXT: [1\u20132 sentences \u2014 what goes live this week and why.]`,
      `STATUS: ${LIGHTS[v.light]}`,
    ]
    setBody(lines.join('\n'))
    setMsg('')
  }

  async function save() {
    await supabase.from('reports').upsert(
      { client_id: client.id, week_of: mondayOf(), body, status_light: light },
      { onConflict: 'client_id,week_of' }
    )
    setMsg('Report saved for this week.')
  }

  async function copy() {
    await navigator.clipboard.writeText(body)
    setMsg('Copied — paste it into the client thread.')
  }

  async function send(channel) {
    setMsg('Sending…')
    const { data: sess } = await supabase.auth.getSession()
    const res = await fetch('/api/send-report', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sess.session.access_token}`,
      },
      body: JSON.stringify({
        client_id: client.id,
        body,
        subject: `Weekly report — ${client.name} — week of ${mondayOf()}`,
        channel,
      }),
    })
    const json = await res.json()
    if (json.sent?.length) {
      setMsg(`Sent: ${json.sent.join(', ')}`)
      await supabase.from('reports').upsert(
        { client_id: client.id, week_of: mondayOf(), body, status_light: light, sent_at: new Date().toISOString() },
        { onConflict: 'client_id,week_of' }
      )
    } else {
      setMsg(json.errors?.join(' · ') || 'Send failed.')
    }
  }

  return (
    <>
      <h1>Weekly report</h1>
      <p className="sub">Same format, every Monday, especially in bad weeks. Numbers prefill from the last 7 days — you write the two sentences.</p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <select value={selected} onChange={e => setSelected(e.target.value)} style={{ maxWidth: 280 }}>
          {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={light} onChange={e => setLight(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="green">{'\u{1F7E2}'} On track</option>
          <option value="yellow">{'\u{1F7E1}'} Watching something</option>
          <option value="red">{'\u{1F534}'} Action needed</option>
        </select>
      </div>

      {client && (
        <>
          <textarea className="report" value={body} onChange={e => setBody(e.target.value)} />
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button className="btn" onClick={copy}>Copy report</button>
            <button className="btn ghost" onClick={save}>Save to history</button>
            <button className="btn ghost" onClick={draft}>Re-draft from data</button>
            {client?.report_email && <button className="btn ghost" onClick={() => send('email')}>Send email</button>}
            {client?.report_phone && <button className="btn ghost" onClick={() => send('sms')}>Send SMS</button>}
            {msg && <span className="ok" style={{ margin: 'auto 0' }}>{msg}</span>}
          </div>
        </>
      )}
    </>
  )
}
