// /api/shopify-callback — Shopify redirects here after the merchant approves.
// Exchanges the one-time code for a permanent offline access token (shpat_)
// and saves it (plus the canonical shop domain) on the matching client row.

import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

export default async function handler(req, res) {
  const { code, shop, state } = req.query || {}
  if (!code || !shop || !state) return res.status(400).send('Missing code/shop/state.')

  const secret = process.env.CRON_SECRET
  const [clientId, sig] = String(state).split('.')
  const expected = crypto.createHmac('sha256', secret).update(clientId || '').digest('hex').slice(0, 32)
  if (!clientId || sig !== expected) return res.status(403).send('Bad state — start again from /api/shopify-connect.')

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE)
  const { data: client } = await supabase
    .from('clients')
    .select('id, name, shopify_client_id, shopify_client_secret')
    .eq('id', clientId)
    .maybeSingle()
  if (!client) return res.status(404).send('Client not found.')

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: client.shopify_client_id.trim(),
      client_secret: client.shopify_client_secret.trim(),
      code,
    }),
  })
  const text = await tokenRes.text()
  let json = {}
  try { json = JSON.parse(text) } catch {}
  if (!tokenRes.ok || !json.access_token) {
    return res.status(502).send(`Token exchange failed [HTTP ${tokenRes.status}]: ${text.slice(0, 300)}`)
  }

  const { error } = await supabase
    .from('clients')
    .update({ shopify_token: json.access_token, shopify_domain: shop })
    .eq('id', client.id)
  if (error) return res.status(500).send(`Token received but saving failed: ${error.message}`)

  res.setHeader('Content-Type', 'text/html')
  return res.status(200).send(
    `<body style="font-family:system-ui;background:#0c0e12;color:#e9ecf1;display:grid;place-items:center;height:100vh;margin:0">
      <div style="text-align:center">
        <div style="font-size:40px">✅</div>
        <h2 style="margin:8px 0">${client.name} connected</h2>
        <p style="color:#98a2b0">Permanent token saved for <b>${shop}</b>.<br/>
        Now run the shopify-sync backfill URL — this store will sync daily from here on.</p>
      </div>
    </body>`
  )
}
