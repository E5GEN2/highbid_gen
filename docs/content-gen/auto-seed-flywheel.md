# Auto-seed flywheel — design + implementation

**Status:** Built, ships OFF behind config flags. The perpetual niche-discovery loop: novelty surfaces seeds → scheduler dispatches xgodo bots → bots crawl + embed inline → new videos → novelty rescore → repeat, **without re-collecting the same territory**.

---

## The two perpetual loops (instrumentation.ts, 60s self-scheduler)

```
bots collect + embed (inline via /video-seed/expand — combined_v2 set immediately)
        ↓
LOOP 1  novelty recompute
        - mode=missing every ~15 min → scores new arrivals → fresh candidates
        - scoped mode=all after each crawl batch (reaper) → decays crawled regions
        - nightly full mode=all → safety net
        ↓
LOOP 2  auto-seed scheduler (advisory-locked, fleet-budgeted)
        - findSeedCandidates → ledger dedup → region-lock → cluster group → dispatch
        ↓
bots collect + embed → (repeat)
```

Both gated by config flags (ship OFF), so they're cheap no-ops until enabled.

---

## Dedup model (why we never re-collect the same videos)

| Layer | Rule | Mechanism |
|---|---|---|
| **Video** | A video used as a seed is **never re-seeded** (permanent). Only `status='failed'` rows are re-eligible. | `niche_discovery_seeds` ledger (PK = seed_video_id) |
| **Region** | While a cluster is being crawled, **no new seeds dispatch into it**. | `agent_niches.status='crawling'` keyed by `origin_cluster_id` |
| **Decay** | After a crawl lands, the region is re-scored so the now-dense seed's novelty drops → it falls below the cutoff on its own. | reaper → scoped `recomputeAllNovelty({videoIds, includeNeighbors})` |

The elegant part: there is **no time-based cooldown**. A region is locked only *while crawling*; the post-crawl rescore then decides re-eligibility on merit. New trends that appear in an old neighbourhood surface as **new video_ids** (their own fresh candidates), never needing the old seed re-dispatched.

The decay rescore is robust to xgodo-side behaviour: it rescopes from `seed_video_id + current K-neighbours` (which now include freshly-collected videos), so it works regardless of how the bot keys its `/video-seed/expand` calls.

---

## Tables

- **`niche_discovery_seeds`** (ledger): `seed_video_id PK, seed_url, niche_id, origin_cluster_id, status(pending|crawling|done|failed), task_ids[], novelty_at_dispatch, discovered_count, dispatched_at, completed_at, rescored_at`
- **`agent_niches`** += `status(active|crawling|exhausted), origin_cluster_id, last_seeded_at`

---

## Scheduler tick (lib/content-gen/seed-scheduler.ts)

1. Gate on `auto_seed_enabled` + advisory lock (`pg_try_advisory_lock`).
2. Budget: `free = MAX_SEED_THREADS − seed-tasks-in-flight`. Bail if 0.
3. `findSeedCandidates(topK=60, minNoveltyPct)`.
4. Drop `seed_video_id` already in ledger (status ≠ failed).
5. **Starvation guard**: if survivors < 5 and pct > 50, lower the novelty floor one step (persisted) and re-pull.
6. Look up each survivor's effective cluster (L2 latest subdivide → L1 latest global); drop those whose cluster is currently `crawling`.
7. Group by cluster (orphans = singletons). One seed (top score) per cluster per wave.
8. Dispatch up to `MAX_SEEDS_PER_TICK`, `THREADS_PER_SEED` each, within free budget. Mint a niche per group, mark it `crawling`, write the ledger row.

## Reaper tick

1. Niches still `crawling` whose nicheId has **no live xgodo task** = finished.
2. Scoped rescore: `recomputeAllNovelty({videoIds: seedIds + discovered, includeNeighbors})`.
3. Backfill `discovered_count`, mark ledger rows `done`, release niche (`exhausted` if it yielded <3, else `active`).

---

## Config defaults (admin_config — confirmed with operator)

| Key | Default | Meaning |
|---|---|---|
| `auto_seed_enabled` | **false** | scheduler master switch (ship OFF) |
| `novelty_auto_recompute_enabled` | **false** | recompute loop master switch |
| `auto_seed_max_threads` | 10 | fleet slots reserved for discovery |
| `auto_seed_threads_per_seed` | 1 | one crawl per seed URL |
| `auto_seed_max_seeds_per_tick` | 5 | dispatch pacing |
| `auto_seed_min_novelty_pct` | 80 | top-20% novelty floor (auto-lowers to 70 on starvation) |
| `auto_seed_loop_number` | 14 | crawl depth per task |
| `auto_seed_interval_minutes` | 30 | scheduler cadence |
| `novelty_recompute_interval_minutes` | 15 | mode=missing cadence |

Rescore cadence: **after each crawl batch + nightly full sweep**.

---

## Control surface

- **Admin → Novelty tab**: "Auto-seed scheduler" panel — Enable/Disable scheduler, Recompute ON/OFF, status (crawling/done/failed ledger counts, live niches, novelty floor), Run scheduler / Run reaper now (manual triggers), recent dispatches list.
- **`GET /api/admin/content-gen/auto-seed`**: config + ledger + niches + recent dispatches.
- **`POST /api/admin/content-gen/auto-seed`**: `{config:{...}}` to set flags, `{action:'run_scheduler'|'run_reaper'}` to fire a tick manually.

---

## Follow-ups (not blocking)

- Thread `nicheId` into `/api/niche-spy/video-seed/expand` so discovered videos are tagged to the niche in `niche_seed_expansions` (improves `discovered_count` accuracy + later attribution). Needs the bot to send it; the decay rescore already works without it.
- Reuse an existing cluster-niche (`origin_cluster_id` match) instead of minting a fresh niche each wave, for nicheId stability across cycles.
- Exhaustion signal from `niche_seed_expansions.similarity` distribution (p50<0.45 ∧ p95<0.60 → niche sampled-dense).
