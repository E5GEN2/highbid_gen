# Agents feature audit — adding video-URL-seed mode

**Context:** xgodo's YouTube niche-spy bot can now start from a **seed video URL** (crawl the suggested-video graph, score candidates against the seed via `/api/niche-spy/video-seed/expand`) instead of only from a **keyword** (search YouTube for the keyword, score results). The Agents admin feature — deploy form, monitor, thermostat, cron — is hard-coupled to `keyword` as the unit of work and identity. This audit enumerates every coupling point and the change needed at each.

---

## Current architecture: `keyword` is the unit of everything

```
[Admin Deploy form]  keyword + threads + apiKey + rofeAPIKey + loopNumber
        │                    + maxSearchResults + maxSuggestedResults
        ▼
POST /api/admin/agents
   taskInput = { keyword, apiKey, loopNumber,
                 maxSearchResultsBeforeFallback,
                 maxSuggestedResultsBeforeFallback, rofeAPIKey }
        ▼
deployBatch(token, jobId, { keyword, threads, taskInput }, snapshot)
   - warm-device pin: match bucket.lastNiche == keyword
   - submit N xgodo planned tasks with the taskInput JSON
   - record agent_planned_pins(keyword, device_name)
        ▼
xgodo bot picks up planned task → reads input.keyword
   → searches YouTube → scores against keyword (old) OR
   → (NEW) reads input.seedUrl → crawls suggestions → POSTs to
     /api/niche-spy/video-seed/expand

[Monitor]  GET /api/admin/agents
   fetchRunningTasks / fetchPlannedTasks
   extractKeyword(planned_task.input) = input.keyword || search_query || searchQuery
   group byKeyword → byKeyword[]

[Thermostat]  cron → agent-thermostat.ts
   iterate agent_thread_targets(keyword UNIQUE, target_threads)
   deploy diff with the same keyword taskInput shape

[Tables]
   agent_task_log(task_id PK, keyword NOT NULL, ...)
   agent_thread_targets(keyword UNIQUE, target_threads, enabled, ...)
   agent_planned_pins(planned_task_id PK, keyword NOT NULL, device_name, ...)
   niche_seed_expansions(seed_url, candidate_url, similarity, task_id, keyword?)
```

**The `keyword` string is simultaneously:** the deploy input, the xgodo task-input field, the monitor grouping key, the warm-device pin key, the thermostat target identity, the task-log key, the pin key, and the seed-expansion grouping label.

---

## The new mode in one line

A URL-seed bot's xgodo planned-task `input` carries a **seed video URL** instead of a search keyword. Everything downstream that reads `input.keyword` and everything that groups/pins/targets by keyword must learn a second identity: the seed.

---

## Gap analysis — every keyword touchpoint

| # | Location | Today | Needs |
|---|---|---|---|
| 1 | `app/admin/page.tsx` Deploy form (~7778) | single `keyword` text input | a mode toggle: **Keyword** \| **Video seed**; when Video-seed, a `seedUrl` input (+ optional human label) replaces the keyword field |
| 2 | `app/admin/page.tsx` `deployAgents()` (~7658) | validates `keyword.trim()`, posts `{keyword,...}` | branch on mode; post `{mode:'seed', seedUrl, label?, ...}` for seed mode |
| 3 | `POST /api/admin/agents` (~111) | `if (!keyword) 400`; builds `taskInput={keyword,...}` | accept `{mode, seedUrl, label}`; build seed taskInput `{seedUrl, ...}` (field name per xgodo contract — see Open Questions); pass an identity to deployBatch |
| 4 | `lib/agent-deploy.ts` `DeployBatch.keyword` (~68) | `keyword` is the batch identity + pin key | rename concept to `workUnitKey` (the identity) while keeping a human `label`. Warm-device pinning still works if buckets carry the seed identity (xgodo writes `lastNiche` — does it write the seed too? see Open Questions) |
| 5 | `lib/xgodo-tasks.ts` `extractKeyword()` (~28) | reads `input.keyword \|\| search_query \|\| searchQuery` | also read `input.seedUrl \|\| input.seed_url`; return a normalized identity (seed videos labeled e.g. `seed:<videoId>` or the human label) so the monitor can group them |
| 6 | `lib/xgodo-tasks.ts` `RunningTaskInfo.keyword` / `PlannedTaskInfo.keyword` (~13,20) | typed `keyword: string` | keep field name for back-compat OR add `workUnit: { kind: 'keyword'\|'seed', key, label, seedUrl? }` |
| 7 | `GET /api/admin/agents` monitor (~73) | `byKeyword[]` grouping | group by the normalized identity; surface seed rows with their label + seedUrl so the UI can show "▶ seed: How BIG is THE BOILED ONE" instead of a raw URL |
| 8 | `lib/agent-thermostat.ts` (~107,134) | targets keyed by `keyword`; builds keyword taskInput | thermostat targets must support seed work-units: build the seed taskInput when the target is a seed; pin + deploy the same way |
| 9 | `agent_thread_targets` table (~1265) | `keyword TEXT UNIQUE` | add `work_kind TEXT DEFAULT 'keyword'`, `seed_url TEXT`, `label TEXT`. The unique key becomes (work_kind, COALESCE(keyword, seed_url)). Keyword rows unaffected (work_kind='keyword'). |
| 10 | `agent_task_log` table (~1251) | `keyword TEXT NOT NULL` | relax to allow seed identity: add `work_kind`, `seed_url`, `label`; keep `keyword` nullable-or-reused-as-identity. Simplest: store the normalized identity string in `keyword` and add `seed_url`/`label` columns for display. |
| 11 | `agent_planned_pins` table (~1288) | `keyword TEXT NOT NULL` | same — pin identity becomes the work-unit key; add `seed_url` for traceability |
| 12 | `app/admin/page.tsx` AgentsTab monitor cards (~7744) | per-keyword cards + `addThread(keyword)` | render seed cards distinctly (thumbnail + label); `addThread` keys off the work-unit identity |
| 13 | `/api/admin/agents/targets` CRUD (~24,42) | `{keyword, targetThreads, enabled}` | accept `{workKind, keyword?, seedUrl?, label?, targetThreads, enabled}`; upsert/delete on the composite identity |
| 14 | `niche_seed_expansions.keyword` (~950) | optional grouping label | already seed-aware (has seed_url); just ensure the deploy passes a consistent `keyword`/label so the admin live feed groups a seed-bot's submissions together |

---

## The clean abstraction: "work unit"

Rather than bolting `seedUrl` everywhere alongside `keyword`, introduce a **WorkUnit** concept used uniformly:

```ts
type WorkUnit =
  | { kind: 'keyword'; key: string;  label: string }              // key === keyword
  | { kind: 'seed';    key: string;  label: string; seedUrl: string }; // key === `seed:<videoId>`
```

- `key` — the stable identity string used for grouping, pinning, targets, logs.
  - keyword: the keyword itself (lowercased)
  - seed: `seed:<videoId>` derived from the seed URL (stable even if URL has tracking params)
- `label` — human display string (the keyword, or a title/operator-supplied name for seeds)
- `seedUrl` — only for seeds; the canonical URL the bot starts from

Everything keyword-keyed today becomes work-unit-keyed. Keyword rows are just `{kind:'keyword', key:keyword, label:keyword}` — zero behavior change for existing keyword deploys.

---

## Required changes, in dependency order

### Phase 1 — backend plumbing (no UI yet)
1. **`lib/xgodo-tasks.ts`**: extend `extractKeyword` → `extractWorkUnit(input)` returning `{kind, key, label, seedUrl?}`. Keep `extractKeyword` as a thin wrapper (`.label`) for callers not yet migrated.
2. **`lib/agent-deploy.ts`**: `DeployBatch` gains `workKind` + `seedUrl?`; pin/record using `key`. Bucket-niche matching: if seed mode, match on whatever field xgodo writes for the seed (Open Question).
3. **DB migrations** (idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS`):
   - `agent_thread_targets`: `+ work_kind`, `+ seed_url`, `+ label`; drop the bare `keyword UNIQUE`, add composite unique index on `(work_kind, COALESCE(keyword,''), COALESCE(seed_url,''))`.
   - `agent_task_log`: `+ work_kind`, `+ seed_url`, `+ label`.
   - `agent_planned_pins`: `+ seed_url`.
4. **`POST /api/admin/agents`**: accept `{mode, seedUrl, label}`; build the seed taskInput; pass workUnit to deployBatch.

### Phase 2 — monitor + thermostat
5. **`GET /api/admin/agents`**: group by work-unit key; return `byWorkUnit[]` (keep `byKeyword` alias populated from keyword-kind units for back-compat).
6. **`lib/agent-thermostat.ts`**: iterate targets of both kinds; build the right taskInput per kind.
7. **`/api/admin/agents/targets`**: composite-identity CRUD.

### Phase 3 — UI
8. **AgentsTab Deploy form**: mode toggle; seed-URL input with a "fetch title" affordance (optional) to auto-fill the label; validation per mode.
9. **AgentsTab monitor**: seed cards with thumbnail + label; `addThread` by work-unit.
10. **Wire-through from Content-Gen / Novelty**: a "Send to xgodo seed" button on a seed candidate posts `{mode:'seed', seedUrl, label}` to `/api/admin/agents` — closes the niche-discovery flywheel.

---

## Open questions — RESOLVED (xgodo planned-task composer screenshot, 2026-06-05)

The xgodo niche-spy planned-task input schema is now confirmed:

```
seedUrl, apiKey, loopNumber, maxSuggestedResultsBeforeFallback, rofeAPIKey, nicheId
```

1. **Seed URL field name** → **`seedUrl`** ✓
2. **keyword vs seedUrl** → **mutually exclusive; seed mode has NO keyword.** Video URL is the only entry point. Also note `maxSearchResultsBeforeFallback` is GONE in seed mode (no search step — only suggestion-graph crawl), leaving `maxSuggestedResultsBeforeFallback`.
3. **Grouping identity** → **`nicheId`** (rofe-generated). Several seed URLs that belong to the same niche share one nicheId. This REPLACES `keyword` as the work-unit key — it's an opaque identity, not the work content. The human label lives in `agent_niches`. (Warm-device pinning now keys on nicheId; if the bot's bucket doesn't carry it, pinning degrades to unpinned — the existing graceful fallback.)
4. **Knobs** → `loopNumber` + `maxSuggestedResultsBeforeFallback` only. No `maxSearchResults`, no `maxHops`/`minSimilarity`.
5. **Termination** → runs **`loopNumber` loops**, no similarity-floor self-termination. No `minSimilarity` deploy knob needed.

### Revised model (simpler than the WorkUnit sketch above)

Identity migrates `keyword → nicheId`. The distinction:
- `keyword` WAS both the identity AND the work content (the search term).
- `nicheId` is ONLY the identity; the work content is the per-task `seedUrl` (which can differ across tasks within one niche).

So a niche (nicheId) has 1+ seed URLs; each seed URL gets N threads; everything groups by nicheId. `deployBatch` needs **zero change** — it treats its `keyword` parameter as an opaque grouping/pin key, so passing the nicheId there Just Works.

---

## Backward-compat guarantee

Every keyword deploy keeps working untouched: `work_kind='keyword'`, `key=keyword`, `label=keyword`, `seed_url=NULL`. The composite unique index degenerates to the old `keyword UNIQUE` for keyword rows. The monitor's `byKeyword` alias stays populated. No migration of existing rows required — only additive columns + a wider unique index.

---

## Recommendation

Do **Phase 1 + the Open-Questions resolution together**: the field-name and bucket-write answers determine the exact taskInput shape and pinning match, which are the load-bearing details. Everything else (monitor grouping, thermostat, UI) is mechanical once the work-unit abstraction is in `lib/`. The flywheel payoff (#10) is small once Phase 1-3 exist — it's just a button that POSTs a pre-filled seed deploy.
