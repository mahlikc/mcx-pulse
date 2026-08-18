import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const empty = {
  name: '', ad_account_id: '', beroas: '2.0', becpa: '', target_cpa: '', target_roas: '',
  planned_daily_spend: '', shopify_domain: '', shopify_token: '',
  report_email: '', report_phone: '', stock_flag: '', commission_rate: '0.10',
}

export default function Clients() {
  const [clients, setClients] = useState([])
  const [form, setForm] = useState(empty)
  const [editing, setEditing] = useState(null)
  const [msg, setMsg] = useState('')

  useEffect(() => { load() }, [])
  async function load() {
    const { data } = await supabase.from('clients').select('*').order('name')
    setClients(data || [])
  }

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function save(e) {
    e.preventDefault()
    const { data: userData } = await supabase.auth.getUser()
    const row = {
      name: form.name.trim(),
      ad_account_id: form.ad_account_id.replace(/^act_/, '').trim() || null,
      beroas: Number(form.beroas) || 2.0,
      becpa: form.becpa ? Number(form.becpa) : null,
      target_cpa: form.target_cpa ? Number(form.target_cpa) : null,
      planned_daily_spend: form.planned_daily_spend ? Number(form.planned_daily_spend) : null,
      target_roas: form.target_roas ? Number(form.target_roas) : null,
      shopify_domain: form.shopify_domain.trim() || null,
      shopify_token: form.shopify_token.trim() || null,
      report_email: form.report_email.trim() || null,
      report_phone: form.report_phone.trim() || null,
      stock_flag: form.stock_flag.trim() || null,
      commission_rate: form.commission_rate ? Number(form.commission_rate) : 0.10,
      user_id: userData.user.id,
    }
    if (editing) {
      await supabase.from('clients').update(row).eq('id', editing)
    } else {
      await supabase.from('clients').insert(row)
    }
    setForm(empty); setEditing(null); setMsg('Saved.')
    load()
  }

  function edit(c) {
    setEditing(c.id)
    setForm({
      name: c.name, ad_account_id: c.ad_account_id || '',
      beroas: String(c.beroas ?? '2.0'), becpa: c.becpa ?? '',
      target_cpa: c.target_cpa ?? '', target_roas: c.target_roas ?? '',
      planned_daily_spend: c.planned_daily_spend ?? '',
      shopify_domain: c.shopify_domain ?? '', shopify_token: c.shopify_token ?? '',
      report_email: c.report_email ?? '', report_phone: c.report_phone ?? '',
      stock_flag: c.stock_flag ?? '', commission_rate: c.commission_rate ?? '0.10',
    })
    window.scrollTo({ top: 0 })
  }

  async function toggleActive(c) {
    await supabase.from('clients').update({ active: !c.active }).eq('id', c.id)
    load()
  }

  return (
    <>
      <h1>Clients</h1>
      <p className="sub">Break-evens set here drive every light, stamp, and report. Ad account ID = the number in Ads Manager (with or without "act_").</p>

      <div className="panel" style={{ marginBottom: 28 }}>
        <form onSubmit={save}>
          <div className="grid2">
            <div>
              <label>Brand name</label>
              <input value={form.name} onChange={e => set('name', e.target.value)} required />
              <label>Meta ad account ID</label>
              <input value={form.ad_account_id} onChange={e => set('ad_account_id', e.target.value)} placeholder="1234567890" />
              <label>Planned daily spend ($, for pacing check)</label>
              <input type="number" step="1" value={form.planned_daily_spend} onChange={e => set('planned_daily_spend', e.target.value)} />
            </div>
            <div>
              <label>Break-even ROAS (floor → 🔴 below)</label>
              <input type="number" step="0.1" value={form.beroas} onChange={e => set('beroas', e.target.value)} required />
              <label>Target ROAS (goal → 🟢 at/above)</label>
              <input type="number" step="0.1" value={form.target_roas} onChange={e => set('target_roas', e.target.value)} />
              <label>Break-even CPA ($)</label>
              <input type="number" step="0.5" value={form.becpa} onChange={e => set('becpa', e.target.value)} />
              <label>Target CPA ($)</label>
              <input type="number" step="0.5" value={form.target_cpa} onChange={e => set('target_cpa', e.target.value)} />
            </div>
          </div>

          <h2>Shopify (revenue truth, automated)</h2>
          <div className="grid2">
            <div>
              <label>Store domain (brand.myshopify.com)</label>
              <input value={form.shopify_domain} onChange={e => set('shopify_domain', e.target.value)} placeholder="brand.myshopify.com" />
            </div>
            <div>
              <label>Admin API token (read_orders only)</label>
              <input type="password" value={form.shopify_token} onChange={e => set('shopify_token', e.target.value)} placeholder="shpat_…" autoComplete="off" />
            </div>
          </div>

          <h2>Delivery & flags</h2>
          <div className="grid2">
            <div>
              <label>Report email</label>
              <input type="email" value={form.report_email} onChange={e => set('report_email', e.target.value)} />
              <label>Report phone (+1…)</label>
              <input value={form.report_phone} onChange={e => set('report_phone', e.target.value)} placeholder="+14045551234" />
            </div>
            <div>
              <label>Stock flag (shows on scan; clear when restocked)</label>
              <input value={form.stock_flag} onChange={e => set('stock_flag', e.target.value)} placeholder="Hero tee ~2 wks stock" />
              <label>Your commission rate</label>
              <input type="number" step="0.01" value={form.commission_rate} onChange={e => set('commission_rate', e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn">{editing ? 'Save changes' : 'Add client'}</button>
            {editing && <button type="button" className="btn ghost" onClick={() => { setEditing(null); setForm(empty) }}>Cancel</button>}
            {msg && <span className="ok" style={{ margin: 'auto 0' }}>{msg}</span>}
          </div>
        </form>
      </div>

      <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Brand</th><th>Ad account</th><th>BEROAS</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {clients.map(c => (
              <tr key={c.id} style={{ opacity: c.active ? 1 : 0.45 }}>
                <td style={{ fontFamily: 'var(--display)', fontWeight: 700 }}>{c.name}</td>
                <td>{c.ad_account_id || '—'}</td>
                <td>{Number(c.beroas).toFixed(1)}</td>
                <td>{c.active ? 'Active' : 'Paused'}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn ghost" style={{ padding: '4px 10px', marginRight: 8 }} onClick={() => edit(c)}>Edit</button>
                  <button className="btn ghost" style={{ padding: '4px 10px' }} onClick={() => toggleActive(c)}>{c.active ? 'Pause' : 'Reactivate'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Sync</h2>
      <p className="sub">
        Meta syncs daily at 10:00 UTC, Shopify at 10:15, cohorts monthly. Manual pulls:
        {' '}<code style={{ fontFamily: 'var(--mono)' }}>/api/meta-sync?secret=…&backfill=30</code>
        {' '}and <code style={{ fontFamily: 'var(--mono)' }}>/api/shopify-sync?secret=…&backfill=30&cohorts=1</code>.
        Shopify token setup per client: their admin → Settings → Apps → Develop apps → new app with only
        the <strong>read_orders</strong> scope → install → copy the shpat_ token here.
      </p>
    </>
  )
}
