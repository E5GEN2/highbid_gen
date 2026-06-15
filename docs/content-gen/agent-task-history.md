# Agent task history — durable crawl-trace capture

**Status:** Built. Surfaces in **Admin → Agents tab → "Task History"** (the existing `AgentLog`, now enriched + expandable).

The goal: for every niche-spy task — running or long-finished — show **its seed, what it collected, and the exact videos it watched in order** (the `orderNumber` the operator saw on xgodo's `job_applicants` page).

---

## The three data sources (two durable, one ephemeral)

| Source | What it gives | Durable? |
|---|---|---|
| `agent_task_log` | task lifecycle: key (keyword \| nicheId), status, worker, first/last seen, duration | ✅ already persisted |
| `niche_seed_expansions` (by `task_id`) | every candidate the bot **scored** — url, title, thumbnail, rofe combined_v2 similarity, rank, detected_at | ✅ already persisted |
| xgodo `job_proof` | the bot's **watch path** (`orderNumber`, `watched=true`) + its own per-candidate similarity | ❌ **ephemeral** — only lives while the task is in the applicants list |

The watch order is the one thing we weren't keeping. It vanishes when the task drops off xgodo's list, so it must be **snapshotted while the task runs**.

---

## Capture: `agent_task_proof` (snapshot of the ephemeral proof)

One row per `(task_id, video_url)`:
- `watched=true` + `order_number=N` → a video the bot actually watched (the crawl PATH, in sequence)
- `watched=false` + `similarity` → a suggested candidate it scored but skipped

Written by **`snapshotTaskProofs()`** (`lib/agent-task-proof.ts`), which parses `job_proof` via **`parseJobProofVideos()`** (`lib/xgodo-tasks.ts` — shape-robust: walks the blob, collects video-shaped objects, dedups by video id, merges watched+scored sightings).

Upsert is monotonic: a later snapshot fills in newly-watched videos and never downgrades a watched row back to scored-only.

### Who calls it (continuous, not on-demand)
- **Thermostat tick (every 30s)** — the workhorse. Fetches the `running` list *with* `job_proof` and snapshots it, so the path is captured **even when nobody has the Agents tab open**. Best-effort, fully isolated from deploy decisions.
- **`GET /api/admin/agents/log` (page 1)** — also snapshots running proofs on each poll, so an open panel stays fresh.

> Niche-spy tasks are `running` in xgodo until they finish, then **drop off the list** — there is no `completed` status to query. So we snapshot `running` repeatedly; the last hop in the final <30s before completion may be missed, which is acceptable.

---

## Read

- **List** — `GET /api/admin/agents/log` (existing, now enriched): each task carries `kind` (seed/keyword), `label`, `seedUrl`, `watchedCount`, `scoredCount`.
- **Trace** — `GET /api/admin/agents/history?taskId=<id>` → **`getTaskTrace()`** merges `agent_task_proof` (watch path) with `niche_seed_expansions` (thumbnails + rofe similarity) into one ordered list: watched-first by `orderNumber`, then scored candidates by similarity.

---

## UI (`AgentLog` in `app/admin/page.tsx`)

The Task History table gains a SEED/KW badge, the niche label + clickable seed URL, and a `▶ watched · N scored` column. **Click any row** → expands to the crawl trace: the watch path (numbered) then the scored candidates, each row a thumbnail + title that **opens the video on YouTube in a new tab**, with similarity/rank shown.

---

## Files

- `lib/db.ts` — `agent_task_proof` table + indexes
- `lib/xgodo-tasks.ts` — `parseJobProofVideos()`, `ProofVideo`, `fetchTasksByStatus()`, `TaskWithProof`
- `lib/agent-task-proof.ts` — `snapshotTaskProofs()`, `listTaskHistory()`, `getTaskTrace()`
- `lib/agent-thermostat.ts` — continuous snapshot each tick
- `app/api/admin/agents/log/route.ts` — enriched list + snapshot
- `app/api/admin/agents/history/route.ts` — per-task trace
- `app/admin/page.tsx` — `AgentLog` + `TaskTrace`

## Follow-ups (not blocking)
- Capture the final watch hop reliably (poll terminal xgodo status, or have the bot POST its final proof to a rofe endpoint on completion).
- Retention/prune for `agent_task_proof` once it grows large (e.g. drop traces older than N days for completed tasks).
