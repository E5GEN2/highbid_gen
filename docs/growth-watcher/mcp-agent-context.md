# MCP agent context — Channel Growth Journeys (rofe.ai)

> Paste this whole document to the MCP agent builder as the agent's domain context.
> It contains the mission, the data model, the **non-obvious methodology required to
> get correct answers**, ready-to-run SQL, and the report shapes expected.

---

## 1. Mission

rofe.ai runs a **Channel Growth Watcher**: a longitudinal study that catches YouTube
channels while they are tiny (often 0–10 subscribers) and records their growth
**every single day** — subscribers, video count, and per-video view counts — so the
*journey* is documented step by step, not just its endpoints.

The agent's job is to answer questions about those journeys and produce detailed
reports, e.g.:

- "Show me every channel that went from under 10 subs to 100+."
- "What happened to the channels we caught at 0–10 subs?"
- "Which video drove the subscriber jump for channel X?"
- "What do the breakout channels have in common?"
- "Which tracked channels are accelerating right now?"

Data collection began **2026-07-22** and is intended to run for **a year+**. The
dataset grows daily; never assume it is static, and always report the window covered.

---

## 2. Data model (Postgres, main DB)

### 2.1 `growth_tracked_channels` — one row per tracked channel (current state)
| column | type | meaning |
|---|---|---|
| `channel_id` | text PK | YouTube channel id (join key everywhere) |
| `stage` | text | `liveness` → `pulse` → `traction` → `documented`, or `dormant` |
| `first_caught_subs` | bigint | subs when enrolled — **⚠ often STALE, see §3.1** |
| `first_caught_at` | timestamptz | enrollment time |
| `last_subs`, `last_video_count` | bigint/int | latest observed values |
| `growth_score` | double | subs gained since catch (**inherits the stale-baseline flaw**) |
| `showed_life` | boolean | ever grew since catch |
| `up_days` | int | consecutive scans with subs increasing |
| `dead_scans` | int | consecutive scans with no movement |
| `last_scanned_at`, `next_due_at` | timestamptz | scan bookkeeping |

**Stage meanings:** `liveness` = wide net, stats-only daily scan. `pulse` = showed
life (new upload or subs jump) → gets recent-uploads + per-video pull. `traction` =
sustained 7-day velocity. `documented` = confirmed riser (sticky). `dormant` = no
life for many scans (re-checked weekly, auto-resurrects on any movement).

### 2.2 `channel_growth_snapshots` — append-only DAILY channel history ⭐
| column | type | meaning |
|---|---|---|
| `channel_id` | text | → `growth_tracked_channels` / `niche_spy_channels` |
| `day` | date | **UNIQUE(channel_id, day)** — exactly one row per channel per day |
| `subscriber_count` | bigint | subs that day |
| `video_count` | int | uploads total that day (delta ⇒ new uploads) |
| `total_views`, `recent_avg_views` | bigint | channel totals |
| `stage`, `source` | text | stage at capture; `source` = `liveness` \| `deep` |

**This is the primary table for journeys.** Every value here is a real observation.

### 2.3 `video_growth_snapshots` — append-only DAILY per-video history ⭐
| column | type | meaning |
|---|---|---|
| `video_id` | int | → `niche_spy_videos.id` |
| `day` | date | **UNIQUE(video_id, day)** |
| `view_count`, `like_count`, `comment_count` | bigint | that day's values |

Populated only for **deep-tracked** channels (pulse+ and the genesis <25-sub cohort),
so coverage is partial by design — always report coverage alongside conclusions.

### 2.4 Supporting tables
- `niche_spy_channels` (PK `channel_id`): `channel_name`, `channel_avatar`,
  `subscriber_count`, `video_count`, `channel_created_at` (⇒ channel AGE),
  `uploads_playlist_id`.
- `niche_spy_videos` (PK `id`): `channel_id`, `title`, `url`, `thumbnail`,
  `view_count`, `posted_at` (upload date), **`is_short` boolean** (≤61 s ⇒ Short;
  NULL until backfilled).
- `channel_cg_status`: `discovered_at` = when the channel first entered the corpus.

---

## 3. ⚠ METHODOLOGY — read before writing any query

Naive queries against this data give **wrong answers**. These rules are mandatory.

### 3.1 THE STALE-BASELINE TRAP (most important)
`first_caught_subs` is the **stored** subscriber count at enrollment, which for
previously-collected channels can be **months out of date**. The first fresh scan
then "corrects" it in one step.

Example: `WALTER | KNOW YOUR RIGHTS` shows `first_caught_subs = 56` and `last_subs =
49,700`. **We did not watch it grow 56 → 49,700.** It was already at ~49K; 56 was a
stale value. Reporting that as an 888× journey is **false**.

**Rules:**
- ❌ Never compute growth as `last_subs − first_caught_subs`.
- ❌ Never rank/report by `growth_score` (same flaw).
- ✅ Always measure **snapshot-to-snapshot** in `channel_growth_snapshots`, where
  both endpoints are real observations.
- ✅ To identify a genuine journey, require the first→second snapshot jump to be
  small (`s2 − s1 < 50`), which excludes the correction artifact. A stricter form
  requires the channel to be ≤10 subs on **two consecutive** scans.

### 3.2 Exclude non-organic channels
Always filter: `channel_name NOT ILIKE '% - Topic'` (auto-generated music channels)
and `NOT ILIKE '%VEVO'`. For "real content" questions also exclude content farms
(e.g. `video_count > 500` with flat subs — see §5.4).

### 3.3 Detect purchased/bot subscribers
Real growth is **noisy** (wobbles day to day). A count frozen *exactly* for days, or
a large spike followed by a crash, indicates purchased subs or a YouTube purge.

Confirmed example: `K9 Loyalty Tales` → `4→9→25→1720→1720→30→34` (spike, purge,
partial recovery). Flag such patterns; do **not** present them as successes.

### 3.4 Shorts vs long-form
Shorts views are cheap (algorithmic reach); long-form views convert to subscribers
far better. Segment by `niche_spy_videos.is_short` whenever discussing views→subs.
`is_short` is NULL for un-backfilled rows — report coverage, don't assume.

### 3.5 Always state the window and the base rate
The dataset starts **2026-07-22**. Growth is a fat-tail lottery: ~78% of tiny
channels are flat, a tiny fraction explode. Averages are misleading — report
distributions, counts, and the tail.

---

## 4. Canonical SQL

### 4.1 Journey cohort (genuine, artifact-free) — the workhorse
```sql
CREATE TEMP TABLE journeys AS
WITH s AS (
  SELECT channel_id,
         (ARRAY_AGG(subscriber_count ORDER BY day ASC))[1]  AS s1,
         (ARRAY_AGG(subscriber_count ORDER BY day ASC))[2]  AS s2,
         (ARRAY_AGG(subscriber_count ORDER BY day DESC))[1] AS s_last,
         MAX(subscriber_count) AS smax,
         COUNT(*) AS days,
         STRING_AGG(subscriber_count::text, '->' ORDER BY day) AS series
    FROM channel_growth_snapshots
   WHERE subscriber_count IS NOT NULL
   GROUP BY channel_id
  HAVING COUNT(*) >= 2)
SELECT s.*, sc.channel_name,
       (NOW()::date - sc.channel_created_at::date) AS age_days
  FROM s JOIN niche_spy_channels sc USING (channel_id)
 WHERE s.s1 BETWEEN 0 AND 10            -- caught tiny (first FRESH reading)
   AND (s.s2 - s.s1) < 50               -- excludes the stale-baseline artifact
   AND sc.channel_name NOT ILIKE '% - Topic'
   AND sc.channel_name NOT ILIKE '%VEVO';
```
Then: `SELECT * FROM journeys WHERE smax >= 100 ORDER BY smax DESC;` = the
**0-10 → 100+ journeys**. `series` renders the day-by-day climb directly.

### 4.2 Daily deltas for one channel
```sql
SELECT day, subscriber_count,
       subscriber_count - LAG(subscriber_count) OVER (ORDER BY day) AS subs_delta,
       video_count,
       video_count      - LAG(video_count)      OVER (ORDER BY day) AS uploads_added
  FROM channel_growth_snapshots
 WHERE channel_id = $1 ORDER BY day;
```

### 4.3 Attribution — which video drove the growth
```sql
SELECT v.title, v.is_short, v.posted_at::date AS posted,
       STRING_AGG(vs.view_count::text, '->' ORDER BY vs.day) AS view_series,
       MAX(vs.view_count) - MIN(vs.view_count)               AS views_gained
  FROM video_growth_snapshots vs
  JOIN niche_spy_videos v ON v.id = vs.video_id
 WHERE v.channel_id = $1
 GROUP BY v.id, v.title, v.is_short, v.posted_at
 ORDER BY views_gained DESC;
```
Cross-reference upload dates and view surges against the sub-delta days from §4.2.

### 4.4 Outcome distribution of the tiny cohort
```sql
SELECT CASE WHEN s_last = s1 THEN 'flat'
            WHEN s_last < s1 THEN 'declined'
            WHEN s_last < 100 THEN 'grew, under 100'
            WHEN s_last < 1000 THEN 'crossed 100'
            ELSE 'crossed 1K' END AS outcome,
       COUNT(*) FROM journeys GROUP BY 1 ORDER BY 1;
```

---

## 5. Established findings (baseline as of 2026-07-29, 8 days of data)

Report these as **provisional** and re-verify against live data.

1. **21 genuine 0-10 → 100+ journeys** documented, and the count is climbing
   (+7 in a single day) as channels accumulate history.
2. **Upload cadence is the strongest correlate.** Videos posted in the window vs
   share of channels gaining subs: none → 13.6%; 1-2 → 45.6%; 3-5 → 67.7%;
   **6+ → 72.4%** (avg +22.5 subs). Caveat: partly selection — channels posting
   nothing are often abandoned.
3. **Rising video views predict sub growth (~2.8× lift):** channels whose videos
   gained views grew subs 29.9% of the time vs 10.8% when views were flat.
4. **Youth wins.** Channels ≤30 days old gained subs 45.3% of the time vs 15.1%
   for 91-365 days — there is a "stagnation valley" after ~3 months.
5. **Niche signal: faceless short-drama dominates.** 8 of the 21 breakouts are
   explicitly short-drama (Dark Revenge Drama, Eve Drama, Flash-marriage drama,
   Mango Short Drama World, Honey & Heartbeats, Kiss & Tell, Moonlit Drama,
   StarlightDrama77), plus story/mystery adjacents. Most are 10-35 days old.
6. **Base rate:** ~78% of tiny channels stay flat; escaping 0-10 → 100+ is rare
   (~0.1%/week). It is a fat-tail phenomenon.
7. **Long-form edges Shorts** on conversion, but the margin is not yet conclusive.

Reference journeys (verbatim daily series):
```
File 21              5→6→6→10→38→174→418→593
The Descent Record   4→6→15→31→48→140→169→250   (14-day-old channel)
Dark Revenge Drama   2→2→12→37→297               (20-day-old channel)
Narcosia             4→14→78→115→160             (10-day-old channel)
K9 Loyalty Tales     4→9→25→1720→1720→30→34      ⚠ bot-sub purge, NOT a success
```

---

## 6. Report style expectations

- **Show the actual daily series** (`4→6→15→31→48→140`) — the step-by-step climb is
  the product, not summary statistics.
- **Always state the observation window** and how many days of history exist.
- **Separate genuine journeys from artifacts** and say which rule was applied.
- **Attribute when possible**: pair sub jumps with the uploads/view surges that
  preceded them.
- **Flag suspicious patterns** (frozen counts, spike-then-crash) rather than
  ranking them as wins.
- **Quantify honestly**: give counts and distributions, not just averages; state
  when a sample is too small or a window too short to conclude.
- Prefer channel **age** and **upload cadence** as explanatory variables — they are
  the strongest signals found so far.
