# BUG: Growth Watcher never records `total_views` (99.97% NULL)

**Severity:** Medium-high — silent, permanent data loss on an ongoing basis.
**Status:** ✅ **FIXED 2026-07-26** (commit `c9ee473`, deployed + verified same day). Fill rate on freshly-fetched channels jumped 0.03% → **96.5%** (3,942/4,087 in the first post-deploy hour); enricher healthy; 0 int4 `out of range` errors (param cast `::bigint` per the 2026-07-14 incident). Snapshots inherit the column as forecast — view-growth lines become usable ~1 day post-deploy, deep history accrues from today. Historical pre-fix loss remains unrecoverable, as documented below.
**Found:** 2026-07-26 while building the Telegram growth-story broadcast.
**Component:** channel-stats enricher (`app/api/niche-spy/enrich/route.ts`) → Growth Watcher (`lib/growth-watcher.ts`)

---

## Symptom

`channel_growth_snapshots.total_views` is NULL in essentially every row:

| column | filled | of total | rate |
|---|---|---|---|
| `subscriber_count` | 278,106 | 278,106 | 100% |
| `video_count` | 278,084 | 278,106 | 99.99% |
| `recent_avg_views` | 186,201 | 278,106 | 67% |
| **`total_views`** | **74** | **278,106** | **0.03%** |

Not a regression — broken since inception (uniform ~17 filled rows/day across every day sampled; the 74 came from `liveness`/`deep` paths, not the main sweep). By contrast `video_growth_snapshots.view_count` is **100%** filled, so video-level tracking is fine; this is channel-level only.

## Root cause

The value is fetched from YouTube **and then dropped at parse time.** Chain:

1. **`app/api/niche-spy/enrich/route.ts:592`** — the enricher already requests statistics:
   ```
   channels?part=snippet,statistics,contentDetails&id=...
   ```
   Verified live through our proxy — YouTube returns viewCount in this exact call:
   ```json
   "statistics": { "viewCount": "2028401060", "subscriberCount": "2750000", "videoCount": "203" }
   ```

2. **`route.ts:610`** — the response type omits it, so it's never read:
   ```ts
   statistics?: { subscriberCount?: string; videoCount?: string };   // <-- no viewCount
   ```

3. **`route.ts:615-616`** — only two fields are parsed (`subscriberCount`, `videoCount`).

4. **`INSERT INTO niche_spy_channels (...)`** — the upsert column list has **no `total_views`**, so nothing is ever written.

5. → **`niche_spy_channels.total_views` = 378 / 348,687 filled (0.1%)**

6. → **`lib/growth-watcher.ts:132`** reads `total_views` from `niche_spy_channels` and copies it into each snapshot. The watcher is correct; it's faithfully propagating an empty source column.

**The Growth Watcher is not the bug.** The fix belongs in the enricher.

## Impact

- **Growth stories can't show view growth** — the most compelling "this channel is exploding" signal, and the one that *leads* subscriber growth. Broadcast posts silently omit the line.
- Per-channel Growth page (`/niche/channels/[id]/growth`) has no views trend.
- **Historical loss is permanent** — you cannot backfill what a channel's total views *were* last week. Every day of delay adds ~60K snapshots with an unfillable hole.

## Fix (3 lines, zero API cost)

The data is already in the response — no extra call, no extra quota.

1. Add the field to the interface (`route.ts:610`):
   ```ts
   statistics?: { subscriberCount?: string; videoCount?: string; viewCount?: string };
   ```
2. Parse it alongside the others (`route.ts:~616`):
   ```ts
   const totalViews = parseInt(ch.statistics?.viewCount || '0') || 0;
   ```
3. Add to the upsert — column list, VALUES, and ON CONFLICT, using the **same `CASE WHEN > 0` guard** as `subscriber_count`/`video_count` (not COALESCE) so a bad fetch can't zero a good value:
   ```sql
   total_views = CASE WHEN EXCLUDED.total_views > 0 THEN EXCLUDED.total_views ELSE niche_spy_channels.total_views END
   ```

### ⚠️ Critical: cast the parameter `::bigint`

Both `total_views` columns are already `bigint`, **but that is not sufficient.** Per the 2026-07-14 incident (enricher crash-looped for 3.5 days, ~0 KPI), comparing a bare parameter to an int literal makes Postgres infer **int4** for the *parameter* even when the column is bigint:

```sql
-- WRONG: PG types $9 as int4 -> overflow on any channel past 2.147B views
CASE WHEN $9 > 0 THEN $9 ELSE ... END
-- RIGHT:
CASE WHEN $9::bigint > 0 THEN $9::bigint ELSE ... END
```

This is **not theoretical here**: the test channel above is already at **2,028,401,060 views — 94% of the int4 ceiling**. Channel-level totals blow past 2.147B routinely (any mid-size channel), so an uncast param will start throwing almost immediately and can take the whole enrichment pass down with it. Also wrap the write in `.catch` so one bad row can't kill a 200-batch pass.

## Verification after fix

```sql
-- should climb from ~0.1% toward the subscriber_count fill rate (~100%)
SELECT COUNT(*) AS channels, COUNT(total_views) AS views_filled
  FROM niche_spy_channels WHERE last_channel_fetched_at > NOW() - INTERVAL '1 hour';

-- new snapshots should carry it within a day
SELECT day, COUNT(*) rows, COUNT(total_views) filled
  FROM channel_growth_snapshots WHERE day >= CURRENT_DATE - 1 GROUP BY day;
```
Also confirm the enricher stays healthy for >30 min after deploy (`errors` not climbing, `enriched_channels` advancing) — that's the regression signal for the int4 trap.

## Secondary observation (not filed as a bug)

`recent_avg_views` is 67% filled (`niche_spy_channels.recent_videos_avg_views` = 64%). That looks like genuine coverage lag (channels not yet deep-tracked) rather than a dropped field, since the value *is* written when present. Worth a separate look if the Growth page needs it universally.
