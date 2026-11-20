# Free Hosting Research — durable free home for the E-Library app

**Date:** 2026-11-20 · **App profile:** Express (Node) server + compiled Flutter web build in one
process, SQLite database, ~46 MB of files, self-seeds to demo state on boot.
**Method:** every claim below was checked on the vendor's own pricing/docs pages (fetched
2026-11-20). Blog roundups were used only to find candidates, never as evidence — two of them
proved stale today (Qoddi, Back4App).

**Hard requirements:** permanent free tier (not a trial) · no credit card · runs a Node/Express
server from GitHub or Docker at a public HTTPS URL · ≥256 MB RAM.

## Verdict table

| Host | Permanent free? | Card? | RAM | SQLite persists? | Sleeps? | Verdict |
|---|---|---|---|---|---|---|
| **Railway Free plan** | Yes — $1/mo credit forever | **No** | 512 MB | **Yes — 0.5 GB volume included** | Yes, wakes on request | ✅ **Best pick** |
| **Azure for Students → App Service F1** | Yes — F1 is an always-free SKU | **No** | 1 GB | **Yes — persistent /home** | Idle timeout ~20 min | ✅ Runner-up (eligibility gate) |
| **SnapDeploy** | Yes — "a real tier, not a trial" | **No** | 512 MB | **No — FS resets on every wake** | Yes, ~60 s wake page | ⚠️ Fallback only |
| Back4App Containers | Free tier doesn't expire | No | 256 MB | Moot | — | ❌ Free URL dies 60 min after each deploy |
| Leapcell | Yes (Hobby) | No | Serverless only | No — ephemeral FS | Scale-to-zero | ❌ Persistent servers are paid ($7/mo) |
| Qoddi | Free = static sites only | **Yes — even for free sites** | — | — | — | ❌ Fails twice |
| Northflank Sandbox | Yes | **Yes — required to create anything** | ~$20/mo of resources | Volumes exist | No — always on | ❌ Card gate (their docs contradict their marketing) |
| Koyeb | Free Starter closed to new signups (Feb 2026) | **Yes — $29 hold** | 512 MB | — | Scales to zero | ❌ Card gate |
| Zeabur | Free plan = manage your *own* server | — | — | — | — | ❌ No free hosted compute anymore |
| Oracle Cloud Always Free | Yes — real VMs, unlimited time | **Yes — at sign-up** | 1–24 GB | Yes | No | ❌ Card gate (best tech, wrong rule) |
| Fly.io | No free tier (trial = $1 / 7 days) | Needed to run past 5 min | — | — | — | ❌ Trial only |
| Render | Free instances exist | **Yes — demanded at deploy (verified first-hand today)** | 512 MB | No | Yes | ❌ Card gate |
| Hugging Face Spaces | Static only | No | — | — | — | ❌ Docker Spaces need PRO (verified first-hand today) |

---

## 1. Railway — the post-trial Free plan (BEST PICK)

The current deployment is already on Railway's 30-day trial ($5 one-time credit). What matters
is what remains after it. From Railway's own Free Plan documentation
(https://docs.railway.com/pricing/free-plan):

- "It costs $0 a month, includes $1 of resource usage each month, and needs no credit card."
- The plan is permanent and monthly: the "$1 resets every billing cycle and does not roll over";
  the trial is explicitly "a one-time boost, not a plan", and after it you "continue on the Free plan".
- Included: 1 project, up to 3 services, each up to 1 vCPU / 0.5 GB RAM; **1 volume (0.5 GB)**;
  a `*.up.railway.app` domain per service.
- Sleep behaviour: services run serverless — "A service sleeps after 5 to 10 minutes without
  outbound traffic and wakes on the next request. A sleeping service incurs no compute charges."
- When the $1 runs out: "your services stop until the next billing cycle or until you upgrade.
  Volumes and bucket files are kept."

**How far does $1/month actually go for this app?** Railway's own table: $1 buys "100 MB [RAM],
around the clock" for a month, or "0.05 vCPU, around the clock", or 20 GB of egress. Working
from those rates: this app idles at roughly 150–250 MB RAM and near-zero CPU while serving.
While awake it therefore costs on the order of **$0.005–0.006 per hour** (RAM + a little CPU).
$1 ≈ **160–200 awake hours a month**. A sleeping service bills nothing, and each isolated visit
bills roughly the visit plus the 5–10-minute sleep lag — a 10-minute teacher visit costs about
$0.002. Even a hundred demo visits a month lands near $0.20. Egress is $0.05/GB, so the same $1
also covers ~20 GB of downloads — thousands of first loads of the web app.

**The one way to break it:** keep the service awake 24/7 (e.g. an external uptime pinger).
Awake around the clock, this app would burn roughly $3.50+/month and stop mid-month. On the
Free plan, do **not** set up a pinger — sleeping is what makes the maths work.

**SQLite:** attach the included 0.5 GB volume and point the database path at it; the volume
survives sleeps, restarts and redeploys, so data persists. (Without a volume, the container
filesystem is not the place for the database.)

**Migration notes for later (important):**
- The switch is **not automatic**: per the docs, when the trial ends "your services stop.
  Switch to the Free plan from the Plans page… then redeploy."
- "Railway deletes stateful volumes created by Trial accounts 30 days after the expiration of
  your credits" — so after switching, redeploy with the Free plan's own volume and let the app
  re-seed; don't rely on a trial-era volume surviving.
- Free plan trade-offs vs trial: no custom domain, no cron jobs, Railway picks the region.

**Deploy method:** GitHub repo (already connected) or Dockerfile. **Expiry:** none — the plan
recurs monthly at $0.

## 2. Azure for Students → App Service F1 (runner-up)

From Microsoft's own offer details (https://azure.microsoft.com/en-us/pricing/offers/ms-azr-0170p)
and the students page (https://azure.microsoft.com/en-us/free/students/):

- "Azure for Students gets you started with $100 in Azure credits to be used within the first
  12 months, plus select free services… **without requiring a credit card at sign-up**."
- Eligibility, verbatim in substance: you must affirm you are **age 18 or older** and attend an
  **accredited, degree-granting two- or four-year institution as a full-time student**, and
  "verify your academic status through your organization's email address." Nothing in the offer
  restricts it to US institutions — verification is by institution email domain, worldwide.
  **Practical risk for a non-US university:** if Microsoft's academic verification doesn't
  recognise the university's email domain/tenant, sign-up fails with "You're not eligible" and
  the fix is a manual eligibility review via Microsoft support (documented in Microsoft's own
  Q&A). This is the single biggest uncertainty in this option — test it early, not at migration time.
- The credit renews each year while you remain an eligible student (re-verification). If you
  neither renew nor move to pay-as-you-go, the students page warns "your subscription and
  products will be disabled" — so durability depends on the yearly renewal actually happening.
- The durable piece is **App Service F1**, an always-free SKU independent of the credit.
  Microsoft's own App Service for Linux pricing page
  (https://azure.microsoft.com/pricing/details/app-service/linux/) lists the Free plan:
  **F1 — Shared (60 CPU minutes/day), 1 GB RAM, 1.00 GB storage, $0.**
  - 60 CPU-minutes/day is ample for a demo link clicked a few times a day.
  - 1 GB storage fits this app (≈46 MB build + a few hundred MB of `node_modules`).
  - The App Service file system (`/home`) is persistent shared storage → **SQLite persists**.
  - Free tier has no Always-On: the app unloads after ~20 idle minutes and cold-starts on the
    next request (seconds, occasionally longer on the shared tier).
  - Deploy from GitHub (Actions or continuous deployment), local Git, or zip.
- Cost of entry is effort, not money: Azure has the steepest setup/learning curve of the three
  finalists, and the eligibility gate is outside our control.

## 3. SnapDeploy (fallback — zero gates, but stateless)

From SnapDeploy's own free-tier documentation (https://snapdeploy.dev/docs/free-tier) and
pricing pages (https://snapdeploy.dev/free-container-hosting):

- "Every account gets the free tier, with **no credit card and no trial clock**"; "The free tier
  is a real tier, not a trial: it never expires and never asks for a card."
- 4 containers per account, each **512 MB RAM / 0.25 vCPU** (AWS Fargate), **100 container-hours
  a month** shared (sleeping time doesn't count), 10 deploys/day, permanent HTTPS address at
  `name.containers.snapdeploy.app`. Sign-up is email or GitHub. Deploys from a GitHub repo with
  a Dockerfile (or a generated one), a public image, or a tarball.
- Sleep: after ~15 idle minutes; "a browser visit brings it back in **about 60 seconds**" — the
  first click gets a 503 wake page and roughly a minute's wait. That is a real risk in front of
  a teacher.
- **The disqualifying detail for a database app**, from their docs' limits table:
  "Persistent disk: **None** — The filesystem resets on redeploy, restart and wake", and
  "Waking starts a fresh copy of the container, so anything written to its filesystem since the
  last start is gone."
  Consequence for this app: the SQLite file reverts to the deployed image on every wake. Because
  this backend **self-seeds on boot**, the demo still opens in its exact intended state — but
  anything created while live (a new account, an admin-added book) is forgotten at the next
  sleep. Acceptable for a pure demo, wrong for anything stateful.
- Vendor risk: SnapDeploy is a young, small platform (its docs are thorough, but it has no
  track record comparable to Railway/Microsoft). Builds run on ARM64 — native modules such as
  better-sqlite3 compile during their build, which works but is slower.

## 4. Back4App Containers — what "60 minutes" actually means (disqualified)

This was the most misleading candidate in blog roundups ("free tier, no time limit"). The
vendor's own pricing FAQ (https://www.back4app.com/pricing/container-as-a-service) does say you
can "spin up your Dockerized software project at no charge (**no credit card required**)", with
0.25 CPU / 256 MB RAM / 100 GB transfer. **But** Back4App's own published guides (September 2026)
state what the free plan does to your address:

- "The limit that matters is the address: on the free plan it is temporary and **expires
  60 minutes after deployment**." (https://www.back4app.com/blog/host-a-static-website-in-a-container)
- The dashboard itself reads: "**URL is temporary and will be live for 60 minutes**"
  (https://www.back4app.com/blog/host-a-flutter-web-app-with-docker)
- "a URL that lives **60 minutes per deploy**; a permanent URL is a paid plan from $5/month"
  (https://www.back4app.com/blog/deploy-node-app-dockerfile-back4app)

So the 60 minutes is the lifetime of the **public URL after each deploy**, not a monthly hour
allowance. Auto-deploy on push is also a paid feature, so every refresh is a manual deploy that
buys one hour of link life. For a link you hand to a teacher, that is a non-starter.

## 5. The rest — checked and disqualified

- **Qoddi** — its own pricing page (https://qoddi.com/pricing/): free covers **static sites
  only** (first 3); app hosting starts at $6/month; and "**A credit or debit card is required to
  verify your account, even when you host only free static sites.**" The "free 512 MB apps"
  claim in roundups is stale.
- **Leapcell** — pricing page (https://leapcell.io/pricing): the free Hobby plan is
  **serverless only** (100,000 invocations, 3 GB-hours/month). A continuously running server is
  a separate paid product ("Persistent Server — Basic Micro, 512 MB, **$7.00/month**"), and
  serverless filesystems are ephemeral, so SQLite cannot persist. No card needed, wrong shape.
- **Northflank** — the Sandbox is genuinely attractive on paper (2 always-on services, up to
  $20/mo of resources, persistent volumes; https://northflank.com/pricing) — but Northflank's
  own billing documentation overrides its "No card needed" marketing: "**all users must add a
  payment method to start creating resources on Northflank, regardless of plan selection**"
  (https://northflank.com/docs/v1/application/billing/add-a-card). Fails the card rule.
- **Koyeb** — its pricing FAQ (https://www.koyeb.com/docs/faqs/pricing): "**We require a credit
  card to prevent fraud and abuse**" (verified with a $29 pre-authorisation hold). Fails.
- **Zeabur** — its own docs (https://zeabur.com/pricing and the subscription docs) show the Free
  plan now covers managing **up to 1 bound external server** (your own machine); containerised
  services are "automatically suspended" on the Free plan, and the shared cluster closed to new
  projects in 2026. There is no free hosted compute left to migrate to.
- **Oracle Cloud Always Free** — technically the strongest free offer in existence (real VMs,
  always on, persistent disks, "Always Free services are available for an unlimited time"), but
  Oracle's own FAQ (https://www.oracle.com/cloud/free/faq/) is explicit: "We use your contact
  information and **credit/debit card information for account setup and identity verification**."
  Fails the card rule — listed only so the trade-off is on record.
- **Fly.io** — its trial documentation (https://docs.fly.io/about/free-trial): the trial is a
  small one-time credit, "**Trial Machines stop automatically after running for 5 minutes**",
  and there is no permanent free tier; a card is required to keep anything running. Fails.
- **Render / Hugging Face** — not re-researched; both were hit first-hand today (Render demanded
  a card at deploy time despite the Free instance; HF Docker Spaces now require PRO).

Out of scope by shape: Vercel/Netlify/Cloudflare Workers (serverless functions — no persistent
SQLite file, no long-running Express server without a rewrite) and self-host panels such as
Coolify (they need a VPS underneath, which is the paid part).

---

## Ranked recommendation — for a class-demo link a teacher must be able to open

### 🥇 1. Stay on Railway — switch to the Free plan when the trial ends
Zero migration: same account, same project, same GitHub connection, same URL. The $1/month
credit is roughly 20–40× this demo's realistic consumption because the service sleeps when
nobody is looking at it and wakes on the next request (seconds, not a minute-long wake page).
It is the **only finalist where SQLite genuinely persists for free** (the included 0.5 GB
volume), so logins, reviews and admin changes survive between visits. No card, ever, per
Railway's own docs. Action list when the trial ends: Plans page → switch to Free → redeploy →
attach the volume for the database → confirm the app re-seeded. And never attach an external
uptime pinger (see §1).

### 🥈 2. Azure for Students → App Service F1 — if the university email verifies
The most institutionally durable option (Microsoft, an always-free SKU, 1 GB RAM, persistent
storage) and the natural "grown-up" home for a university project. It ranks second only because
of gates we don't control: academic verification via the institution's email domain can fail
and need a manual review, the offer needs yearly renewal while enrolled, and Azure is the most
complex setup of the three. Worth testing the sign-up **now**, while Railway is running, so the
answer is known before it's needed.

### 🥉 3. SnapDeploy — the no-gate emergency fallback
If both of the above fail on the day, SnapDeploy takes minutes: email/GitHub sign-up, no card,
permanent URL, no expiry. The price is a ~60-second wake page on a cold click and a database
that resets to the seeded demo state every time the container sleeps — survivable for a demo
(this app self-seeds by design), but it is a fallback, not a home.

**Single best pick: Railway's Free plan.** It is the only candidate that satisfies every hard
requirement *and* keeps the data, it needs no new account or migration, and its one real risk —
the $1 ceiling — is comfortably sized for exactly this workload (a sleeping demo link), with
the failure mode (service pauses until the 1st of next month) being both unlikely at demo
traffic levels and recoverable.
