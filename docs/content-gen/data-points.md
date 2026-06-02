# Content-gen data-point inventory (v1)

**Status:** Checkpoint — committed reference for the content-generation system design.
**Source corpus:** 352 fully-analyzed videos in custom niche #2 (Faceless YouTube Niches), 110,587 segments, exported 2026-06-02.
**Owner:** sigadiga@gmail.com
**Last analysis run:** 2026-06-02

---

## Why this document exists

The thesis behind the content-generation system: **a faceless-niche listicle isn't a "video" the viewer buys — it's a delivery vehicle for a list of observable, verifiable claims about real channels.** The viewer's job-to-be-done is "show me N channels I didn't know about, with hard numbers I can sanity-check, so I can decide if any of them are copyable."

Everything else (hook, music, talking head) is packaging. The packaging matters for retention; **the data points are what's actually being sold**.

This inventory enumerates every observable / measurable claim our analyzed corpus shows creators delivering, ranked by how strongly each data point correlates with high view count. It's the schema the generator will fill in.

## How the inventory was built

1. Ran a regex extractor over speech_transcription + visual_description across all 110,587 segments.
2. Classified each match into one of 27 categories spanning channel scale, monetization, time, format, niche, competition, and social signal.
3. Split videos into top-quartile (winners, n=88) and bottom-quartile (losers, n=88) by viewCount.
4. Computed per-category presence rates and (winner_rate / loser_rate) uplift.
5. Mapped each category to availability in our DB (`niche_spy_videos`, `shorts_channels`, `shorts_videos`, `channel_analysis`, vector tables) — what we already have, what's computable, and what's out of scope.

## Decisions baked into v1

1. **"Got X views in N months" growth claims** — computed from `first_video.posted_at` rather than from view-history snapshots. The age math is `(NOW - first_video.posted_at)`, total views from YT API. Loses precision (treats lifetime views as if all accumulated since first upload — fine in practice) but means we ship without building a snapshotting pipeline.
2. **RPM** — pulled from Gemini via the existing PapaiAPI proxy. Per (niche, sub_niche, geography) we cache one `{rpm_low, rpm_typical, rpm_high}` tuple. Generated scripts present the **outcome ($)**, not the math (`views × RPM = $`) — winners hide the calculation (RPM-direct mentions are loser-coded, 0.75× uplift).
3. **Phase 1 = clone-and-improve, Phase 2 = proprietary.** Phase 1 ships scripts that closely mirror Money Groot's "11 Hidden Faceless YouTube Niches Explained" (121k views, 41.9k subs, 2.90× views-to-subs ratio) with the missing winning tricks layered in (Social Blade overlay, $earnings callout, glitch SFX, faster pacing). Phase 2 adds proprietary slots (niche saturation, embedding novelty, cohort growth multiplier) only available in our corpus.

---

## Inventory at a glance

Ranked by **winner uplift** (presence-in-winners / presence-in-losers). Higher = more strongly correlated with high view count. **Phase column:** `P1` = ship in phase 1, `P2` = phase 2, `AVOID` = don't include even though we have it.

| # | Data point | Winner % | Loser % | Uplift | DB ready? | Phase |
|---|---|---:|---:|---:|---|---|
| 1 | `money.yearly` | 6.8% | 1.1% | **3.5×** | derive (RPM × views/yr) | P1 |
| 2 | `channel.upload_rate` | 2.3% | 0.0% | **3.0×** | derive (count / months_active) | P1 |
| 3 | `money.daily` | 18.2% | 8.0% | **2.1×** | derive (RPM × views/day) | P1 |
| 4 | `growth.in_period` | 1.1% | 0.0% | **2.0×** | derive (views / months_active) | P1 |
| 5 | `money.monthly` | 54.5% | 31.8% | 1.7× | derive (RPM × views/mo) | P1 |
| 6 | `video.top_video` | 18.2% | 11.4% | 1.6× | yes (max view per channel) | P1 |
| 7 | `channel.age` | 69.3% | 51.1% | 1.4× | yes (channel.createdAt OR first_video.posted_at) | P1 |
| 8 | `money.per_video` | 8.0% | 5.7% | 1.3× | derive (RPM × avg views) | P1 |
| 9 | `niche.category` | 48.9% | 37.5% | 1.3× | yes (channel_analysis.niche) | P1 |
| 10 | `competition.saturated` | 29.5% | 22.7% | 1.3× | derive (count active channels in niche cluster) | P1 |
| 11 | `competition.zero` | 20.5% | 15.9% | 1.3× | derive (cluster size < N threshold) | P1 |
| 12 | `channel.total_views` | 15.9% | 12.5% | 1.3× | yes (YT API) | P1 |
| 13 | `format.tool_named` | 80.7% | 65.9% | 1.2× | partial (inferable from content_style) | P1 |
| 14 | `channel.video_count` | 94.3% | 83.0% | 1.1× | yes (count from shorts_videos) | P1 |
| 15 | `channel.subscribers` | 95.5% | 87.5% | 1.1× | yes (YT API) | P1 |
| 16 | `money.lump_sum` | 81.8% | 75.0% | 1.1× | derive (any RPM × views figure) | P1 |
| 17 | `time.posting_year` | 83.0% | 76.1% | 1.1× | yes (postedAt) | P1 |
| 18 | `video.views` | 96.6% | 90.9% | 1.1× | yes (direct) | P1 |
| 19 | `format.production_type` | 100% | 100% | 1.0× | yes (channel_analysis.content_style + is_ai_generated) | P1 |
| 20 | `growth.gained_subs` | 5.7% | 5.7% | 1.0× | need history snapshots | OUT |
| 21 | `social.comments` | 2.3% | 2.3% | 1.0× | yes (if collected per video) | P1 |
| 22 | `time.went_viral_in` | 29.5% | 30.7% | 1.0× | derive (posted_at → views velocity) | P1 |
| 23 | `format.video_length` | 15.9% | 20.5% | 0.8× | yes (durationSeconds) | P1 |
| 24 | `money.rpm` (exposed math) | 19.3% | 26.1% | **0.75×** | n/a | **AVOID** |
| 25 | `social.likes` | 4.5% | 8.0% | 0.6× | yes | **AVOID** |
| 26 | `time.posting_window` ("past 90 days") | 18.2% | 35.2% | **0.53×** | derive | **AVOID** |

### Proprietary data points (Phase 2 — only we can compute)

| # | Data point | Source | Uplift signal |
|---|---|---|---|
| 27 | `cohort.saturation_rank` | count of channels in same `niche_tree_clusters` row | — (novel) |
| 28 | `cohort.growth_multiplier` | this channel's views-per-day vs cohort median | — (novel) |
| 29 | `novelty.embedding_distance` | mean cosine distance to K nearest in `niche_video_vectors_combined_v2` | — (novel; we already compute as `novelty_score`) |
| 30 | `cohort.ai_rank` | rank among `is_ai_generated=true` channels in niche by performance | — (novel) |
| 31 | `cohort.first_mover` | channel created within last 60 days AND in top 5% of cluster | — (novel) |
| 32 | `niche.emergence_rate` | new channels entering this niche cluster in last 60 days | — (novel) |
| 33 | `cross_niche.format_import` | this channel's content_style dominant in OTHER cluster, rare here | — (novel; computed from cluster overlap) |

---

## Per-category specs

### 1. `money.yearly` — **3.5× uplift**
**Pattern:** `$X per year`, `$X/year`, `$X yearly`
**Example (winner):** `"$1,100,000 per year"` (InVideo, 1.37M views)
**Why it wins:** Yearly figures sound astronomical (`$1.1M/year`) and hit different emotional registers than monthly. Daily ($/day) also wins by being relatable (achievable target). Monthly is the boring middle.
**Source:** Computed as `niche_rpm × views_per_year`. Views-per-year from `total_views / max(months_active, 1) × 12`.
**Slot role:** **REQUIRED** — at least one of {yearly, daily, monthly} must fire per item; prefer yearly when the number is impressive enough.
**Notes:** Present the outcome `$X/year`, not `views × RPM` math. Round to 2 sig figs (`$1.1M/year`, not `$1,127,433/year` — over-precise reads as suspect).

### 2. `channel.upload_rate` — **3.0× uplift**
**Pattern:** `N videos per day/week/month`, `N a day/week/month`
**Example (winner):** `"3 VIDEO PER DAY"` (387k views)
**Why it wins:** Cadence is the lever every viewer thinks "could I actually do this?" against. "3/day" feels grindable; "1/month" feels possible.
**Source:** `COUNT(shorts_videos) / max(months_active, 1)` per channel.
**Slot role:** **HIGH-LEVERAGE** — fill when channel has ≥4 videos in our index.
**Notes:** Round to integer if ≥1/week; use "1 every N days" if rarer than weekly. Don't show fractional ("0.7 videos/week" → "3 videos a month").

### 3. `money.daily` — **2.1× uplift**
**Pattern:** `$X per day`, `$X/day`, `$X a day`
**Example (winner):** `"$1,000 per day"` (917k views)
**Source:** Computed as `niche_rpm × views_per_day`.
**Slot role:** REQUIRED (one of the $ trio).
**Notes:** Use when daily $ figure is "appealingly round" — $100/day, $1k/day. If the number is awkward ($47.83/day) use yearly or monthly instead.

### 4. `growth.in_period` — **2.0× uplift, underused**
**Pattern:** `got X views in N months/days`, `reached X subs in N period`
**Example (winner):** `"got 200,000 views in 11 months"` (102k views)
**Why it's interesting:** Only 3 corpus videos cite it but it has 2.0× uplift. **Wide-open lane.** Our DB can compute it for any channel where we know `first_video.posted_at`.
**Source:** `(total_views, months_since_first_video) → "X views in N months"` OR `(subs_now, months_since_first_video) → "0 to X subs in N months"`.
**Slot role:** HIGH-LEVERAGE — use on at least 2 of N items per video for variety.
**Notes:** This is the "wow this is recent and scaling" frame. Reserve for channels under 18 months old.

### 5. `money.monthly` — **1.7× uplift**
**Pattern:** `$X per month`, `$X/month`, `$X a month`
**Example (winner):** `"$300 per month"` (1.37M views, used for smaller channel examples)
**Source:** Computed as `niche_rpm × views_per_month`.
**Slot role:** REQUIRED (one of the $ trio). Default fallback when yearly is too small and daily is too odd.

### 6. `video.top_video` — **1.6× uplift**
**Pattern:** `their most popular video`, `their top video`, `the biggest one`
**Example (winner):** `"The top video"` (753k views channel example)
**Source:** `MAX(view_count)` per channel from `shorts_videos`.
**Slot role:** HIGH-LEVERAGE per item — single biggest view-number anchor.
**Notes:** Always pair with the actual view count. Visual: cut to the thumbnail of that video while saying its view count.

### 7. `channel.age` — **1.4× uplift**
**Pattern:** `X months/years old`, `started X months ago`, `created in [year]`
**Example (winner):** `"5 years ago"`, `"11 months ago"`
**Source:** `NOW - first_video.posted_at` (channel.createdAt if available is more accurate; fall back to first-video timestamp).
**Slot role:** REQUIRED — appears in 69% of winners.
**Notes:** Use round phrasing (`almost 2 years old`, `just 6 months old`). "Just X months old" is the framing that drives the "this is recent and replicable" narrative.

### 8. `money.per_video` — **1.3× uplift**
**Pattern:** `$X per video`, `$X a video`
**Example (winner):** `"$70 a video"` (232k views)
**Source:** Computed as `niche_rpm × avg_views_per_video`.
**Slot role:** OPTIONAL — strongest when paired with low video count ("3 videos. $70 each. That's $210 from 3 uploads.")

### 9. `niche.category` — **1.3× uplift**
**Pattern:** Stated niche name (`"Funny stickman fails"`, `"AI revenge stories"`, `"Body Hub uploads health videos"`)
**Source:** `channel_analysis.niche` or `channel_analysis.sub_niche`. Could also use cluster assignment label.
**Slot role:** REQUIRED — every item needs a niche name.
**Notes:** Be specific. "Health" is weak; "ASMR sleep stories" is strong. Pull the most specific tag we have.

### 10-11. `competition.saturated` / `competition.zero` — **1.3× uplift each**
**Pattern:** `low/no/zero competition`, `saturated`, `crowded`
**Source:** Cluster size — if `niche_tree_clusters.video_count < threshold` (e.g. <20) call it "low competition"; > 200 call it "saturated".
**Slot role:** HIGH-LEVERAGE — use as the "why this matters" beat per item.
**Notes:** Cluster size from `niche_tree_assignments` count is the cleanest signal. We can ALSO state our channel count: *"We track 8 channels in this niche."*

### 12. `channel.total_views` — **1.3× uplift**
**Source:** YT API.
**Slot role:** HIGH-LEVERAGE — strong "across the channel" anchor.

### 13. `format.tool_named` — **1.2× uplift**
**Pattern:** ElevenLabs, InVideo, ChatGPT, Midjourney, etc.
**Source:** Inferable from `channel_analysis.content_style` + `is_ai_generated`. Doesn't identify the actual tool unless we infer it from style (e.g. "AI voiceover + Midjourney still images" → name those tools).
**Slot role:** HIGH-LEVERAGE — the "how to start" beat.
**Notes:** Phase 1 can fake this with a heuristic ("AI voiceover" → "ElevenLabs"; "static images + Ken Burns" → "Canva or Pictory"). Phase 2 build a real tool-detection classifier.

### 14-15. `channel.video_count` / `channel.subscribers` — universal, ~1.1× uplift
**Source:** YT API + `shorts_videos` row count.
**Slot role:** REQUIRED — both appear in 90%+ of all videos.
**Notes:** Format as readable (`436K subscribers`, `1.2M subscribers`, `120 videos`).

### 16. `money.lump_sum` — **1.1× uplift**
**Pattern:** `$X` with no time unit (e.g. `"$29,000 just from this video"`)
**Source:** Same RPM math, presented as a one-shot figure.
**Slot role:** HIGH-LEVERAGE — best for "one viral video paid X" framings.

### 17. `time.posting_year` — **1.1× uplift**
**Pattern:** `2025`, `2026`, `in 2024`
**Source:** Current year + reference dates.
**Slot role:** REQUIRED for the framing ("in 2026").

### 18-19. `video.views` / `format.production_type` — universal
**Source:** Direct columns.
**Slot role:** REQUIRED.

### 22. `time.went_viral_in` — 1.0× (neutral)
**Pattern:** `viral in 48 hours`, `30,000 views in 2 days`
**Source:** Velocity calculation if we have post-time view counts.
**Slot role:** OPTIONAL — interesting framing but not winner-coded. Use sparingly.

### 23. `format.video_length` — 0.8× (slight loser-skew)
**Source:** `durationSeconds`.
**Slot role:** AVOID-BY-DEFAULT unless duration is itself the niche differentiator (e.g. "60-second shorts").

### 24. `money.rpm` (exposed math) — **0.75× — AVOID**
**Why:** Winners DO the RPM math silently and present the $ output. Saying "at $3 RPM" out loud reads like a calculator showing its work.
**Slot role:** **DO NOT FILL.** Use the RPM internally; output only the dollar conclusion.

### 25. `social.likes` — **0.6× — AVOID**
**Why:** Like counts are weaker social proof than view counts.
**Slot role:** **DO NOT FILL.**

### 26. `time.posting_window` ("past 90 days") — **0.53× — AVOID**
**Why:** Framing claims as time-windowed makes them sound conditional / hedgy.
**Slot role:** **DO NOT FILL.** Convert to absolute frames: instead of *"got X views in the past 90 days"*, say *"got X views in 90 days"* (drops the hedge).

### 27-33. Proprietary slots (Phase 2)
Sketched at high level; specs TBD when we build the generators.

- `cohort.saturation_rank` — *"4th most-uploaded channel in this niche cluster (47 channels indexed)"*
- `cohort.growth_multiplier` — *"3.2× the views-per-day of the cluster median"*
- `novelty.embedding_distance` — *"This channel's thumbnail style is geometrically isolated — only 3 channels in our index sit within similarity 0.85"*
- `cohort.ai_rank` — *"#2 highest-performing AI-generated channel in this niche"*
- `cohort.first_mover` — *"Created 41 days ago, already top 5% of its cluster"*
- `niche.emergence_rate` — *"28 new channels entered this niche in the past 60 days"*
- `cross_niche.format_import` — *"This format dominates in [other niche]; only 4 channels exploit it here"*

---

## Slot-fill priority for v1 generator

When generating each listicle item, the generator fills slots in this order, dropping earlier when a slot has no data:

```
1. niche.category            (REQUIRED)
2. channel.subscribers       (REQUIRED)
3. channel.video_count       (REQUIRED)
4. channel.age               (REQUIRED, "just N months old" framing if <18mo)
5. video.top_video + views   (HIGH — best single proof anchor)
6. one of: money.yearly OR money.daily OR money.monthly (REQUIRED $ slot — pick by which sounds best)
7. channel.upload_rate       (HIGH if available)
8. growth.in_period          (HIGH — underused, wide-open lane)
9. competition.{zero|saturated} (HIGH — "why this matters" beat)
10. format.production_type   (REQUIRED)
11. format.tool_named        (HIGH — "how to start" beat)
12. niche.category (repeat as visual overlay)
```

Slots 24-26 (RPM exposed math, likes, posting-window hedges) are explicitly excluded from the generation prompt — listed in the AVOID section so future contributors don't add them back.

## Source code references

- Extractor regex set: `/Users/rofe/Desktop/lab/hbgen/highbid_gen/docs/content-gen/data-points.json` (companion file)
- Pattern miner that produced this analysis: `/Users/rofe/Desktop/faceless_pattern_miner.py` (one-off; will move into `lib/content-gen/` when productized)
- Reference video for v1 clone target: Money Groot's *"11 Hidden Faceless YouTube Niches Explained"* (videoId 14563, niche_id 2, 121,507 views) and *"20 Easy Faceless Niches Explained in 17 Minutes"* (videoId 14435, 175,000 views, 4.81× views-to-subs ratio — strongest indie performer in corpus)

## What's NOT in this v1 inventory (intentional)

- **Channel tone / persona analysis** — out of scope for data points; lives in the wrapper template (Money Groot voice).
- **Thumbnail design rules** — separate analysis; this file is about claims-in-video.
- **Title formula** — same (separate file when we get there).
- **Hindi-language data points** — same categories apply; running the extractor on translated Hindi corpus is queued (see backlog).

## Next checkpoints

1. **JSON schema companion** (this commit) — `data-points.json` — machine-readable slot spec for code to consume.
2. **DB query inventory** — for each slot, write the actual SQL. Lands when we start the `lib/content-gen/` module.
3. **RPM-per-niche cache** — table + Gemini-fed seeder. Lands before first generated script.
4. **Channel-history math validation** — sanity-check the "views since first video" math against 3 known channels (compare to what Money Groot states for the same channels).
