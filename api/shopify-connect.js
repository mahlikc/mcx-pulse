// /api/shopify-connect?secret=CRON_SECRET&client=<pulse client uuid>
// One-time per store: redirects to Shopify's approval page for the client's
// Dev Dashboard app. After approval, /api/shopify-callback captures a permanent
// offline shpat_ token and saves it on the client row. (Needed because Shopify
// blocks the client-credentials shortcut for partner-org apps: shop_not_permitted.)
//
// Prereq: the app's "Allowed redirection URL(s)" must include
//   https://<your-app-domain>/api/shopify-callback

import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET
  const provided = req.query?.secret || ''
  if (!secret || provided !== secret) return res.status(401).json({ error: 'Unauthorized' })

  const clientId = (req.query?.client || '').trim()
  if (!clientId) return res.status(400).json({ error: 'Missing ?client=<uuid>' })

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE)
  const { data: client } = await supabase
    .from('clients')
    .select('id, name, shopify_domain, shopify_client_id')
    .eq('id', clientId)
    .maybeSingle()
  if (!client) return res.status(404).json({ error: 'Client not found' })
  if (!client.shopify_domain || !client.shopify_client_id) {
    return res.status(400).json({ error: 'Save the store domain + Dev Dashboard Client ID on this client first.' })
  }

  const domain = client.shopify_domain.replace(/^https?:\/\//, '').replace(/\/.*/, '')
  const host = req.headers['x-forwarded-host'] || req.headers.host
  const redirectUri = `https://${host}/api/shopify-callback`
  const sig = crypto.createHmac('sha256', secret).update(client.id).digest('hex').slice(0, 32)
  const state = `${client.id}.${sig}`

  const url =
    `https://${domain}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(client.shopify_client_id.trim())}` +
    `&scope=read_orders` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`

  res.writeHead(302, { Location: url })
  res.end()
}
