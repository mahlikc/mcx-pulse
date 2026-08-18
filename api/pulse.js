// /api/pulse?code=XXXX — public read endpoint for the client-facing pulse page.
// Clients don't have accounts; the access code on their link is the credential
// (same pattern as the Offer Engine client pages). This endpoint deliberately
// returns ONLY the 7-day smoothed view + status light. Never 1-day ROAS.

import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  const code = (req.query?.code || '').trim()
  if (!code || code.length < 8) return res.status(400).json({ error: 'Missing code' })

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE)

  const { data: client } = await supabase
    .from('clients')
    .select('id, name, beroas, pulse_note')
    .eq('pulse_code', code)
    .eq('active', true)
    .maybeSingle()
  if (!client) return res.status(404).json({ error: 'Not found' })

  const since = new Date()
  since.setUTCDate(since.getUTCDate() - 8)
  const sinceIso = since.toISOString().slice(0, 10)

  const [{ data: metrics }, { data: revenue }] = await Promise.all([
    supabase.from('daily_metrics').select('date, spend, meta_revenue, purchases')
      .eq('client_id', client.id).gte('date', sinceIso).order('date'),
    supabase.from('revenue_entries').select('date, shopify_revenue')
      .eq('client_id', client.id).gte('date', sinceIso).order('date'),
  ])

  const last7 = (metrics || []).slice(-7)
  const spend = last7.reduce((s, d) => s + Number(d.spend), 0)
  const metaRev = last7.reduce((s, d) => s + Number(d.meta_revenue), 0)
  const revMap = Object.fromEntries((revenue || []).map(r => [r.date, Number(r.shopify_revenue)]))
  const shopifyDays = last7.filter(d => revMap[d.date] !== undefined)
  const usingShopify = shopifyDays.length >= 4 // enough truth data to be the referee
  const rev = usingShopify
    ? last7.reduce((s, d) => s + (revMap[d.date] ?? Number(d.meta_revenue)), 0)
    : metaRev

  const mer = spend > 0 ? rev / spend : null
  const be = Number(client.beroas)
  let light = 'green'
  if (mer !== null) {
    if (mer < be) light = 'red'
    else if (mer < be * 1.1) light = 'yellow'
  }

  return res.status(200).json({
    name: client.name,
    window: '7-day rolling',
    spend: Math.round(spend),
    revenue: Math.round(rev),
    revenue_source: usingShopify ? 'store' : 'meta-attributed',
    mer: mer !== null ? Number(mer.toFixed(2)) : null,
    breakeven: be,
    light,
    note: client.pulse_note || 'Nothing needs action.',
    updated: last7.length ? last7[last7.length - 1].date : null,
  })
}
