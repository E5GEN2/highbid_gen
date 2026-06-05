# Novelty × content-gen-rules audit (and integration plan)

**Goal:** turn the novelty feature into the *front end* of an auto-niche-discovery flywheel. Novelty finds isolated high-performing videos → content-gen rules filter them down to commercially-viable seeds → xgodo bots crawl outward via the video-seed feature → fresh videos land in `niche_spy_videos` → next clustering run forms new L1/L2 niches → repeat.

---

## What the novelty feature does today

`/api/admin/novelty/videos` — ranks videos by combined "blue ocean potential":

```
score = novelty_score × COALESCE(peer_outlier_score, 1.0) × LN(1 + view_count)
```

Where:
- `novelty_score` = mean cosine distance to K nearest videos in `niche_video_vectors_combined_v2` (title + thumbnail multimodal embedding). High score = isolated in topic space.
- `peer_outlier_score` = channel's avg_views / median(avg_views in the same subscriber-bucket cohort). High score = channel outperforming peers.
- `view_count` log-damped so a 50M-view video doesn't dominate.

**Current filter knobs** the UI exposes:
- `minViews` / `maxViews`
- `minNoveltyPct` (percentile-based novelty floor, e.g. top 10%)
- `minOutlier` / `maxOutlier`
- `minSubs` / `maxSubs`
- `postedWithinDays`
- `minChannelAge` / `maxChannelAge`
- `type` ('long' | 'short' | 'any')
- `requireOutlier` (toggle to exclude rows without outlier score)
- `sort` mode (`blue_ocean` | `novelty` | `views` | `outlier` | `recency` | `subs_asc` | `channel_age_asc`)

**What it does well:**
- Sound mathematical foundation (cosine distance + log-damped views + peer-relative outlier)
- Already has SOME content-gen-style filters (subs band, channel age, recency)
- Sortable across multiple signal axes for auditing
- Recompute pipeline scales to 390K videos in 10-15 minutes via 20-thread worker pool

---

## Gaps vs. content-gen discovery rules

Content-gen has a stricter rule set (see `data-discovery-rules.json`):

| Rule | What it checks | Novelty endpoint covers? |
|---|---|---|
| **A1 subs band** | 10K ≤ subs ≤ 5M | ✓ via `minSubs`/`maxSubs` (admin must set the band manually) |
| **A2 top-video floor (tiered by channel age)** | 1M/500K/200K/100K based on age tier | ✗ missing — novelty filters by THIS video's views, not the channel's TOP video |
| **A3 ratio ≥ 5×** | top_video_views / subs ≥ 5 | ✗ missing entirely |
| **B1 channel age ≤ 730d** | recently-emerged channels only | ✓ via `maxChannelAge` |
| **B2 top video ≤ 12mo** | channel is currently relevant | ✗ no per-channel top-video age check |
| **C topical / cluster fit** | channel sits in a niche cluster | ✗ not applicable here — we WANT cluster-orphaned videos |
| **D1 videos_indexed ≥ 5** | channel has ≥5 indexed videos | ✗ missing — no per-channel count check |
| **D2 not one-viral-wonder** | median/top ratio ≥ 0.05 | ✗ missing — critical filter we'd want |

**Biggest conceptual gap:** novelty operates **per-video** but content-gen quality filters operate **per-channel**. A novel video on a non-viable channel (5K subs, 3 years old, one viral hit) shouldn't become a seed because:
- The channel can't sustain a niche
- The viral was likely a fluke (algo love that won't repeat)
- Bot effort spent crawling from it would yield noise

For the **niche-discovery seed** use case, we want:
- The VIDEO is novel (isolated in embedding space)
- The CHANNEL passes content-gen quality rules (proves the niche has commercial legs)
- Combined: "novel topic AND proven creator" → high-leverage seed

---

## The integration plan

### New module: `lib/content-gen/seed-candidates.ts`

Wraps `discoverChannels()` from the content-gen pipeline, then for each qualified channel pulls their **highest-novelty video** (not their top-views video, which is what `discoverChannels` returns). The result is a list of seed-candidate videos, each:

- Lives in our DB (`niche_spy_videos`)
- Has a real `novelty_score` (isolated in `combined_v2` space)
- Belongs to a channel that passes A1, A2, A3, B1, B2, D1, D2
- Returns enough info for xgodo bots to start crawling (URL, channel, embedding source)

Ranking formula:
```
seed_score = novelty_score              (isolation)
           × composite_score             (channel quality from content-gen)
           × LN(1 + view_count)          (video traction)
```

### New endpoint: `GET /api/admin/content-gen/seed-candidates`

Params:
- `topK` — how many seeds to return (default 30)
- `minNoveltyPct` — only consider videos in top X% novelty (default 80, i.e. top 20%)
- `topVideoOnly` — if `true`, only allow the channel's #1 top-views video as the seed (default `false`)
- Other channel-band overrides inherited from `discoverChannels`

Response:
```ts
{
  ok, elapsedMs,
  pool: { channels_passing_rules, channels_with_novel_video },
  seeds: Array<{
    video_id, video_url, video_title, video_thumbnail,
    view_count, posted_at, novelty_score, novelty_percentile,
    channel: { /* same shape as DiscoveryCandidate */ },
    seed_score,
    explanation: { isolation, channel_quality, traction }
  }>
}
```

### GUI surface in `/admin → Content Gen`

A third sub-tab — **"Niche Discovery"** — next to the existing Niches + Channel Explorer. Shows the seed candidates as cards:

```
┌───────────────────────────────────────────┐
│ [SEED] novelty 0.94 (top 4%)              │
│ Top video: "Forgotten Sumerian artifacts" │
│ Channel: @TheEnkiCodex                    │
│  subs 27K · age 38d · ratio 25×           │
│  composite_score 0.62                     │
│ Niche label (closest cluster): none       │
│ ▶ Inspect on YouTube                       │
│                  [ Send to xgodo seed ▸ ] │
└───────────────────────────────────────────┘
```

The `Send to xgodo seed ▸` button calls the xgodo dispatch endpoint with the seed URL. xgodo bots crawl the related-video graph, submit candidates back through `/api/niche-spy/video-seed/expand`, and the loop closes.

### The flywheel (end state)

1. Nightly cron: novelty recompute (already exists)
2. Nightly cron: seed candidate refresh (new) — runs the seed-candidates query, persists top-N to a `niche_discovery_seeds` table
3. Admin manually approves seeds (or auto-dispatch for high-confidence)
4. xgodo bots crawl from approved seeds
5. New videos land in `niche_spy_videos`
6. Embedding pipeline computes their vectors
7. Next clustering run forms new L1/L2 niches around the seed territory
8. Those new niches surface in content-gen drafts as fresh listicle material

---

## Implementation order

1. Build `lib/content-gen/seed-candidates.ts` (the core logic)
2. Build `/api/admin/content-gen/seed-candidates` endpoint
3. Verify against real data — check what the seed list looks like, tune thresholds
4. Add the Niche Discovery sub-tab to ContentGenTab
5. Wire the "Send to xgodo seed" button to the existing xgodo dispatch path
6. Later: nightly cron + persistence table + optional auto-dispatch

This commit lands steps 1-3. UI surface and dispatch wiring come after we validate the seed list quality.
