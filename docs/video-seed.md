# Video Seed — niche expansion via cosine similarity

Replaces the per-keyword Gemini chat-scoring loop xgodo agents used to run.

## The problem

Old flow: agent searches YouTube by keyword → scrapes results → batches each result to Gemini Flash with "does this match the niche?" → ~$0.001-0.005 and ~2-5s per video. Scales linearly with cost.

## The new flow

Agent picks a **seed video** (instead of a keyword) and a list of **candidate videos** (typically scraped from the seed's "suggested videos" panel). Posts both to `rofe.ai`. We:

1. Resolve each URL → `niche_spy_videos` row (fetch metadata via YT Data API if not in DB)
2. Embed any missing `combined_v2` vectors (multimodal: title + thumbnail joint)
3. Cosine-compare every candidate against the seed in pgvector (uses the halfvec IVFFLAT index)
4. Rank, mark matched (topK OR threshold), persist every `(seed, candidate, similarity)` tuple to `niche_seed_expansions`

Always scores against the **seed**, never the current node — no drift across recursive xgodo exploration.

## Cost / speed comparison

| | Old (Gemini chat) | New (cosine + embeddings) |
|---|---|---|
| Per video | ~$0.001-0.005 | ~$0.0001 |
| 1,000 candidates | ~$2-5 | ~$0.10 |
| Wall time (1K) | 10-20 min | 30s - 2min |

**~95% cheaper, ~100× faster.** Plus: multilingual (embeddings cross languages; keyword search doesn't), and geometrically coherent with the cluster pipeline (same combined_v2 space).

## API

`POST /api/niche-spy/video-seed/expand`

Body:
```json
{
  "seedUrl": "https://youtu.be/<id>",
  "candidateUrls": ["https://youtu.be/<id1>", "..."],
  "topK": 10,
  "minSimilarity": 0.5,
  "taskId": "task-uuid",
  "keyword": "ai-ytauto"
}
```

- `topK` OR `minSimilarity` (or both — matched if either fires).
- `taskId` lets the admin live feed group events by xgodo task.
- `keyword` is an optional niche tag.
- Max 200 candidates per call.

Returns `SeedExpandResult`:

```json
{
  "seed": { "videoId", "ytId", "url", "title", "thumbnail", "embeddingCached" },
  "candidates": [
    { "rank", "videoId", "url", "title", "thumbnail", "similarity", "matched", "error?" }
  ],
  "matches": [ /* filtered subset */ ],
  "timings": { "metadataMs", "embeddingMs", "similarityMs", "persistMs" }
}
```

Auth: admin Bearer token (`hba_...`).

## Live monitoring

Admin → **Video Seed** tab polls `/api/admin/niche-spy/seed-feed` every 3 seconds. Shows seed thumb → candidate thumb, similarity %, matched badge, task id, keyword. Filterable by task, keyword, min similarity, matched-only.

## DB tables

- `niche_seed_expansions` — one row per `(seed, candidate)` event. Includes the threshold/topK used, the rank within the batch, task id, keyword tag, timestamp.
- `niche_spy_videos` — new videos are inserted with `task_id='video-seed'` and `keyword=<tag from request>`.
- `niche_video_vectors_combined_v2` — embeddings populated on-demand for any new candidate.
