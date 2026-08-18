// /api/send-report — delivers a weekly report by email (Resend) and/or SMS (Twilio).
// Auth: requires the logged-in user's Supabase access token; verifies the client
// row belongs to that user before sending anything.
//
// Env (all optional — each channel activates only if its vars are set):
//   RESEND_API_KEY, REPORT_FROM_EMAIL   e.g. reports@yourdomain.com (verified in Resend)
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const token = (req.headers?.authorization || '').replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Missing auth token' })

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE)
  const { data: userData, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !userData?.user) return res.status(401).json({ error: 'Invalid session' })

  const { client_id, body, subject, channel } = req.body || {}
  if (!client_id || !body) return res.status(400).json({ error: 'client_id and body required' })

  const { data: client } = await supabase
    .from('clients')
    .select('id, name, report_email, report_phone, user_id')
    .eq('id', client_id)
    .single()
  if (!client || client.user_id !== userData.user.id) {
    return res.status(403).json({ error: 'Not your client' })
  }

  const sent = []
  const errors = []

  // ---- Email via Resend ----
  if ((channel === 'email' || channel === 'both') && client.report_email) {
    if (!process.env.RESEND_API_KEY || !process.env.REPORT_FROM_EMAIL) {
      errors.push('Email not configured (RESEND_API_KEY / REPORT_FROM_EMAIL)')
    } else {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `MCX <${process.env.REPORT_FROM_EMAIL}>`,
          to: [client.report_email],
          subject: subject || `Weekly report — ${client.name}`,
          text: body,
        }),
      })
      if (r.ok) sent.push(`email → ${client.report_email}`)
      else errors.push(`Email failed: ${(await r.text()).slice(0, 200)}`)
    }
  }

  // ---- SMS via Twilio ----
  if ((channel === 'sms' || channel === 'both') && client.report_phone) {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok, TWILIO_FROM_NUMBER: from } = process.env
    if (!sid || !tok || !from) {
      errors.push('SMS not configured (TWILIO_* env vars)')
    } else {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: client.report_phone, From: from, Body: body }),
      })
      if (r.ok) sent.push(`sms → ${client.report_phone}`)
      else errors.push(`SMS failed: ${(await r.text()).slice(0, 200)}`)
    }
  }

  if (!sent.length && !errors.length) {
    errors.push('No destination on file — add a report email or phone on the Clients page.')
  }

  return res.status(errors.length && !sent.length ? 422 : 200).json({ sent, errors })
}
