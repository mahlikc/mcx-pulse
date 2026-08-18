import { useEffect, useMemo, useState } from 'react'
import { supabase, fmt2 } from '../lib/supabase'
import { skuMargin, simpleGpm, weightedGpm, breakevens } from '../lib/margins'

const emptyRow = { name: '', sku_code: '', price: '', cogs: '' }
const pct = n => (n === null || n === undefined ? '—' : (n * 100).toFixed(0) + '%')

function lastFullMonth() {
  const d = new Date()
  d.setDate(1); d.setMonth(d.getMonth() - 1)
  return d.toISOString().slice(0, 10)
}

// SKU catalog intake + margin math for one client. Used on the client page.
// onBeroas(suggested) lets the parent refresh after applying thresholds.
export default function CatalogPanel({ client, aov, onApplied }) {
  const [skus, setSkus] = useState([])
  const [sales, setSales] = useState([])
  const [row, setRow] = useState(emptyRow)
  const [msg, setMsg] = useState('')
  const month = lastFullMonth()

  useEffect(() => { load() }, [client.id])

  async function load() {
    const [{ data: s }, { data: ss }] = await Promise.all([
      supabase.from('skus').select('*').eq('client_id', client.id).order('created_at'),
      supabase.from('sku_sales').select('*').eq('client_id', client.id).eq('month', month),
    ])
    setSkus(s || []); setSales(ss || [])
  }

  async function addSku(e) {
    e.preventDefault()
    if (!row.name || !row.price || row.cogs === '') return
    await supabase.from('skus').insert({
      client_id: client.id,
      name: row.name.trim(),
      sku_code: row.sku_code.trim() || null,
      price: Number(row.price),
      cogs: Number(row.cogs),
    })
    setRow(emptyRow); setMsg('')
    load()
  }

  async function updateField(id, field, value) {
    await supabase.from('skus').update({ [field]: value === '' ? null : Number(value) }).eq('id', id)
    setSkus(ks => ks.map(k => (k.id === id ? { ...k, [field]: value } : k)))
  }

  async function removeSku(id) {
    await supabase.from('skus').delete().eq('id', id)
    setSkus(ks => ks.filter(k => k.id !== id))
  }

  const weighted = useMemo(() => weightedGpm(skus, sales), [skus, sales])
  const fallback = useMemo(() => simpleGpm(skus), [skus])
  const gpm = weighted.gpm ?? fallback
  const be = useMemo(() => breakevens({ gpm, aov: aov || null }), [gpm, aov])

  async function applyThresholds() {
    if (!be?.beroas) return
    const updates = { beroas: Number(be.beroas.toFixed(2)) }
    if (be.becpa) updates.becpa = Number(be.becpa.toFixed(0))
    await supabase.from('clients').update(updates).eq('id', client.id)
    await supabase.from('client_finance').upsert(
      { client_id: client.id, month, weighted_gpm: Number(gpm.toFixed(3)) },
      { onConflict: 'client_id,month' }
    )
    setMsg(`Applied — BEROAS ${be.beroas.toFixed(2)}${be.becpa ? `, BECPA $${be.becpa.toFixed(0)}` : ''}. Lights and verdicts now use it.`)
    onApplied?.()
  }

  return (
    <div className="panel" style={{ marginTop: 28 }}>
      <h2 style={{ marginTop: 0 }}>Catalog — SKUs, price & COGS (the intake)</h2>
      <p className="sub">
        Add every SKU once. {sales.length
          ? 'Weighted GPM below uses last month\u2019s real Shopify sales mix — it recalcs itself as the mix moves.'
          : 'No Shopify sales mix yet, so GPM is a simple average across SKUs; it upgrades to sales-weighted automatically once orders sync.'}
      </p>

      {skus.length > 0 && (
        <div style={{ overflowX: 'auto', marginBottom: 14 }}>
          <table>
            <thead><tr><th>SKU</th><th>Code</th><th>Price</th><th>COGS</th><th>Margin</th><th></th></tr></thead>
            <tbody>
              {skus.map(s => (
                <tr key={s.id}>
                  <td style={{ fontFamily: 'var(--display)' }}>{s.name}</td>
                  <td>{s.sku_code || '—'}</td>
                  <td><input type="number" step="0.01" value={s.price} style={{ width: 90, padding: '4px 6px' }} onChange={e => updateField(s.id, 'price', e.target.value)} /></td>
                  <td><input type="number" step="0.01" value={s.cogs} style={{ width: 90, padding: '4px 6px' }} onChange={e => updateField(s.id, 'cogs', e.target.value)} /></td>
                  <td>{pct(skuMargin(s))}</td>
                  <td><button className="btn ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => removeSku(s.id)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form onSubmit={addSku} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: 10, alignItems: 'end' }}>
        <div><label>Product name</label><input value={row.name} onChange={e => setRow(r => ({ ...r, name: e.target.value }))} /></div>
        <div><label>SKU code (matches Shopify)</label><input value={row.sku_code} onChange={e => setRow(r => ({ ...r, sku_code: e.target.value }))} /></div>
        <div><label>Price ($)</label><input type="number" step="0.01" min="0" value={row.price} onChange={e => setRow(r => ({ ...r, price: e.target.value }))} /></div>
        <div><label>COGS ($)</label><input type="number" step="0.01" min="0" value={row.cogs} onChange={e => setRow(r => ({ ...r, cogs: e.target.value }))} /></div>
        <button className="btn ghost">Add SKU</button>
      </form>

      {gpm !== null && (
        <div style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 14, fontFamily: 'var(--mono)', fontSize: 13 }}>
          <div>
            {weighted.gpm !== null
              ? <>Weighted GPM (sales mix, {month.slice(0, 7)}): <strong>{pct(weighted.gpm)}</strong> · {pct(weighted.coverage)} of revenue matched</>
              : <>Avg GPM (unweighted): <strong>{pct(fallback)}</strong></>}
            {be?.beroas ? <> → suggested BEROAS <strong>{fmt2(be.beroas)}</strong>{be.becpa ? <> · BECPA <strong>${be.becpa.toFixed(0)}</strong></> : null}</> : null}
          </div>
          {weighted.unmatched?.length > 0 && (
            <div style={{ color: 'var(--amber)', marginTop: 6 }}>
              Unmatched revenue: {weighted.unmatched.map(u => u.key).join(', ')} — add these SKUs (or set their codes) to tighten the number.
            </div>
          )}
          {be?.beroas && Math.abs(be.beroas - Number(client.beroas)) > 0.15 && (
            <div style={{ color: 'var(--amber)', marginTop: 6 }}>
              Configured BEROAS is {fmt2(client.beroas)} — drifted from the catalog's {fmt2(be.beroas)}. Stale threshold = every light quietly wrong.
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            <button className="btn" onClick={applyThresholds} disabled={!be?.beroas}>Apply as BEROAS{be?.becpa ? ' + BECPA' : ''}</button>
            {msg && <span className="ok" style={{ marginLeft: 12 }}>{msg}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
