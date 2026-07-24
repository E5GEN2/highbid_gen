# Seed-selection experiment: `v2_pow` views-forward ranking (A/B)

**Status:** LIVE on the Hetzner box since 2026-07-23 (commit `6c7287a`). Collecting A/B data.

**⚠️ WINDOW EXTENDED → verdict due ~2026-07-30** (was 07-26). Reason: the channel-stats
**enricher was DOWN ~2026-07-23 evening → 2026-07-24 07:40 UTC** (wedged on dead pinned
proxies; recovered when the watchdog cycled to a fresh job that re-paired to live proxies —
see [[reference_spy_key_pools]]). cg-eligibility REQUIRES enrichment, so during the outage
eligibility was starved for **both** arms (as of 2026-07-24 the eligible counts were a
meaningless 1 vs 3). It's not a policy bias (the outage hit both arms), but it starves the
target metric, so any verdict resting on pre-recovery data is contaminated.

**CLEAN-WINDOW CUTOFF for the verdict: only count seeds dispatched AFTER `2026-07-24 08:00 UTC`**
(post-recovery; the outage backlog `missing_subs` 4534→738 is draining, retro-resolving
outage-window seeds, but the cleanest signal is post-recovery seeds given ~3–4 days to mature).
Run the verdict on/after **2026-07-30**.

**Owner action pending (on/after 2026-07-30):** run the verdict query (below, clean-window
variant), decide keep / retune / revert.

**Note on arm ratio:** dispatch is ~5:1 v2_pow:v1_ln (v2_pow is the weighted treatment, v1_ln
the sampled control) — appears by-design, not a bug; both arms are time-interleaved tick-by-tick
so it stays time-controlled. Confirm the ratio is intended when reading the verdict.

---

## Why (the motivating data)

The output KPI (cg-eligible channels/day) had drifted to ~11–16/day and wasn't recovering.
Tracing the funnel proved it was **not** a quality-gate regression and **not** a rate drop —
the eligibility rate has been a stable ~0.15–0.20% of evaluated all week. The lever, without
touching quality gates, is **choosing better seed videos**.

Mining the per-seed lineage (`channel_cg_status.discovered_by_seed_video_id` → the seed, across
~306K channels / 10,488 seeds, with 1,250/1,258 eligible carrying lineage) revealed two strong,
**compounding** signals in the **novelty × views** crosstab (novelty seeds):

| | view_lo (<500k) | view_mid (500k–3M) | view_HI (3M+) |
|---|---|---|---|
| **nov_HI** (≥0.25) | 0.553% | **1.052%** | **1.103%** |
| **nov_mid** (0.15–0.25) | **0.312%** ← 61% of dispatch went here | 0.442% | 0.518% |
| **nov_lo** (<0.15) | 0.194% | 0.213% | 0.690% |

- Eligible-yield rises ~2.4× with seed **views**, ~2.6× with **novelty-at-dispatch**, and they
  compound: `nov_HI × view_mid` ≈ **1.05%** vs the bulk `nov_mid × view_lo` ≈ **0.31%** (3.4×).
- content_gen-sourced seeds yield **0.929%** (2.5× novelty's 0.366% blended) but are supply-limited.
- **The old ranking log-damped views** (`novelty * LN(1+views)`; `LN` flattens 500k→10M into
  13.1→16.1, a 1.2× spread) so it barely distinguished high-view seeds → 61% of dispatch landed
  in the worst quadrant.

## What changed

New ranking policy computed per-candidate in `lib/content-gen/seed-candidates.ts`
(the JS `seed_score` that drives the final top-K selection, NOT the SQL top-500 prefilter, which
is left unchanged so both A/B arms draw from the same candidate pool):

```
isolation      = clamp(novelty_score, 0, 1)
channelQuality = composite (recency/virality/scale/proof — unchanged)

v1_ln  (control)  = isolation * channelQuality * (0.4 + 0.6 * log1p(views)/log1p(10M))
v2_pow (treatment)= isolation^NOV_EXP * channelQuality
                      * (VIEW_FLOOR + (1-VIEW_FLOOR) * min(views/VIEW_TARGET, 1))
```

**Defaults were grid-searched against the 9-quadrant crosstab** to maximize Spearman rank-corr
vs true eligible-yield — NOT just "cranked up":

| param | env var | default | note |
|---|---|---|---|
| NOV_EXP | `HB_SEED_NOV_EXP` | **1.1** | novelty exponent |
| VIEW_TARGET | `HB_SEED_VIEW_TARGET` | **5000000** | views ramp saturates here (linear, not log) |
| VIEW_FLOOR | `HB_SEED_VIEW_FLOOR` | **0.2** | floor multiplier for zero-view seeds |

Grid-search result: v2_pow Spearman **0.867** vs legacy v1_ln **0.833** (higher = ranks seeds
closer to their true yield order). Local validation script logic lived at `/tmp/iter/score-grid.mjs`
(ephemeral; formulas reproduced above). Caveat noted at build time: v2's best/bulk *score* ratio
(~7×) overshoots the true *yield* ratio (~3.5×) — acceptable because rank-ORDER improved and it's
env-tunable; the A/B is the real arbiter.

## The A/B (why it's falsifiable, not a before/after guess)

- `lib/content-gen/seed-scheduler.ts`: **1-in-`HB_SEED_HOLDOUT_EVERY` (default 6) ticks run
  `v1_ln` (control), the rest run `v2_pow` (treatment)**, chosen by a module tick counter. Arms
  interleave minute-by-minute so time/quota swings hit both equally → causal comparison.
- Every dispatched novelty seed stamps, on `niche_discovery_seeds`:
  `select_policy` ('v1_ln' | 'v2_pow'), `view_count_at_dispatch` (BIGINT — frozen at dispatch,
  because live `view_count` drifts upward), `select_score`. content_gen seeds stamp
  `select_policy='content_gen'` (kept out of the v1/v2 comparison).
- Schema: `lib/db.ts` initSchema `ALTER TABLE niche_discovery_seeds ADD COLUMN IF NOT EXISTS ...`
  + `idx_nds_policy(select_policy, dispatched_at)`.

## Verdict query (the whole point — run this to check if the hypothesis was real)

Headline metric = **eligible-per-seed**, `v2_pow` vs `v1_ln`, only seeds dispatched after rollout
(so it's within the same window = time-controlled). A win = v2_pow's `ELIGIBLE_PER_SEED` clearly
> v1_ln's.

```sql
SELECT nds.select_policy,
  COUNT(DISTINCT nds.seed_video_id)                                          AS seeds,
  COUNT(DISTINCT cs.channel_id)                                              AS channels_found,
  COUNT(DISTINCT cs.channel_id) FILTER (WHERE cs.cg_eligible)                AS eligible,
  ROUND(100.0*COUNT(DISTINCT cs.channel_id) FILTER (WHERE cs.cg_eligible)
        /NULLIF(COUNT(DISTINCT cs.channel_id),0), 3)                         AS elig_pct,
  ROUND(COUNT(DISTINCT cs.channel_id)::numeric
        /NULLIF(COUNT(DISTINCT nds.seed_video_id),0),1)                      AS channels_per_seed,
  ROUND(COUNT(DISTINCT cs.channel_id) FILTER (WHERE cs.cg_eligible)::numeric
        /NULLIF(COUNT(DISTINCT nds.seed_video_id),0),3)                      AS eligible_per_seed
FROM niche_discovery_seeds nds
LEFT JOIN channel_cg_status cs ON cs.discovered_by_seed_video_id = nds.seed_video_id
WHERE nds.select_policy IS NOT NULL
  AND nds.dispatched_at > (SELECT MIN(dispatched_at) FROM niche_discovery_seeds WHERE select_policy='v2_pow')
GROUP BY nds.select_policy ORDER BY eligible_per_seed DESC NULLS LAST;
```

Sanity checks while it accumulates:
- Both arms are stamping: `SELECT select_policy, COUNT(*), ROUND(AVG(view_count_at_dispatch)) FROM
  niche_discovery_seeds WHERE dispatched_at > NOW()-INTERVAL '1 day' GROUP BY 1;`
  — v2_pow should show **higher avg views_at_dispatch** than v1_ln (proof the reweighting bites).
- Enough control volume: v1_ln accrues ~1/6 of seeds; if too thin to be significant, lower
  `HB_SEED_HOLDOUT_EVERY` (e.g. 3) temporarily.

## How to tune / roll back (all env-only, no redeploy — set on the box, restart app)

- Soften/strengthen: raise `HB_SEED_VIEW_FLOOR` (less view penalty), lower `HB_SEED_NOV_EXP`
  toward 1.0, or `HB_SEED_VIEW_TARGET` down (rewards mid-view sooner).
- **Full revert to legacy:** `HB_SEED_HOLDOUT_EVERY=1` → every tick uses `v1_ln`. (The stamping
  stays, so no data loss.)
- Box deploy of a code change = rsync + `docker compose build app` + `up -d app` under `/opt/rofe`.

## Files
- `lib/content-gen/seed-candidates.ts` — v1/v2 formulas + env params + `policy` option.
- `lib/content-gen/seed-scheduler.ts` — tick-arm selection + dispatch stamping (novelty @ ~line 432,
  content_gen @ ~line 241).
- `lib/db.ts` — the 3 tracking columns + `idx_nds_policy`.
- Verdict query saved at (session scratchpad) `abtest.sql`; reproduced above.

## Guardrail
High-nov + high-view seeds are rarer, so v2 is a *weighting* not a hard filter — the fleet still
fills, just biased. If seed supply starves (scheduler logs `pool<5`/starvation, dispatch drops),
that's the tradeoff to watch; soften VIEW_FLOOR up before blaming supply.
