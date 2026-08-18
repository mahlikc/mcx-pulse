// /api/shopify-sync — pulls daily revenue truth from each client's Shopify store
// using a per-client read-only Admin API token, and writes revenue_entries.
// Meta undercounts; this is the referee, fully automated.
//
//   GET /api/shopify-sync?secret=CRON_SECRET                -> sync yesterday
//   GET /api/shopify-sync?secret=CRON_SECRET&backfill=30    -> backfill N days (max 60)
//   GET /api/shopify-sync?secret=CRON_SECRET&cohorts=1      -> also recompute 60-day cohorts (last ~4 months)
//
// Per-client setup (client's Shopify admin, 3 minutes):
//   Settings → Apps and sales channels → Develop apps → Create app ("MCX Reporting")
//   → Configure Admin API scopes → check ONLY read_orders → Install → copy the
//   Admin API access token (shpat_...). Paste token + myshopify domain into Clients.

import { createClient } from '@supabase/supabase-js'

const API_VERSION = '2024-07'

// New Dev Dashboard apps (Jan 2026+) don't expose a static shpat_ token.
// Instead, exchange the app's Client ID + Client Secret for a short-lived
// access token (client credentials grant). Legacy shpat_ tokens still work.
async function resolveToken(domain, client) {
  if (client.shopify_token && client.shopify_token.trim()) return client.shopify_token.trim()
  if (client.shopify_client_id && client.shopify_client_secret) {
    const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: client.shopify_client_id.trim(),
        client_secret: client.shopify_client_secret.trim(),
        grant_type: 'client_credentials',
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json.access_token) {
      throw new Error(`Token exchange failed (is the app installed on this store?): ${JSON.stringify(json).slice(0, 160)}`)
    }
    return json.access_token
  }
  throw new Error('No Shopify credentials: add a legacy shpat_ token OR a Dev Dashboard Client ID + Secret')
}

function isoDaysAgo(n) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

async function fetchOrders(domain, token, createdMin, createdMax) {
  // Paginated pull of real orders in a window. read_orders scope only.
  let url =
    `https://${domain}/admin/api/${API_VERSION}/orders.json?status=any&limit=250` +
    `&created_at_min=${createdMin}T00:00:00Z&created_at_max=${createdMax}T23:59:59Z` +
    `&fields=id,created_at,total_price,current_total_price,financial_status,test,customer,line_items`
  const orders = []
  let guard = 0
  while (url && guard < 40) {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } })
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${(await res.text()).slice(0, 120)}`)
    const json = await res.json()
    orders.push(...(json.orders || []))
    const link = res.headers.get('link') || ''
    const next = link.split(',').find(p => p.includes('rel="next"'))
    url = next ? next.match(/<([^>]+)>/)?.[1] : null
    guard++
  }
  return orders.filter(o => !o.test && o.financial_status !== 'voided')
}

function orderRevenue(o) {
  return parseFloat(o.current_total_price ?? o.total_price) || 0
}

function isNewCustomer(o) {
  // orders_count on the order's customer object counts lifetime orders as of the
  // order; 1 = this was their first. Falls back to "new" when no customer attached.
  const n = o.customer?.orders_count
  return n === undefined || n === null ? true : Number(n) <= 1
}

function dailyRollup(orders) {
  const byDay = {}
  for (const o of orders) {
    const date = o.created_at.slice(0, 10)
    const d = (byDay[date] ||= {
      shopify_revenue: 0, orders: 0,
      new_orders: 0, new_revenue: 0,
      returning_orders: 0, returning_revenue: 0,
    })
    const rev = orderRevenue(o)
    d.shopify_revenue += rev
    d.orders += 1
    if (isNewCustomer(o)) { d.new_orders += 1; d.new_revenue += rev }
    else { d.returning_orders += 1; d.returning_revenue += rev }
  }
  return byDay
}

function skuRollup(orders) {
  // Aggregate line items into per-month, per-SKU units + revenue (the sales mix
  // that weighted GPM derives from). Key = line-item SKU code, else product title.
  const byMonthSku = {}
  for (const o of orders) {
    const month = o.created_at.slice(0, 7) + '-01'
    for (const li of o.line_items || []) {
      const key = (li.sku && li.sku.trim()) || (li.title && li.title.trim()) || 'unknown'
      const k = `${month}|${key}`
      const row = (byMonthSku[k] ||= { month, sku_key: key, units: 0, revenue: 0 })
      const qty = Number(li.quantity) || 0
      row.units += qty
      row.revenue += (parseFloat(li.price) || 0) * qty
    }
  }
  return Object.values(byMonthSku)
}

function monthStartOf(iso) {
  return iso.slice(0, 7) + '-01'
}

function computeCohorts(orders) {
  // Group last ~4 months of orders by customer; first order month = cohort;
  // repeat = 2nd order within 60 days; rev_60d = cohort revenue in first 60 days.
  const byCustomer = {}
  for (const o of orders) {
    const cid = o.customer?.id
    if (!cid) continue
    ;(byCustomer[cid] ||= []).push({ t: new Date(o.created_at), rev: orderRevenue(o) })
  }
  const cohorts = {}
  for (const list of Object.values(byCustomer)) {
    list.sort((a, b) => a.t - b.t)
    const first = list[0]
    const month = first.t.toISOString().slice(0, 7) + '-01'
    const c = (cohorts[month] ||= { new_customers: 0, repeaters: 0, rev_60d: 0 })
    c.new_customers += 1
    const cutoff = new Date(first.t.getTime() + 60 * 86400000)
    const within = list.filter(o => o.t <= cutoff)
    c.rev_60d += within.reduce((s, o) => s + o.rev, 0)
    if (within.length >= 2) c.repeaters += 1
  }
  return Object.entries(cohorts).map(([cohort_month, c]) => ({
    cohort_month,
    new_customers: c.new_customers,
    repeat_60d_pct: c.new_customers ? Number(((c.repeaters / c.new_customers) * 100).toFixed(1)) : null,
    rev_60d: Number(c.rev_60d.toFixed(2)),
  }))
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET
  const provided = req.query?.secret || (req.headers?.authorization || '').replace('Bearer ', '')
  if (!secret || provided !== secret) return res.status(401).json({ error: 'Unauthorized' })

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE)
  const backfill = Math.min(parseInt(req.query?.backfill) || 2, 60)
  const doCohorts = req.query?.cohorts === '1'
  const since = isoDaysAgo(backfill)
  const until = isoDaysAgo(0)

  const { data: allClients, error } = await supabase
    .from('clients')
    .select('id, name, shopify_domain, shopify_token, shopify_client_id, shopify_client_secret')
    .eq('active', true)
    .not('shopify_domain', 'is', null)
  if (error) return res.status(500).json({ error: error.message })
  const clients = (allClients || []).filter(
    c => (c.shopify_token && c.shopify_token.trim()) || (c.shopify_client_id && c.shopify_client_secret)
  )

  const results = []
  for (const client of clients) {
    try {
      const domain = client.shopify_domain.replace(/^https?:\/\//, '').replace(/\/.*/, '')
      const token = await resolveToken(domain, client)
      // Fetch from the start of the earliest touched month so per-month SKU
      // rollups are always complete, not partial-window fragments.
      const orders = await fetchOrders(domain, token, monthStartOf(since), until)
      const byDay = dailyRollup(orders.filter(o => o.created_at.slice(0, 10) >= since))
      const rows = Object.entries(byDay)
        .filter(([date]) => date < until) // today is partial; skip it
        .map(([date, d]) => ({
          client_id: client.id,
          date,
          shopify_revenue: Number(d.shopify_revenue.toFixed(2)),
          orders: d.orders,
          new_orders: d.new_orders,
          new_revenue: Number(d.new_revenue.toFixed(2)),
          returning_orders: d.returning_orders,
          returning_revenue: Number(d.returning_revenue.toFixed(2)),
          source: 'shopify',
        }))
      if (rows.length) {
        const { error: e1 } = await supabase
          .from('revenue_entries')
          .upsert(rows, { onConflict: 'client_id,date' })
        if (e1) throw new Error(e1.message)
      }

      // Sales mix per month per SKU (feeds weighted GPM)
      const mix = skuRollup(orders).map(r => ({
        ...r,
        revenue: Number(r.revenue.toFixed(2)),
        client_id: client.id,
        synced_at: new Date().toISOString(),
      }))
      if (mix.length) {
        const { error: eMix } = await supabase
          .from('sku_sales')
          .upsert(mix, { onConflict: 'client_id,month,sku_key' })
        if (eMix) throw new Error(eMix.message)
      }

      let cohortCount = 0
      if (doCohorts) {
        const wide = await fetchOrders(domain, token, isoDaysAgo(125), until)
        const cs = computeCohorts(wide).map(c => ({ ...c, client_id: client.id, computed_at: new Date().toISOString() }))
        if (cs.length) {
          const { error: e2 } = await supabase.from('cohorts').upsert(cs, { onConflict: 'client_id,cohort_month' })
          if (e2) throw new Error(e2.message)
          cohortCount = cs.length
        }
      }

      results.push({ client: client.name, days: rows.length, sku_rows: mix.length, cohorts: cohortCount, ok: true })
    } catch (err) {
      results.push({ client: client.name, ok: false, error: err.message })
      await supabase.from('alerts').insert({
        client_id: client.id,
        type: 'sync_error',
        message: `Shopify sync failed: ${err.message}`,
      })
    }
  }

  return res.status(200).json({ synced: results, range: { since, until }, cohorts: doCohorts })
}
