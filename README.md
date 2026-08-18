# MCX Pulse

The MCX client reporting system as an app. Meta syncs in every morning; the app runs the playbook — 7-day MER vs break-even, growth/decay signals, SCALE / HOLD / PULL BACK verdicts, auto-drafted Monday reports, a dated scan log, and a client-facing pulse page that never shows 1-day ROAS.

Stack: Vite + React, Vercel (hosting + serverless + cron), Supabase (auth + Postgres + RLS). Same pattern as the Creative Test Ledger and Offer Engine.

---

## 1. Supabase (10 min)

1. Create a new project at supabase.com.
2. SQL Editor → paste all of `supabase/schema.sql` → Run.
3. Authentication → Providers → make sure Email is enabled. Turn OFF "Allow new users to sign up" after you create your own account (solo app).
4. Authentication → Users → Add user → your email + a password. That's your login.
5. Project Settings → API → copy the **Project URL**, **anon key**, and **service_role key**.

## 2. Meta system user token (15 min, one time)

You already have all client ad accounts in your Business Manager, so no App Review is needed — a system user token from your own BM can read insights on every account you manage.

1. developers.facebook.com → My Apps → Create App → type **Business** → name it (e.g. "MCX Pulse"). Connect it to your Business Manager.
2. In the app dashboard, add the **Marketing API** product.
3. business.facebook.com → Business Settings → Users → **System Users** → Add → name it, role **Admin**.
4. Select the system user → **Add Assets** → Ad Accounts → toggle on every client account with at least "View performance."
5. Still on the system user → **Generate New Token** → pick your app → check `ads_read` (add `read_insights` if shown) → set expiry to **Never** → Generate. Copy the token — this is `META_ACCESS_TOKEN`.

When you sign a new client: add their ad account to your BM as usual, then assign it to the system user (step 4). The next sync picks them up automatically.

## 3. GitHub + Vercel (10 min)

1. Push this folder to a **private** GitHub repo.
2. vercel.com → New Project → import the repo. Framework preset: Vite. Deploy.
3. Project → Settings → Environment Variables, add all six from `.env.example`:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (frontend)
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`, `META_ACCESS_TOKEN`, `CRON_SECRET` (serverless — `CRON_SECRET` is any long random string)
4. Redeploy so the env vars take effect.
5. The cron in `vercel.json` runs the sync daily at 10:00 UTC (6am ET). Vercel automatically sends `CRON_SECRET` as the auth header — nothing else to configure.

## 4. First run

1. Log in → **Clients** → add each brand with its ad account ID (the number in Ads Manager, `act_` optional) and its real **BEROAS**. The break-evens drive every light and verdict, so get these right — pull them from the Offer Engine's per-SKU calculator.
2. Backfill 30 days of history by visiting:
   `https://your-app.vercel.app/api/meta-sync?secret=YOUR_CRON_SECRET&backfill=30`
3. The Scan board is now live.

## The daily flow (matches Part 6 of the playbook)

- **Morning:** open Scan. Reds sort to the top. If nothing tripped, hit **Log today's scan** and close the tab — that's the whole job.
- **Store revenue:** on each client page, enter yesterday's Shopify revenue (10 seconds). With 4+ days of entries in the window, MER switches from Meta-attributed to store truth automatically.
- **Monday:** Reports tab → pick a client → numbers prefill in your exact template → write the two sentences → Copy → send. Save to history for receipts.
- **Client pulse:** each client page has a share link (`/p/<code>`). Send it once: "You have 24/7 access to everything I see, framed the way I read it." The page shows 7-day MER, the light, and your note — never a raw daily number, and it can't deliver bad news before you do (update the note first).

## What the engine checks (so you don't have to)

- Pacing ±20% vs planned daily spend
- 7-day rolling MER vs BEROAS (the only performance number judged daily)
- Frequency ≥2.5 with softening CTR on the top 2 spenders (fatigue incoming)
- One ad carrying 60%+ of purchases (fragile account)
- CPM up 15%+ week-over-week with flat CTR
- CPA rising 3 consecutive weeks
- Part 4 verdicts: SCALE needs all three conditions; PULL BACK at 7+ days under break-even with no trend; KILL & REBUILD at 3 straight weeks under

---

# v2 — Rev-Share Operator Layer

Run `supabase/schema-v2.sql` in the SQL editor (once, after schema.sql). Then redeploy.

## Shopify revenue sync (per client, ~5 min each)

Shopify removed in-admin custom apps in Jan 2026 — new apps are created in the
**Dev Dashboard** (dev.shopify.com) and authenticate with a Client ID + Secret,
which the sync exchanges for an access token automatically. Run `schema-v4.sql`
once to add the credential columns.

Per store, in YOUR Dev Dashboard (one app per store — Custom distribution is
single-store):

1. dev.shopify.com → your org → **Create app** → name it `MCX Reporting — <Brand>`.
2. On the Create version page: App URL `https://shopify.dev/apps/default-app-home`,
   uncheck "Embed app in Shopify admin", scroll to **API access** → add the
   **`read_orders`** Admin API scope → **Release**.
3. App → **Distribution** → **Custom distribution** → enter the store's
   `brand.myshopify.com` → copy the install link → open it (logged into that
   store's admin) → **Install**.
4. App → **Settings** → copy the **Client ID** and **Client Secret**.
5. In MCX Pulse → Clients: paste the store domain + Client ID + Client Secret.
   (The legacy `shpat_` field remains only for stores that already had an
   admin-created custom app — those still work.)
6. Backfill: `/api/shopify-sync?secret=…&backfill=30&cohorts=1`

Revenue, orders, and the new-vs-returning split then sync daily at 10:15 UTC,
and MER switches to store truth automatically.

## What v2 adds in the app

- **Three-tier lights (9e):** below BEROAS = 🔴, between BEROAS and Target ROAS = 🟡,
  at/above target = 🟢. Set Target ROAS per client (defaults to BE × 1.1).
- **Customer economics on client pages:** nMER, cost per new customer, % new revenue,
  nAOV/rAOV — with an automatic warning when blended MER looks fine but nMER is below
  break-even (repeat orders hiding an unprofitable acquisition engine).
- **Monthly review generator:** scoreboard vs last month vs targets, client P&L down to
  **Client Net after your commission** (the retention truth metric — it goes red when
  negative), true break-even MER derived from contribution margin (warns when it drifts
  from your configured BEROAS), the Part 7 growth scorecard with trend arrows, cohort
  table, and the full 8-section review in copyable text. Five manual inputs per month
  (list size, list %, events, SKUs, buyer insight); everything else prefills.
- **Weekly report delivery:** add a report email/phone per client, set the Resend and/or
  Twilio env vars, and Send buttons appear on the Weekly page. Sends mark the report as
  sent in history. (Resend: free tier + verify your domain. Twilio: any SMS-capable number.)
- **Alert digest on Scan:** unresolved alerts (sync failures now; anything you insert
  into `alerts` later) sit in a red panel at the top — checklist item #1, account health —
  with one-click resolve.
- **Stock flag (9c):** a free-text flag per client ("Hero tee ~2 wks stock") that shows
  on the scan strip until you clear it — the 10-second inventory glance.

## Not automated (by design, for now)

Branded search / direct traffic / engagement trends (9d) stay a 5-minute manual monthly
check — Google Trends + Shopify analytics + IG. Inventory weeks-of-stock stays a manual
flag until clients share stock data. Both have a home in the monthly review notes.

---

# v3 — SKU catalog & self-updating margins

Run `supabase/schema-v3.sql` once (after v2). Then redeploy.

The per-client intake now includes the catalog: every SKU with **price + COGS**, entered
once on the client page (Catalog panel). From there:

- Each SKU shows its margin; the panel computes GPM for the account.
- The Shopify sync now pulls **line items** too, so once orders flow, GPM upgrades from a
  simple average to **sales-mix weighted GPM** — recalculated from what actually sold each
  month, never stale. A coverage % shows how much revenue matched the catalog, and
  unmatched SKUs are called out so you can add them or set their codes (match is by SKU
  code first, then exact product name).
- One click derives **BEROAS (1 ÷ contribution margin)** and **BECPA (AOV × CM)** from the
  catalog — using trailing-30d AOV, fees %, and ship cost — and applies them to the client,
  so the lights and Part 4 verdicts run on real margin math. It warns when your configured
  BEROAS has drifted from what the catalog says.
- On the Monthly page, the **"From catalog"** button fills that month's weighted GPM from
  its actual sales mix, feeding the P&L straight through to Client Net.

Backfill tip after adding a catalog: `/api/shopify-sync?secret=…&backfill=60` pulls enough
line-item history to weight the last two months.
