# Admin API reference

All endpoints below require admin auth:
- `Authorization: Bearer hba_…` (preferred)
- `x-admin-token: hba_…`
- `admin_token` cookie

Token: see [reference_rofe_admin_api.md](https://github.com/E5GEN2/highbid_gen) memory note.

## Niche Tree (clustering)

| Method | URL | Purpose |
|---|---|---|
| GET | `/api/admin/niche-tree/agent` | Current global run status — stage, %, ETA, stitch summary |
| POST | `/api/admin/niche-tree/agent` | Start a new global L1 run. body: `{source, minClusterSize, minSamples, umapDims, minScore, force}` |
| DELETE | `/api/admin/niche-tree/agent` | Cancel running job |
| POST | `/api/admin/niche-tree/agent/stitch` | Manually re-stitch a run. body: `{runId, force?}` |
| GET | `/api/admin/niche-tree/agent/diff?runId=N` | Per-run lifecycle diff (born/died/grew/shrank/split/merged) |
| GET | `/api/admin/niche-tree/agent/events` | Filterable event log. params: `event=`, `stable_id=`, `since=`, `limit=` |
| POST | `/api/admin/niche-tree/agent/labels` | Kick off Gemini ai_label backfill. body: `{runId, mode, threads}` |
| GET | `/api/admin/niche-tree/agent/labels?runId=N` | Label counts + in-flight state |
| POST | `/api/admin/niche-tree/resume-l2` | Resume L2 baking on an L1 run |
| POST | `/api/admin/niche-tree/backfill-vectors` | Populate `niche_tree_cluster_vectors` (search index) |

## Novelty (blue-ocean)

| Method | URL | Purpose |
|---|---|---|
| GET | `/api/admin/novelty/recompute` | Distribution stats + in-flight state |
| POST | `/api/admin/novelty/recompute` | Kick off recompute (fire-and-forget). body: `{mode, threads, k, limit}` |
| GET | `/api/admin/novelty/videos` | Filtered videos with novelty + peer-outlier scores |

## Video Seed (niche expansion)

| Method | URL | Purpose |
|---|---|---|
| POST | `/api/niche-spy/video-seed/expand` | The endpoint xgodo agents call. body: `{seedUrl, candidateUrls, topK?, minSimilarity?, taskId?, keyword?}` |
| GET | `/api/admin/niche-spy/seed-feed` | Live feed for the admin UI. params: `taskId=`, `keyword=`, `matched=`, `minSim=`, `since=`, `limit=` |

## Enrichment

| Method | URL | Purpose |
|---|---|---|
| GET | `/api/niche-spy/enrich/control` | Job status, gaps, fleet stats (terse) |
| POST | `/api/niche-spy/enrich/control` | Start enrich at max-speed defaults |
| DELETE | `/api/niche-spy/enrich/control` | Cancel current run |

## Auth tokens

| Method | URL | Purpose |
|---|---|---|
| GET | `/api/admin/admin-tokens` | List admin tokens (masked) |
| POST | `/api/admin/admin-tokens` | Mint a new admin token. body: `{name}` |
| DELETE | `/api/admin/admin-tokens?id=X` | Revoke a token |

## Quick curl recipes

Trigger a global clustering run:
```bash
curl -X POST https://rofe.ai/api/admin/niche-tree/agent \
  -H "Authorization: Bearer hba_…" \
  -H "Content-Type: application/json" \
  -d '{"source":"combined_v2","minClusterSize":80,"minSamples":10,"umapDims":50,"force":true}'
```

Watch a run progress:
```bash
watch -n 5 'curl -s https://rofe.ai/api/admin/niche-tree/agent -H "Authorization: Bearer hba_…" | jq "{stage, percentComplete, etaSeconds, errorMessage}"'
```

Stitch a fresh run with the latest algorithm:
```bash
curl -X POST https://rofe.ai/api/admin/niche-tree/agent/stitch \
  -H "Authorization: Bearer hba_…" \
  -H "Content-Type: application/json" \
  -d '{"runId":365,"force":true}'
```

Pull the diff:
```bash
curl https://rofe.ai/api/admin/niche-tree/agent/diff?runId=365 \
  -H "Authorization: Bearer hba_…" | jq .totals
```

Kick novelty recompute for missing:
```bash
curl -X POST https://rofe.ai/api/admin/novelty/recompute \
  -H "Authorization: Bearer hba_…" \
  -H "Content-Type: application/json" \
  -d '{"mode":"missing","threads":8}'
```

Backfill ai_labels for run 365:
```bash
curl -X POST https://rofe.ai/api/admin/niche-tree/agent/labels \
  -H "Authorization: Bearer hba_…" \
  -H "Content-Type: application/json" \
  -d '{"runId":365,"mode":"missing","threads":10}'
```

Video-seed expand:
```bash
curl -X POST https://rofe.ai/api/niche-spy/video-seed/expand \
  -H "Authorization: Bearer hba_…" \
  -H "Content-Type: application/json" \
  -d '{
    "seedUrl":"https://youtu.be/xxx",
    "candidateUrls":["https://youtu.be/aaa","https://youtu.be/bbb"],
    "topK":10,
    "taskId":"task-1",
    "keyword":"ai-yt-auto"
  }'
```
