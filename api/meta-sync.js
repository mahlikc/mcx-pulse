// /api/meta-sync — pulls yesterday's insights from the Meta Marketing API for
// every active client with an ad_account_id, and writes them to Supabase.
//
// Runs daily via Vercel cron (see vercel.json). Can also be triggered manually:
//   GET /api/meta-sync?secret=CRON_SECRET            -> sync yesterday
//   GET /api/meta-sync?secret=CRON_SECRET&backfill=30 -> backfill last N days (max 90)
//
// Env vars required (Vercel project settings):
//   META_ACCESS_TOKEN        system user token from your Business Manager (ads_read)
//   SUPABASE_URL             your Supabase project URL
//   SUPABASE_SERVICE_ROLE    service role key (server-side only, bypasses RLS)
//   CRON_SECRET              any random string; Vercel cron sends it automatically
//                            when set, manual calls pass it as ?secret=

import { createClient } from '@supabase/supabase-js'

const GRAPH = 'https://graph.facebook.com/v21.0'

function getAction(actions, types) {
  if (!Array.isArray(actions)) return 0
  for (const t of types) {
    const hit = actions.find(a => a.action_type === t)
    if (hit) return parseFloat(hit.value) || 0
  }
  return 0
}

function isoDaysAgo(n) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

async function fetchJson(url) {
  const res = await fetch(url)
  const json = await res.json()
  if (json.error) throw new Error(`${json.error.code}: ${json.error.message}`)
  return json
}

// Follow paging.next until exhausted — Meta returns rows oldest-first, so
// stopping at one page silently drops the most recent days.
async function fetchAllPages(url, guardMax = 30) {
  const data = []
  let next = url
  let guard = 0
  while (next && guard < guardMax) {
    const json = await fetchJson(next)
    data.push(...(json.data || []))
    next = json.paging?.next || null
    guard++
  }
  return data
}

async function syncAccountDay(token, accountId, since, until) {
  // Account-level, one row per day
  const fields = 'spend,impressions,frequency,cpm,inline_link_clicks,actions,action_values'
  const url =
    `${GRAPH}/act_${accountId}/insights?fields=${fields}` +
    `&time_range={"since":"${since}","until":"${until}"}&time_increment=1&limit=100&access_token=${token}`
  const data = await fetchAllPages(url)
  return data.map(row => ({
    date: row.date_start,
    spend: parseFloat(row.spend) || 0,
    impressions: parseInt(row.impressions) || 0,
    frequency: parseFloat(row.frequency) || null,
    cpm: parseFloat(row.cpm) || null,
    link_clicks: parseInt(row.inline_link_clicks) || 0,
    purchases: Math.round(getAction(row.actions, ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'])),
    meta_revenue: getAction(row.action_values, ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase']),
    adds_to_cart: Math.round(getAction(row.actions, ['omni_add_to_cart', 'add_to_cart'])),
    initiate_checkout: Math.round(getAction(row.actions, ['omni_initiated_checkout', 'initiate_checkout'])),
  }))
}

async function syncAdsDay(token, accountId, since, until) {
  // Ad-level, for fatigue (frequency/CTR on top spenders) and concentration checks
  const fields = 'ad_id,ad_name,spend,frequency,inline_link_click_ctr,actions'
  const url =
    `${GRAPH}/act_${accountId}/insights?level=ad&fields=${fields}` +
    `&time_range={"since":"${since}","until":"${until}"}&time_increment=1` +
    `&filtering=[{"field":"spend","operator":"GREATER_THAN","value":0}]&limit=200&access_token=${token}`
  const data = await fetchAllPages(url)
  return data.map(row => ({
    date: row.date_start,
    ad_id: row.ad_id,
    ad_name: row.ad_name || row.ad_id,
    spend: parseFloat(row.spend) || 0,
    frequency: parseFloat(row.frequency) || null,
    link_ctr: parseFloat(row.inline_link_click_ctr) || null,
    purchases: Math.round(getAction(row.actions, ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'])),
  }))
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET
  const provided =
    req.query?.secret || (req.headers?.authorization || '').replace('Bearer ', '')
  if (!secret || provided !== secret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const token = process.env.META_ACCESS_TOKEN
  if (!token) return res.status(500).json({ error: 'META_ACCESS_TOKEN not set' })

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE)

  const backfill = Math.min(parseInt(req.query?.backfill) || 1, 90)
  const since = isoDaysAgo(backfill)
  const until = isoDaysAgo(1) // through yesterday; today is always partial

  const { data: clients, error } = await supabase
    .from('clients')
    .select('id, name, ad_account_id')
    .eq('active', true)
    .not('ad_account_id', 'is', null)
  if (error) return res.status(500).json({ error: error.message })

  const results = []
  for (const client of clients) {
    const acct = String(client.ad_account_id).replace(/^act_/, '').trim()
    try {
      const days = await syncAccountDay(token, acct, since, until)
      if (days.length) {
        const rows = days.map(d => ({ ...d, client_id: client.id, synced_at: new Date().toISOString() }))
        const { error: e1 } = await supabase
          .from('daily_metrics')
          .upsert(rows, { onConflict: 'client_id,date' })
        if (e1) throw new Error(e1.message)
      }

      const ads = await syncAdsDay(token, acct, since, until)
      if (ads.length) {
        const rows = ads.map(d => ({ ...d, client_id: client.id }))
        const { error: e2 } = await supabase
          .from('ad_metrics')
          .upsert(rows, { onConflict: 'client_id,date,ad_id' })
        if (e2) throw new Error(e2.message)
      }

      results.push({ client: client.name, days: days.length, ads: ads.length, ok: true })
    } catch (err) {
      results.push({ client: client.name, ok: false, error: err.message })
      await supabase.from('alerts').insert({
        client_id: client.id,
        type: 'sync_error',
        message: `Meta sync failed: ${err.message}`,
      })
    }
  }

  return res.status(200).json({ synced: results, range: { since, until } })
}
