// The decision engine. Implements Part 3 (growth/decay signals) and
// Part 4 (scale / hold / pull back / kill) from the MCX reporting system.
// Everything reads 7-day windows. 1-day data is observed, never judged.

const num = v => (v === null || v === undefined ? 0 : Number(v))

export function sumWindow(days, key) {
  return days.reduce((s, d) => s + num(d[key]), 0)
}

// Blend Shopify truth over Meta attribution wherever a manual entry exists
export function blendedRevenue(days, revMap) {
  return days.reduce((s, d) => s + (revMap[d.date] !== undefined ? num(revMap[d.date]) : num(d.meta_revenue)), 0)
}

export function windowStats(days, revMap = {}) {
  const spend = sumWindow(days, 'spend')
  const purchases = sumWindow(days, 'purchases')
  const revenue = blendedRevenue(days, revMap)
  const shopifyDays = days.filter(d => revMap[d.date] !== undefined).length
  return {
    spend,
    purchases,
    revenue,
    mer: spend > 0 ? revenue / spend : null,
    cpa: purchases > 0 ? spend / purchases : null,
    revenueSource: shopifyDays >= Math.ceil(days.length / 2) ? 'store' : 'meta',
  }
}

// days: ascending array of daily_metrics rows. Returns last N, most recent last.
export function lastN(days, n, endOffset = 0) {
  const end = days.length - endOffset
  return days.slice(Math.max(0, end - n), end)
}

// ---------- Part 6a: pacing ----------
export function pacingCheck(yesterday, plannedDailySpend) {
  if (!yesterday || !plannedDailySpend) return null
  const ratio = num(yesterday.spend) / plannedDailySpend
  if (ratio < 0.8) return { level: 'warn', text: `Underdelivered: $${num(yesterday.spend).toFixed(0)} vs $${plannedDailySpend} planned` }
  if (ratio > 1.2) return { level: 'warn', text: `Overdelivered: $${num(yesterday.spend).toFixed(0)} vs $${plannedDailySpend} planned` }
  return { level: 'ok', text: 'Pacing fine' }
}

// ---------- Part 3: decay signals ----------
export function decaySignals(days, adDays, revMap = {}) {
  const signals = []
  const w7 = lastN(days, 7)
  const prev7 = lastN(days, 7, 7)

  // Frequency creeping past 2.5–3 on top spenders with softening CTR
  const byAd = {}
  for (const row of adDays) {
    if (!byAd[row.ad_id]) byAd[row.ad_id] = { name: row.ad_name, spend: 0, rows: [] }
    byAd[row.ad_id].spend += num(row.spend)
    byAd[row.ad_id].rows.push(row)
  }
  const topAds = Object.values(byAd).sort((a, b) => b.spend - a.spend).slice(0, 2)
  for (const ad of topAds) {
    const recent = ad.rows.slice(-3)
    const freq = recent.length ? recent.reduce((s, r) => s + num(r.frequency), 0) / recent.length : 0
    const ctrRecent = recent.length ? recent.reduce((s, r) => s + num(r.link_ctr), 0) / recent.length : 0
    const earlier = ad.rows.slice(0, Math.max(1, ad.rows.length - 3))
    const ctrEarlier = earlier.length ? earlier.reduce((s, r) => s + num(r.link_ctr), 0) / earlier.length : 0
    if (freq >= 2.5 && ctrEarlier > 0 && ctrRecent < ctrEarlier * 0.85) {
      signals.push({ type: 'fatigue', text: `"${ad.name}" — frequency ${freq.toFixed(1)}, CTR softening (${ctrEarlier.toFixed(2)}% → ${ctrRecent.toFixed(2)}%). Fatigue incoming.` })
    } else if (freq >= 3) {
      signals.push({ type: 'fatigue', text: `"${ad.name}" — frequency ${freq.toFixed(1)}. Watch closely.` })
    }
  }

  // One ad carrying 60%+ of purchases
  const totalPurch = adDays.reduce((s, r) => s + num(r.purchases), 0)
  if (totalPurch >= 10) {
    const purchByAd = {}
    for (const r of adDays) purchByAd[r.ad_id] = { name: r.ad_name, p: (purchByAd[r.ad_id]?.p || 0) + num(r.purchases) }
    const hero = Object.values(purchByAd).sort((a, b) => b.p - a.p)[0]
    if (hero && hero.p / totalPurch >= 0.6) {
      signals.push({ type: 'concentration', text: `"${hero.name}" is carrying ${Math.round((hero.p / totalPurch) * 100)}% of purchases. Fragile — one fatigue event from a bad month.` })
    }
  }

  // CPMs rising while CTR flat (paying more for the same attention)
  const cpm7 = w7.filter(d => d.cpm).map(d => num(d.cpm))
  const cpmPrev = prev7.filter(d => d.cpm).map(d => num(d.cpm))
  if (cpm7.length >= 4 && cpmPrev.length >= 4) {
    const avg = a => a.reduce((s, v) => s + v, 0) / a.length
    const ctr = w => { const i = sumWindow(w, 'impressions'); return i > 0 ? sumWindow(w, 'link_clicks') / i : 0 }
    if (avg(cpm7) > avg(cpmPrev) * 1.15 && ctr(w7) <= ctr(prev7) * 1.05) {
      signals.push({ type: 'cpm', text: `CPMs up ${Math.round((avg(cpm7) / avg(cpmPrev) - 1) * 100)}% week-over-week with flat CTR.` })
    }
  }

  // CPA rising 3 consecutive weeks
  const weeks = [lastN(days, 7, 14), lastN(days, 7, 7), lastN(days, 7)]
    .map(w => windowStats(w, revMap).cpa)
  if (weeks.every(c => c !== null) && weeks[2] > weeks[1] && weeks[1] > weeks[0]) {
    signals.push({ type: 'cpa_trend', text: `CPA rising 3 straight weeks: $${weeks[0].toFixed(0)} → $${weeks[1].toFixed(0)} → $${weeks[2].toFixed(0)}.` })
  }

  return signals
}

// ---------- Part 3: growth signals ----------
export function growthSignals(days, revMap = {}) {
  const signals = []
  const w7 = windowStats(lastN(days, 7), revMap)
  const prev7 = windowStats(lastN(days, 7, 7), revMap)

  if (w7.cpa !== null && prev7.cpa !== null && w7.cpa < prev7.cpa * 0.95) {
    signals.push({ type: 'cpa_down', text: `CPA declining week-over-week: $${prev7.cpa.toFixed(0)} → $${w7.cpa.toFixed(0)}.` })
  }
  // MER stable/improving while spend increases — the single best scale sign
  if (w7.mer !== null && prev7.mer !== null && w7.spend > prev7.spend * 1.1 && w7.mer >= prev7.mer * 0.97) {
    signals.push({ type: 'scalable', text: `Spend up ${Math.round((w7.spend / prev7.spend - 1) * 100)}% with MER holding (${prev7.mer.toFixed(2)} → ${w7.mer.toFixed(2)}). Best sign an account can scale.` })
  }
  const atc7 = sumWindow(lastN(days, 7), 'adds_to_cart')
  const atcPrev = sumWindow(lastN(days, 7, 7), 'adds_to_cart')
  const s7 = w7.spend, sp = prev7.spend
  if (atc7 > 0 && atcPrev > 0 && s7 > 0 && sp > 0 && s7 / atc7 < (sp / atcPrev) * 0.9) {
    signals.push({ type: 'atc', text: `Cost per add-to-cart dropping — purchases may lag but intent is cheapening.` })
  }
  return signals
}

// ---------- Part 4: the decision playbook ----------
export function verdict(client, days, adDays, revMap = {}) {
  const w7 = windowStats(lastN(days, 7), revMap)
  const be = num(client.beroas) || 2.0
  const reasons = []

  if (w7.mer === null || w7.spend === 0) {
    return { call: 'HOLD', light: 'yellow', reasons: ['No spend data in the last 7 days.'], w7 }
  }

  // KILL & REBUILD: 3+ consecutive weeks below break-even
  const weekMers = [lastN(days, 7, 14), lastN(days, 7, 7), lastN(days, 7)]
    .map(w => windowStats(w, revMap).mer)
  if (weekMers.every(m => m !== null && m < be)) {
    return {
      call: 'KILL & REBUILD', light: 'red', w7,
      reasons: [`3 straight weeks below break-even (${weekMers.map(m => m.toFixed(2)).join(' → ')} vs BE ${be}). This is a strategy call, not a report — offer, landing page, or product focus is on the table.`],
    }
  }

  // PULL BACK: below break-even 7+ days, no improving trend
  if (w7.mer < be) {
    const first3 = windowStats(lastN(days, 3, 4), revMap).mer
    const last3 = windowStats(lastN(days, 3), revMap).mer
    const improving = first3 !== null && last3 !== null && last3 > first3 * 1.05
    if (!improving) {
      return {
        call: 'PULL BACK', light: 'red', w7,
        reasons: [`7-day MER ${w7.mer.toFixed(2)} below break-even ${be} with no improving trend. Cut 30–50% on worst performers, keep winners at maintenance, push a fresh test batch.`],
      }
    }
    return {
      call: 'HOLD', light: 'yellow', w7,
      reasons: [`Below break-even (${w7.mer.toFixed(2)} vs ${be}) but trending up inside the week. Let it read.`],
    }
  }

  // SCALE: all three conditions
  const room = w7.mer >= be * 1.25
  const purchByAd = {}
  for (const r of adDays) if (num(r.purchases) > 0) purchByAd[r.ad_id] = true
  const producers = Object.keys(purchByAd).length
  const w7days = lastN(days, 7)
  const spends = w7days.map(d => num(d.spend)).filter(s => s > 0)
  const avgSpend = spends.length ? spends.reduce((a, b) => a + b, 0) / spends.length : 0
  const stable = spends.length >= 7 && spends.every(s => Math.abs(s - avgSpend) / avgSpend < 0.35)

  if (room) reasons.push(`MER ${w7.mer.toFixed(2)} with room above break-even ${be}.`)
  else reasons.push(`MER ${w7.mer.toFixed(2)} above break-even ${be}, but not enough room to scale yet (want ${(be * 1.25).toFixed(1)}+).`)
  if (producers >= 2) reasons.push(`${producers} ads producing purchases — not one hero carrying everything.`)
  else reasons.push(`Only ${producers} ad producing purchases. Widen the portfolio before scaling.`)
  if (stable) reasons.push('Spend stable 7+ days.')
  else reasons.push('Spend not yet stable across the window.')

  // Three-tier lights (Part 9e): below floor = red, between = yellow, at/above target = green.
  // When no target is set, target defaults to BE * 1.1.
  const target = num(client.target_roas) || be * 1.1
  const tierLight = w7.mer >= target ? 'green' : 'yellow'

  if (room && producers >= 2 && stable) {
    return { call: 'SCALE', light: tierLight, w7, reasons: [...reasons, '+20–30% on winners every 3–4 days. Never double overnight. Tell the client the day you do it.'] }
  }
  return { call: 'HOLD', light: tierLight, w7, reasons }
}

// ---------- Part 9: customer economics from Shopify-split revenue rows ----------
export function economics(days, revRows) {
  const spend = sumWindow(days, 'spend')
  const rows = revRows.filter(r => r.new_orders !== null && r.new_orders !== undefined)
  if (!rows.length) return null
  const newRev = rows.reduce((s, r) => s + num(r.new_revenue), 0)
  const newOrders = rows.reduce((s, r) => s + num(r.new_orders), 0)
  const retRev = rows.reduce((s, r) => s + num(r.returning_revenue), 0)
  const retOrders = rows.reduce((s, r) => s + num(r.returning_orders), 0)
  const totalRev = newRev + retRev
  return {
    newOrders, retOrders, newRev, retRev,
    naov: newOrders ? newRev / newOrders : null,
    raov: retOrders ? retRev / retOrders : null,
    nMer: spend > 0 ? newRev / spend : null,          // acquisition-only efficiency
    ncpa: newOrders ? spend / newOrders : null,
    pctNewRev: totalRev > 0 ? (newRev / totalRev) * 100 : null,
    returningPct: (newOrders + retOrders) > 0 ? (retOrders / (newOrders + retOrders)) * 100 : null,
  }
}

export const trendArrow = (now, prev) => {
  if (now === null || prev === null || now === undefined || prev === undefined) return '→'
  if (now > prev * 1.03) return '↗'
  if (now < prev * 0.97) return '↘'
  return '→'
}

// ---------- The prescription layer: verdict + signals → this week's moves ----------
// Every branch is a pre-committed play from Parts 3/4 of the playbook, filled in
// with the account's actual ads and numbers. No interpretation left to 6am brain.
export function actionPlan(client, v, decaySigs, growthSigs, adDays) {
  const moves = []
  const be = num(client.beroas) || 2.0

  // Rank ads over the window for naming winners/losers
  const byAd = {}
  for (const r of adDays) {
    const a = (byAd[r.ad_id] ||= { name: r.ad_name, spend: 0, purchases: 0 })
    a.spend += num(r.spend); a.purchases += num(r.purchases)
  }
  const ads = Object.values(byAd).sort((a, b) => b.spend - a.spend)
  const winners = ads.filter(a => a.purchases > 0).sort((a, b) => b.purchases - a.purchases)
  const totalAdPurch = ads.reduce((s, a) => s + a.purchases, 0)

  if (v.call === 'SCALE') {
    const names = winners.slice(0, 2).map(a => `"${a.name}"`).join(' and ') || 'the top performers'
    moves.push({ tag: 'scale', text: `Raise budget +20–30% today on ${names}. Next raise in 3–4 days, not before. Message the client that you're scaling and why.` })
  }

  if (v.call === 'PULL BACK') {
    const worst = ads.filter(a => a.spend > 0 && a.purchases === 0).slice(0, 2).map(a => `"${a.name}"`).join(', ')
    moves.push({ tag: 'pullback', text: `Cut 30–50% on the worst performers today${worst ? ` (${worst} spent with zero purchases this week)` : ''}. Keep proven winners at maintenance. Push a fresh test batch live within 48h.` })
  }

  if (v.call === 'KILL & REBUILD') {
    moves.push({ tag: 'rebuild', text: `Stop optimizing ads — 3 weeks under break-even is a strategy problem. Book a call with the client this week: offer, landing page, or product focus is on the table. Drop spend to maintenance while you rebuild.` })
  }

  for (const s of decaySigs) {
    if (s.type === 'fatigue') {
      const name = (s.text.match(/"([^"]+)"/) || [])[1]
      moves.push({ tag: 'creative', text: `Brief 2–3 variations of ${name ? `"${name}"` : 'the fatiguing ad'} this week (same angle, fresh hook/visual). Launch before killing the original — replace, don't gap.` })
    }
    if (s.type === 'concentration') {
      moves.push({ tag: 'de-risk', text: `One ad is carrying the account. Promote your 2 best recent testers to real budget this week so a single fatigue event can't sink the month.` })
    }
    if (s.type === 'cpa_trend') {
      moves.push({ tag: 'test', text: `CPA has risen 3 straight weeks — a fresh test batch (3–5 new creatives on the best-performing angle) goes live by Thursday. If week 4 rises too, that triggers PULL BACK automatically.` })
    }
    if (s.type === 'cpm') {
      moves.push({ tag: 'auction', text: `You're paying more for the same attention. Test new hooks/audiences this week — CPM inflation with flat CTR means the current creative is aging into a more expensive auction.` })
    }
    if (s.type === 'pacing') {
      moves.push({ tag: 'pacing', text: `Delivery is off plan. Check for budget edits, cost caps, or learning-phase resets — then either fix delivery or update the planned daily spend so the check stays honest.` })
    }
  }

  if (v.call === 'HOLD' && !moves.length) {
    const missing = (v.reasons || []).filter(r => r.includes('not') || r.includes('Only') || r.includes('Widen'))
    if (missing.length) {
      moves.push({ tag: 'unlock', text: `Nothing is on fire — work the scale blockers: ${missing.join(' ')}` })
    }
  }

  if (totalAdPurch === 0 && v.w7.purchases > 0) {
    moves.push({ tag: 'data', text: `Heads up: account-level shows purchases but ad-level attribution shows 0 — likely modeled/delayed conversions. Judge on MER and account CPA this week; re-check ad-level tomorrow.` })
  }

  if (!moves.length) {
    moves.push({ tag: 'hold', text: `Nothing tripped a threshold. Touch nothing, log the scan, close the tab — that's the discipline that compounds.` })
  }

  return moves
}

// ---------- 6a: the auto-drafted one-line log ----------
export function scanLine(client, v, pacing, flags) {
  const d = new Date()
  const date = `${d.getMonth() + 1}/${d.getDate()}`
  const parts = [
    pacing ? (pacing.level === 'ok' ? 'pacing fine' : pacing.text.toLowerCase()) : 'no pacing target',
    v.w7.mer !== null ? `MER ${v.w7.mer.toFixed(1)}` : 'no MER',
    flags.length ? `${flags.length} flag${flags.length > 1 ? 's' : ''}` : 'no flags',
  ]
  return `${date} — ${client.name}: ${parts.join(', ')}`
}
