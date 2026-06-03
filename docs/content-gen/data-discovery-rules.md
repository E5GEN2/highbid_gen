# Data discovery rules (v1)

**Status:** Checkpoint — committed reference for the channel picker.
**Purpose:** Given a niche cluster, decide WHICH channels make it into a generated listicle. The rules below are reverse-engineered from 679 channel references across 320 English winners in the analyzed corpus.
**Method:** For each listicle video, extracted referenced channels from `visual_description` + `speech_transcription`, parsed the claimed subscriber counts / view counts / channel ages / earnings, computed distributions, and read off the implicit thresholds the listicle creators are using.

---

## TL;DR

A channel passes discovery if it sits in the right size range, has at least one recent viral video, is genuinely young, and isn't a one-hit-wonder. Within those filters, we rank by recency + virality + novelty + cohort-relative growth.

```
Channel picks if ALL of:
  10K ≤ subscribers ≤ 5M
  top_video.view_count ≥ 1M
  top_video.view_count / subscribers ≥ 5  (ratio = recent virality signal)
  channel_age_days ≤ 730  (prefer ≤365, ideal ≤180)
  top_video.posted_at ≥ NOW() - 12 months
  channel sits in the requested niche cluster
  channel.video_count ≥ 5
  channel.median_video_views / channel.top_video_views ≥ 0.05  (rejects one-hit-wonders)

Then rank by composite score (see below) and take top K per niche.
```

---

## Why these numbers — the empirical distributions

### Subscriber count (n=426 references)

| Bucket | Share of picks |
|---|---|
| **<1K** | **0.7%** — never picked, no monetization proof |
| 1K–10K | 11% — rare, only when extreme virality |
| **10K–500K** | **57%** — the sweet spot |
| 500K–5M | 26% — proven winners |
| **>5M** | **5%** — too big, breaks "you could do this" |

**Median: 132K subs.** Floor at 10K (channel has crossed monetization threshold). Cap at 5M (preserves replicability framing).

### Top video views (n=264)

| Bucket | Share |
|---|---|
| <100K | 6% |
| 100K–1M | 27% |
| **1M–10M** | **45%** |
| 10M–100M | 18% |
| >100M | 3% |

**Median: 2.1M.** A channel without at least one 1M+ video basically doesn't get picked. **Hard filter: top_video ≥ 1M views.**

### Channel age (n=108)

| Bucket | Share |
|---|---|
| **<3 months** | **45%** |
| 3–6 months | 14% |
| 6–12 months | 19% |
| 1–2 years | 7% |
| >2 years | 14% |

**Median: 90 days.** *"Brand new AND already viral"* is the dominant narrative pattern. Old-but-big channels rarely featured. **Hard cap: 730 days (2 years). Prefer ≤365.**

### Views-to-subs ratio (n=203)

| Bucket | Share |
|---|---|
| <1× | 12% — mature audience, low recent virality |
| 1–5× | 8% |
| 5–20× | 20% |
| **20–100×** | **30%** |
| **>100×** | **29%** |

**Median: 33×.** Top video reaches 33× past the channel's subscriber base = the algorithm picked them up, recently. **Hard floor: 5×.** Below 5× the channel is mature with no recent breakout.

### Earnings claims (n=89)

| Bucket | Share |
|---|---|
| <$1K/mo | 16% |
| **$1K–10K/mo** | **39%** |
| **$10K–50K/mo** | **37%** |
| $50K–100K/mo | 7% |
| >$100K/mo | 1% |

**Median: $8K/month.** Listicle creators stay in the realistic-aspirational band. This isn't a discovery filter directly — it's a side-effect of the other filters (small-to-mid channels + 1-10M viral × niche RPM = ~$1K-50K/mo earnings).

### Channels per listicle

Median 2, mean 3.9, p75 = 5. **Generated listicles should cover 5-12 channels per video** (matches typical "Top 5"…"Top 12" formats in the corpus).

---

## The discovery rule set, formalized

### A. SCALE filters (hard cuts)

```
A1. 10_000 ≤ channel.subscribers ≤ 5_000_000
A2. max(shorts_videos.view_count WHERE channel_id) ≥ 1_000_000
A3. max(shorts_videos.view_count) / channel.subscribers ≥ 5
```

### B. RECENCY filters (hard cuts)

```
B1. channel_age_days ≤ 730
    where channel_age_days = NOW() - COALESCE(channel.created_at, MIN(shorts_videos.posted_at))
B2. max_top_video.posted_at ≥ NOW() - INTERVAL '12 months'
```

### C. TOPICAL FIT (cluster membership)

```
C1. channel has at least one video assigned to the requested
    niche_tree_clusters.id (via niche_tree_assignments)
```

That's it. **No separate `is_faceless` check** — cluster membership in a faceless-niche cluster already implies it. **No brand-account filter** — content quality speaks for itself; if a brand account produces well-performing faceless content that proves the niche, include it.

### D. PROOF QUALITY (hard cuts)

```
D1. count(shorts_videos WHERE channel_id) ≥ 5
    (excludes one-and-done channels — must have at least 5 uploads)
D2. median(shorts_videos.view_count) / max(shorts_videos.view_count) ≥ 0.05
    (rejects one-viral-wonders — median performance must be at least 5%
     of the top video. engage.one_viral_only was 0.25× loser-coded in the
     listicle corpus, this filter implements that signal.)
```

### E. PROPRIETARY BOOSTS (re-rank, not filter)

These don't exclude — they re-rank candidates that already passed A-D. Phase 2 features that nobody else can compute:

```
E1. cohort.consensus_picks_count
    How often this channel has been referenced in our analyzed listicle
    corpus. Already-popular picks get a small positive weight (they're
    proven), but with diminishing returns above 3 mentions.

E2. cohort.growth_multiplier
    channel.views_per_day / median(cohort.views_per_day) where cohort is
    the same niche cluster.

E3. novelty.embedding_distance
    Mean cosine distance to K-nearest channels in the combined_v2
    embedding space. Geometrically-isolated channels = differentiated
    picks.

E4. niche.emergence_signal
    Channel created in last 60 days AND already in top-5% of its cluster
    by views_per_day. The "they're early AND they're winning" signal.
```

---

## The 3 implicit gates (applied at ASSEMBLY time, not per-channel)

After the rule set returns the top-K candidates per niche, the assembler layer applies these to the FULL list of channels going into one generated video:

### Gate 1: CONSENSUS-PICK CAP

```
For each channel in the assembled list:
  If channel.consensus_picks_count ≥ 5 in our corpus:
    down-weight by 50% on tie-breaks
```

Channels already featured in 5+ other listicles are over-exposed. Useful as "proven picks" but novelty has diminishing returns.

### Gate 2: NICHE-CLUSTER SATURATION

```
For each generated listicle of N niches:
  Each niche gets at most K=3 channels (default K=2 hero+supporting).
  No two niches in the same listicle may overlap on cluster_id.
```

Forces niche diversity per listicle. Without this, the algorithm could return 5 channels from one viral sub-cluster and call it a Top 5.

### Gate 3: SCALE DIVERSITY WITHIN A LISTICLE

```
Within one generated listicle:
  At least 1 channel ∈ [10K, 100K] subs    (small/scrappy)
  At least 1 channel ∈ [100K, 1M] subs     (proven mid)
  At least 1 channel ∈ [1M, 5M] subs       (big winner)
```

Listicles need rhythm — "this tiny channel ... AND this big one ..." narrative variation. If all 10 picks are in the same scale band, the listicle reads flat.

---

## Ranking — the composite score (for ordering passed candidates)

After hard filters pass, rank candidates per niche cluster:

```
score = 0.30 × recency_score
      + 0.25 × virality_score
      + 0.20 × scale_score
      + 0.15 × proof_score
      + 0.10 × novelty_score
      + boost_consensus  (multiplicative bonus, capped at 1.2x)
      − penalty_overpicked (multiplicative penalty, floor at 0.7x)

where:
  recency_score   = exp(-channel_age_days / 365)               # younger = higher
  virality_score  = min(views_to_subs_ratio / 100, 1.0)         # caps at 100x
  scale_score     = bell_curve(subscribers, mean=200_000, sd=400_000)  # sweet spot bias
  proof_score     = min(top_video_views / 10_000_000, 1.0)      # caps at 10M
  novelty_score   = novelty.embedding_distance                  # already 0-1 from our DB
  boost_consensus = 1 + 0.05 × min(consensus_picks_count, 4)    # 1.0 to 1.2
  penalty_overpicked = max(1 - 0.10 × (consensus_picks_count - 4), 0.7)
                                                                # kicks in above 4 picks
```

Weights tuned to favor recency + virality (the dominant signals in the corpus) while preserving novelty as the proprietary lift.

---

## Pseudocode discovery function

```typescript
async function discoverChannelsForNiche(
  nicheClusterId: number,
  targetCount: number = 5
): Promise<DiscoveredChannel[]> {

  // 1. Pull candidates passing hard filters A + B + C + D
  const candidates = await db.query(`
    WITH channel_stats AS (
      SELECT
        c.channel_id,
        c.subscribers,
        c.created_at,
        COUNT(v.id)                      AS video_count,
        MAX(v.view_count)                AS top_video_views,
        MAX(v.posted_at) FILTER (WHERE v.view_count = (
          SELECT MAX(view_count) FROM shorts_videos
          WHERE channel_id = c.channel_id))         AS top_video_posted_at,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v.view_count) AS median_views
      FROM shorts_channels c
      JOIN shorts_videos   v ON v.channel_id = c.channel_id
      JOIN niche_tree_assignments a ON a.video_id = v.id
      WHERE a.cluster_id = $1
      GROUP BY c.channel_id, c.subscribers, c.created_at
    )
    SELECT *
    FROM channel_stats
    WHERE subscribers BETWEEN 10_000 AND 5_000_000        -- A1
      AND top_video_views >= 1_000_000                    -- A2
      AND top_video_views::float / subscribers >= 5       -- A3
      AND EXTRACT(EPOCH FROM (NOW() - created_at))/86400 <= 730  -- B1
      AND top_video_posted_at >= NOW() - INTERVAL '12 months'    -- B2
      AND video_count >= 5                                -- D1
      AND median_views / top_video_views >= 0.05          -- D2
  `, [nicheClusterId]);

  // 2. Enrich with proprietary signals from vector DB + cohort
  const enriched = await Promise.all(candidates.rows.map(async c => ({
    ...c,
    novelty_score: await getNoveltyScore(c.channel_id),
    cohort_growth_multiplier: await getCohortGrowthMultiplier(c.channel_id, nicheClusterId),
    consensus_picks_count: await getConsensusPicks(c.channel_id),
  })));

  // 3. Compute composite score
  const ranked = enriched.map(c => ({
    ...c,
    score: computeCompositeScore(c),
  })).sort((a, b) => b.score - a.score);

  // 4. Return top K
  return ranked.slice(0, targetCount);
}
```

The full listicle assembly then applies Gates 1, 2, 3 across the N×K candidate pool from N niche calls to produce the final pick list.

---

## What's intentionally NOT a rule (and why)

| Filter we did NOT include | Why dropped |
|---|---|
| `aiCategory == 'brand_account'` | We don't have a reliable classifier for this in our DB. If a brand account produces high-performing faceless content, it still proves the niche works — include it. |
| Content-analysis-based SaaS-brand filter | Requires per-channel Gemini analysis we may not have run. Cluster membership + scale band already excludes most pure-marketing accounts. |
| `is_faceless == true` flag | Redundant with cluster membership — if a channel is clustered into a faceless-niche bucket, it's faceless enough. Avoids brittle binary classification. |
| Hard cap on `>5M subs` channels | Already in the Scale filter (A1). Listed as "exclude too-big" in the corpus but the same filter does it. |
| `subscriber_count > video_count` (engagement quality) | Tried this — not a strong corpus signal. Some viral young channels have very few videos. |
| Like-to-view ratio | We may not have this in our DB consistently; it's also noisier than view count alone. |
| Country / region of channel | Listicle creators don't filter by geography (English-speaking audience assumed for all picks). |
| `posted_at` recency per video | Channel age + top-video-recency together cover this. |

---

## Test cases (sanity checks against the rules)

### Case 1: VES STICK (Money Groot's #1 example)
- subscribers: ~437K → ✅ in 10K-5M
- top_video: 29M views → ✅ ≥1M
- ratio: 29M / 437K = **66×** → ✅ ≥5
- age: created Jan 2025 → ~5 months → ✅ ≤730 days
- top video posted within 12 months → ✅
- 122 videos → ✅ ≥5
- (assume consistent performance, ratio holds) → ✅ not one-viral-wonder
- **PASS**

### Case 2: InVideo For Content Creators
- subscribers: ~250K (mid)
- top video: 1.37M views → ✅
- ratio: ~5.5× → ✅ just above floor
- age: brand account, exists >2 years → ❌ FAILS B1 (>730 days)
- **REJECTED on recency** — which is the right outcome even without a brand-account flag, because the rule says "recently emerged AND viral", and InVideo doesn't meet that even though they have viral content.

### Case 3: Productive Peter (consensus pick, 6× in corpus)
- subscribers: 266K → ✅
- viral top video → ✅
- presumably passes hard filters
- consensus_picks_count = 6 → small boost from `boost_consensus`, but might also trigger `penalty_overpicked` if Gate 1 (CONSENSUS CAP) downweighs at 5+
- **PASS but ranked-down** — fair outcome.

### Case 4: A brand-new channel (28 days old, 50K subs, 2M-view debut video)
- subscribers: 50K → ✅
- top video: 2M → ✅
- ratio: 2M/50K = **40×** → ✅
- age: 28 days → ✅ extreme recency bonus
- video count: maybe only 5-8 videos → ✅ passes D1
- BUT: if their median views are <100K (since they only had ONE breakout) → D2 floor of 5% means median / top ≥ 100K / 2M = 5% → barely passes
- **PASS** — exactly the kind of "fresh and breaking" channel listicle creators love.

---

## Next checkpoints (queued)

1. `content-analysis-spec.md` — the per-channel video transcription + meta-extraction step that feeds slots like `niche.category`, `recipe.formula`, `format.production_type`
2. `script-skeleton-class-b.md` — the narrator-text-per-beat template
3. `asset-acquisition-spec.md` — the Playwright + yt-dlp + AI-gen recipes per primitive
4. `pipeline-architecture.md` — service topology, worker queue, state machine
