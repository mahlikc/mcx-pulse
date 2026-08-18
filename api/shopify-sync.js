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

async function ccgPost(domain, body) {
  return fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    redirect: 'manual', // surface alias-domain redirects instead of mangling the POST
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
  })
}

// New Dev Dashboard apps (Jan 2026+) don't expose a static shpat_ token.
// Instead, exchange the app's Client ID + Client Secret for a short-lived
// access token (client credentials grant). Legacy shpat_ tokens still work.
async function resolveToken(domain, client) {
  if (client.shopify_token && client.shopify_token.trim()) return client.shopify_token.trim()
  if (client.shopify_client_id && client.shopify_client_secret) {
    const body = JSON.stringify({
      client_id: client.shopify_client_id.trim(),
      client_secret: client.shopify_client_secret.trim(),
      grant_type: 'client_credentials',
    })
    let usedDomain = domain
    let res = await ccgPost(usedDomain, body)
    // Alias myshopify domains 301 to the canonical handle — follow it once.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || ''
      const m = loc.match(/^https?:\/\/([^/]+)/)
      if (m && m[1] !== usedDomain) {
        usedDomain = m[1]
        res = await ccgPost(usedDomain, body)
      }
    }
    const text = await res.text()
    let json = {}
    try { json = JSON.parse(text) } catch {}
    if (!res.ok || !json.access_token) {
      throw new Error(
        `Token exchange failed [HTTP ${res.status}] on ${usedDomain}: ${text.slice(0, 160) || '(empty response body)'}`
      )
    }
    return json.access_token
  }
  throw new Error('No Shopify credentials: add a legacy shpat_ token OR a Dev Dashboard Client ID + Secret')
}

async function getShopTimezone(domain, token) {
  const res = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `{ shop { ianaTimezone } }` }),
  })
  const json = await res.json().catch(() => ({}))
  return json?.data?.shop?.ianaTimezone || 'UTC'
}

// Convert an ISO timestamp to YYYY-MM-DD in the store's timezone, so daily
// buckets match what the merchant sees in Shopify Analytics (evening orders
// were previously spilling into the next UTC day).
function localDate(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(iso))
  } catch {
    return String(iso).slice(0, 10)
  }
}

function isoDaysAgo(n) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

async function fetchOrders(domain, token, createdMin, createdMax) {
  // GraphQL Admin API: REST order payloads no longer include the customer's
  // orders_count, which broke new-vs-returning classification. GraphQL still
  // exposes customer.numberOfOrders. Returns orders mapped to the shape the
  // rollup helpers expect.
  const gql = `query($cursor: String, $q: String!) {
    orders(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id createdAt test displayFinancialStatus
        currentTotalPriceSet { shopMoney { amount } }
        customer { id numberOfOrders }
        lineItems(first: 100) {
          nodes { sku title quantity originalUnitPriceSet { shopMoney { amount } } }
        }
      }
    }
  }`
  const q = `created_at:>='${createdMin}T00:00:00Z' created_at:<='${createdMax}T23:59:59Z'`
  const orders = []
  let cursor = null
  let guard = 0
  while (guard < 60) {
    const res = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: gql, variables: { cursor, q } }),
    })
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${(await res.text()).slice(0, 120)}`)
    const json = await res.json()
    if (json.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors).slice(0, 160)}`)
    const conn = json.data?.orders
    for (const n of conn?.nodes || []) {
      if (n.test || n.displayFinancialStatus === 'VOIDED') continue
      orders.push({
        id: n.id,
        created_at: n.createdAt,
        current_total_price: n.currentTotalPriceSet?.shopMoney?.amount ?? '0',
        customer: n.customer
          ? { id: n.customer.id, orders_count: n.customer.numberOfOrders != null ? Number(n.customer.numberOfOrders) : null }
          : null,
        line_items: (n.lineItems?.nodes || []).map(li => ({
          sku: li.sku,
          title: li.title,
          quantity: li.quantity,
          price: li.originalUnitPriceSet?.shopMoney?.amount ?? '0',
        })),
      })
    }
    if (!conn?.pageInfo?.hasNextPage) break
    cursor = conn.pageInfo.endCursor
    guard++
  }
  annotateNewCustomers(orders)
  return orders
}

function annotateNewCustomers(orders) {
  // numberOfOrders is the customer's CURRENT lifetime count, not as-of-order,
  // so derive per-order truth: group each customer's orders in this window
  // (ascending); an order is "new" only if it's the customer's first-ever order
  // (lifetime count equals their in-window count and this is the earliest one).
  const byCustomer = {}
  for (const o of orders) {
    const cid = o.customer?.id
    if (!cid) { o._is_new = true; continue } // guest checkout: treat as new
    ;(byCustomer[cid] ||= []).push(o)
  }
  for (const list of Object.values(byCustomer)) {
    list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    const lifetime = list[0].customer.orders_count
    const allHistoryInWindow = lifetime === null ? true : lifetime <= list.length
    list.forEach((o, i) => {
      o._is_new = i === 0 && allHistoryInWindow
    })
  }
}

function orderRevenue(o) {
  return parseFloat(o.current_total_price ?? o.total_price) || 0
}

function isNewCustomer(o) {
  // Set by annotateNewCustomers using GraphQL lifetime order counts.
  return o._is_new !== false
}

function dailyRollup(orders, tz) {
  const byDay = {}
  for (const o of orders) {
    const date = localDate(o.created_at, tz)
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

function skuRollup(orders, tz) {
  // Aggregate line items into per-month, per-SKU units + revenue (the sales mix
  // that weighted GPM derives from). Key = line-item SKU code, else product title.
  const byMonthSku = {}
  for (const o of orders) {
    const month = localDate(o.created_at, tz).slice(0, 7) + '-01'
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

function computeCohorts(orders, tz) {
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
    const month = localDate(first.t.toISOString(), tz).slice(0, 7) + '-01'
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
      const tz = await getShopTimezone(domain, token)
      // Fetch a day wide on each side so store-timezone bucketing never loses edge orders
      const fetchMin = new Date(new Date(monthStartOf(since) + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10)
      const orders = await fetchOrders(domain, token, fetchMin, until)
      const todayLocal = localDate(new Date().toISOString(), tz)
      const byDay = dailyRollup(orders.filter(o => {
        const d = localDate(o.created_at, tz)
        return d >= since && d < todayLocal
      }), tz)
      const rows = Object.entries(byDay)
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
      const mix = skuRollup(orders.filter(o => localDate(o.created_at, tz) < todayLocal), tz).map(r => ({
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
        const cs = computeCohorts(wide, tz).map(c => ({ ...c, client_id: client.id, computed_at: new Date().toISOString() }))
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
