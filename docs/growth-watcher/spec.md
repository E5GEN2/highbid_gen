# Channel Growth Watcher — feature spec

**Status:** design (mapped 2026-07-22). Not yet built.
**Goal:** catch channels super early (~50–100 subs), track them through their growth
curve over time, and produce (a) a **research dataset** of growth patterns and
(b) **showcase-ready** historical growth stories ("caught at 80 subs → 400K in 9 weeks").
Both goals weighted equally.

---

## Decisions (locked)
- **Primary goal:** research dataset AND showcase, equally — the tiering serves both
  (breadth at T0/T1, depth at T2/T3).
- **Phase-1 track scope:** the **~59,106 channels under 100 subs** (`subscriber_count < 100`).
  Widen to `< 1000` (128,954) later if wanted — it's still nearly free.
- **Quota budget:** a non-issue (see Sizing). A generous config cap
  (`growth_deep_track_max_per_day`, default ~10K) is a safety rail only, so the watcher
  can never dent the discovery enricher's quota (the #1 KPI).

## Sizing (why quota is a non-issue)
- Pool: **11,439 active `youtube_data` keys** × 10,000 units/day (v3 default).
- **T0 liveness** = stats-only `channels.list`, batched 50/call ⇒ **~0.02 units/channel**.
  Scanning all 59K daily ≈ **~1,200 units/day** (≈ one-eighth of a single key). Free.
- **Deep pulse** (stats + `playlistItems.list` + `videos.list`, per-channel, not batchable)
  = **~2 units/channel**. Even 50K deep-pulses/day is <1% of pool capacity.
- Real limiters: **proxy-pool health** (every keyed call needs an xgodo proxy) and
  **how many channels genuinely earn deep-track** (promotion criteria) — NOT quota.

---

## Staged watch ladder
Escalate on traction, demote on death. The daily-cost tiers stay small because only
genuinely-growing channels get promoted into them.

| Tier | Set | Cadence | Fetch | Cost/ch | Promote when |
|---|---|---|---|---|---|
| **T0 Liveness** | all tracked (<100 subs) | ~5d | `reMeasureChannels(recentUploads:false)` — subs + video_count | ~0.02u | `video_count↑` (new upload) OR `subs↑ ≥ X%` |
| **T1 Pulse** | showing life | ~2d | `reMeasureChannels(recentUploads:true, maxRecent:10)` — + recent-uploads avg/median/max views | ~2u | growth-rate over threshold (subs velocity or recent-video views) |
| **T2 Traction** | accelerating | daily | full pulse + per-video view snapshots | ~2u | sustained growth (N consecutive up-days) |
| **T3 Documented** | confirmed risers | daily | full channel + every tracked video → permanent history | ~2u | — (terminal; the showcase set) |

**Demotion:** no life after N T0 scans → `dormant`; a T1/T2 that stalls → demote one tier.

---

## Data model (the core new build)
Nothing in the current 95-table schema stores history — every stats refresh **overwrites**
`niche_spy_channels` in place. Growth tracking needs append-only time-series + a stage state.

### `growth_tracked_channels` (stage state machine)
```
channel_id        TEXT PRIMARY KEY  -- ref niche_spy_channels
stage             TEXT              -- 'liveness'|'pulse'|'traction'|'documented'|'dormant'
next_due_at       TIMESTAMPTZ       -- staleness gate (per-stage cadence)
first_caught_at   TIMESTAMPTZ       -- when enrolled
first_caught_subs BIGINT            -- subs at catch (the "caught at N" number)
growth_score      DOUBLE PRECISION  -- rolling velocity metric that drives promotion
last_subs         BIGINT            -- for delta computation between passes
last_video_count  INT
promoted_at       TIMESTAMPTZ
enrolled_source   TEXT
```
Index: `(stage, next_due_at)` for the due-select; `(growth_score DESC)` for hot ordering.

### `channel_growth_snapshots` (append-only daily channel stats)
```
id SERIAL PK, channel_id TEXT, day DATE, captured_at TIMESTAMPTZ DEFAULT NOW(),
subscriber_count BIGINT, total_views BIGINT, video_count INT,
recent_avg_views BIGINT, stage TEXT, source TEXT
UNIQUE(channel_id, day)          -- idempotent daily capture
INDEX (channel_id, captured_at DESC)
```

### `video_growth_snapshots` (append-only daily per-video stats, T2/T3 only)
```
id SERIAL PK, video_id INT REFERENCES niche_spy_videos(id) ON DELETE CASCADE,
day DATE, captured_at TIMESTAMPTZ DEFAULT NOW(),
view_count BIGINT, like_count BIGINT, comment_count BIGINT
UNIQUE(video_id, day)
INDEX (video_id, captured_at DESC)
```
Deltas/velocity computed at query time via `LAG()` window over these, or denormalized
onto the row if hot. (Model mirrors `niche_spy_saturation`, the only existing time-series table.)

---

## Engine
- **`runGrowthWatcherTick`** — copy `runNicheWatcherTick` (advisory lock 7284120xx +
  stale-`next_due_at`-select + LIMIT batch), but iterate **per stage** with stage-dependent
  cadence. For each due batch call `reMeasureChannels` (stats-only for T0, full for T1+).
- **Snapshot writer** — on every pass, before/alongside the `niche_spy_channels` overwrite,
  INSERT a `channel_growth_snapshots` row (`ON CONFLICT(channel_id,day) DO NOTHING`);
  for T2/T3, also snapshot each tracked video into `video_growth_snapshots`.
- **Promotion/demotion + scoring** — after each pass, recompute `growth_score` (subs
  velocity + recent-video view acceleration), then move `stage`/`next_due_at`.
- **Kill switch + budget** — `admin_config growth_watcher_enabled`,
  `growth_deep_track_max_per_day` cap enforced per tick.
- Runs in the 60s `instrumentation.ts` runAll loop, single-flight via advisory lock.

**Reused as-is:** `reMeasureChannels`, `pullRecentUploadsForChannel`,
`fetchChannelRecentUploads`, `pickRandomActiveYtPair`/`banYtKey`/`getYtPairForThread`,
`ytFetchViaProxy`, `channel_cg_status.discovered_at` (day-0 anchor).

---

## GUI (lives on the channel card → its own page)
- **New route:** `app/(products)/niche/channels/[channelId]/growth/page.tsx` (no per-channel
  detail route exists today).
- **Growth curve:** subs + total-views over time; reuse `NicheTimeline`'s hand-rolled SVG
  convention (no chart lib in repo). Sparkline on the card → full chart on the page.
- **"Catch story" header:** caught at `first_caught_subs` on `first_caught_at` → now X (Nx growth).
- **Per-video trajectories:** view-count-over-time lines for T2/T3 tracked videos.
- **Entry point:** a "Growth" affordance on `components/NicheChannelCard.tsx` (and the
  divergent inline card in `niches/[keyword]/channels/page.tsx` — consolidate or add to both).
- **New endpoint:** `GET /api/niche-spy/channel-growth?channelId=` reading the snapshot tables
  (teach `/api/niche-spy/timeline` a `channelId` filter, or a fresh route).

---

## Phased build
1. **Phase 1 — Capture (highest urgency).** Snapshot tables + `growth_tracked_channels`,
   enroll the 59K <100-sub channels at T0, the liveness tick + daily snapshot-writer.
   *Start recording history immediately — every un-captured day is unrecoverable.*
2. **Phase 2 — Staging.** Promotion/demotion ladder + growth scoring + traction thresholds +
   T2/T3 per-video deep-track + the deep-track budget cap.
3. **Phase 3 — GUI + showcase.** Channel growth page + curves + catch-story + content export
   (pick "growth cases" by Nx-from-catch or absolute milestone).

## Open tunables (decide during build, not blocking)
- **Promotion thresholds:** what counts as "traction" — subs velocity (%/week), absolute
  subs jump, or recent-video view floor. Start simple (subs-growth-rate + new-upload-with-views),
  tune on real data.
- **"Big"/showcase definition:** milestone (crossed 10K/50K subs) vs. multiple (Nx from catch).
- **T0 cadence** (5d?) and **demotion patience** (N dead scans → dormant).
