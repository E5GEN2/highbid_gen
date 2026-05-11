# Novelty (blue-ocean) scoring

Ranks videos by how far they sit from their nearest neighbors in the combined_v2 embedding space — high novelty = sparse region of the manifold = potential blue-ocean format.

## The math

For each video `v`:

```
novelty(v) = mean cosine distance to v's K=10 nearest neighbors
             in niche_video_vectors_combined_v2
```

- Distance is `<=>` (cosine, 0 = identical, 2 = opposite). We keep it as distance (not similarity) so higher = more novel.
- K is clamped 1..50, default 10.
- Returns null if the video has no combined_v2 embedding.

Combined with the per-channel `peer_outlier_score` and `log(view_count)`, this gives the blue-ocean rank in the admin UI:

```
blue_ocean_rank = novelty × peer_outlier × log(1 + views)
```

Interpretation: rare topic that outperforms its own channel's baseline AND has actual views = signal worth investigating.

## Why combined_v2 (not title_v2 + thumbnail_v2)

The original implementation averaged KNN in two separate spaces (title_v2 + thumbnail_v2, each at 25% DB coverage). That capped novelty scoring at ~11% of the dataset and did 2 round trips per video.

`combined_v2` is the joint multimodal embedding (one vector per video encoding both title AND thumbnail), at 99% coverage and the same space HDBSCAN clusters on. Switching to it:
- 9× more coverage (393K candidates vs 43K)
- Single KNN query per video (half the round trips)
- "Novelty" becomes geometrically coherent with cluster distance (same basis)

## pgvector index

The embeddings are 3072 dimensions. pgvector's HNSW caps at 2000, so we index a `halfvec(3072)` cast (16-bit floats):

```sql
CREATE INDEX idx_nvv_cb2_emb_ivf ON niche_video_vectors_combined_v2
USING ivfflat ((embedding::halfvec(3072)) halfvec_cosine_ops)
WITH (lists = 200);
```

KNN query also casts to halfvec:

```sql
SELECT (embedding::halfvec(3072)) <=> $1::halfvec(3072) AS dist
  FROM niche_video_vectors_combined_v2
 ORDER BY (embedding::halfvec(3072)) <=> $1::halfvec(3072)
 LIMIT 10
```

Each KNN: ~100ms with the index, vs ~5-10s for full scan. ~50-100× speedup.

## Recompute endpoint

`POST /api/admin/novelty/recompute`

Body:
```json
{ "mode": "missing" | "all", "threads": 8, "k": 10, "limit": 1000000 }
```

- `mode='missing'` (default) — only score nulls. Cheap to re-run after partial failures.
- `mode='all'` — re-score everything. Use after a new clustering run.
- Fire-and-forget: returns `{ok, started, jobKey}` immediately, work continues server-side.

`GET /api/admin/novelty/recompute`

Returns current distribution `{ p50, p90, p99, total, candidateTotal, lastUpdated }` + `running` + `lastResult`.

Pool considerations: novelty workers compete with admin/page queries for the main DB pool (max=50) and vector DB pool (max=15). Default threads=8 leaves comfortable headroom.

## Admin UI

**Admin → Novelty** tab shows:
- Score distribution stats + scored / candidate counts
- Filter row (sort, min novelty, view ranges, channel age, posted-within, outlier ranges, subs ranges)
- Video grid with novelty % badge, peer outlier multiplier, and (if `score > 80`) a green border highlighting blue-ocean candidates
- Recompute button (fire-and-forget, mode='missing')
