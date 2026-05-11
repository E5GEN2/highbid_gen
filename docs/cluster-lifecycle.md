# Cluster Lifecycle — stable IDs across re-clustering runs

When a fresh global HDBSCAN run lands, every cluster gets a new integer ID. Without a stitching layer, that means `/niche/cluster/42` today is a different niche than `/niche/cluster/42` last week — bookmarks break, "did this niche grow?" becomes unanswerable, and the whole concept of cluster identity over time falls apart.

The stitcher fixes this.

## The architecture

Each cluster row in `niche_tree_clusters` has a `stable_id` (text). The stitcher matches new clusters against the previous run's clusters by **member-set Jaccard overlap** and inherits stable_ids where the overlap is strong.

Two levels of stitching:
- **L1** — after a global HDBSCAN run, match new L1s against previous run's L1s.
- **L2** — after each L1 cluster's L2 subdivide, match its new L2 children against the L2s under whichever prior L1 had the same stable_id.

Tiered SAME match: any of `jaccard`, `recall_old`, `recall_new` ≥ 0.5 → inherit. With a minimum-overlap floor (`recall_old ≥ 0.10 AND recall_new ≥ 0.10`) so a 100-video fragment can't steal inheritance from the 2,300-video real successor.

## Events

Every resolution writes one row to `niche_cluster_events`:

| event | meaning |
|---|---|
| `same` | matched, size unchanged |
| `grew` | matched, gained members |
| `shrank` | matched, lost members (often to noise) |
| `split` | one old → multiple new clusters |
| `merged` | multiple old → one new cluster |
| `born` | new cluster, no predecessor |
| `died` | old cluster, no successor |

## Admin UI

**Admin → Cluster Lifecycle** tab reads the events from `/api/admin/niche-tree/agent/diff?runId=N`.

- 7 summary tiles (born/grew/shrank/same/split/merged/died) — also work as one-click filters
- Filter row: level (L1/L2/Both), sort by biggest change | size | jaccard, free-text search
- Per-event card: action badge, label (links to the cluster page), stable_id, parent_stable_id chain, size delta, jaccard%, match metric used

## API

- `POST /api/admin/niche-tree/agent/stitch` — manually re-stitch a run (body: `{runId, force?}`). force=true clears existing events + stable_ids first.
- `GET /api/admin/niche-tree/agent/diff?runId=N` — full diff for one run, joined to cluster labels.
- `GET /api/admin/niche-tree/agent/events?event=born&since=ISO&limit=N` — filterable event log.

## Notable: run 365 results

When run 365 (393K videos) landed against the May 7 baseline (run 53, 114K videos):

- 308 old L1 clusters → 806 new L1 clusters
- **237 of 308 old L1s (77%) survived** via same/grew/shrank/split
- 569 born, 76 died (mostly absorbed by noise — the noise rate jumped 25% → 44% with the dataset growth)
- L2 layer: 4,330 total, 100% with stable_ids assigned

The tiered match metric was critical. With pure-Jaccard the death count was 211; switching to `max(jaccard, recall_old, recall_new) >= 0.5` with both-sides floors dropped it to 76.
