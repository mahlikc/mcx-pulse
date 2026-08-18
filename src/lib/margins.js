// Margin math for the SKU catalog (Part 9a/9e).
// Weighted GPM = gross margin weighted by the actual sales mix — this is what
// BEROAS derives from, and it moves when the mix moves.

const norm = s => (s || '').trim().toLowerCase()

export function skuMargin(sku) {
  const price = Number(sku.price) || 0
  const cogs = Number(sku.cogs) || 0
  return price > 0 ? (price - cogs) / price : 0
}

// Match a Shopify sales row (sku_key = code or title) to a catalog SKU.
export function matchSku(skus, salesRow) {
  const key = norm(salesRow.sku_key)
  return (
    skus.find(s => s.sku_code && norm(s.sku_code) === key) ||
    skus.find(s => norm(s.name) === key) ||
    null
  )
}

// Simple (unweighted) average GPM across active catalog SKUs — the fallback
// when there's no sales data yet.
export function simpleGpm(skus) {
  const active = skus.filter(s => s.active !== false && Number(s.price) > 0)
  if (!active.length) return null
  return active.reduce((s, k) => s + skuMargin(k), 0) / active.length
}

// Sales-mix weighted GPM for one month of sku_sales rows.
// Returns { gpm, coverage, matchedRev, totalRev, unmatched } — coverage is the
// share of revenue that matched a catalog SKU (the honesty number).
export function weightedGpm(skus, salesRows) {
  let matchedRev = 0
  let weighted = 0
  let totalRev = 0
  const unmatched = []
  for (const row of salesRows) {
    const rev = Number(row.revenue) || 0
    totalRev += rev
    const sku = matchSku(skus, row)
    if (sku) {
      matchedRev += rev
      weighted += rev * skuMargin(sku)
    } else if (rev > 0) {
      unmatched.push({ key: row.sku_key, revenue: rev })
    }
  }
  if (matchedRev <= 0) return { gpm: null, coverage: 0, matchedRev: 0, totalRev, unmatched }
  return {
    gpm: weighted / matchedRev,
    coverage: totalRev > 0 ? matchedRev / totalRev : 0,
    matchedRev,
    totalRev,
    unmatched: unmatched.sort((a, b) => b.revenue - a.revenue).slice(0, 5),
  }
}

// Contribution margin → break-even thresholds.
// cm = gpm − fees% − (avg ship / AOV). BEROAS(MER floor) = 1/cm. BECPA = AOV × cm.
export function breakevens({ gpm, feesPct = 0.03, avgShip = 0, aov = null }) {
  if (!gpm) return null
  const shipPct = aov && aov > 0 ? avgShip / aov : 0
  const cm = gpm - feesPct - shipPct
  if (cm <= 0) return { cm, beroas: null, becpa: null }
  return {
    cm,
    beroas: 1 / cm,
    becpa: aov ? aov * cm : null,
  }
}
