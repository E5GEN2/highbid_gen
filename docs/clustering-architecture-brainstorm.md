# Clustering Architecture Brainstorm

Date: 2026-05-09
Status: Brainstorm — no implementation yet. Decisions are tentative.

---

## The problem

Our video DB grows continuously. We need a clustering strategy that:
- Lets us **watch known clusters grow / die** over time
- Lets us **detect new clusters being born** as new niches emerge
- Keeps **stable cluster identity** (so URLs, lifecycle charts, bookmarks survive)
- Stays computationally tractable as N scales from 100K → 1M+

---

## The key insight: the embedding space is static

We use Gemini's `gemini-embedding-2-preview` (3072D), a fixed pretrained model. The embedding manifold doesn't move. Cooking videos are always near other cooking videos.

Therefore:
- A cluster is just a **fixed region of space** that happens to have enough density today to be detected.
- Clusters don't *drift* geometrically — they only grow, shrink, or get joined by previously-orphan points.
- "Concept drift" in the traditional sense doesn't exist here.

This kills a lot of complexity (sliding windows, periodic re-embedding, etc.) that would matter if the embedding model itself were learned online.

---

## Decouple "discovery" from "representation"

Two distinct jobs that should not share machinery:

**Discovery** — "find new dense regions in this set of points"
- Stateless. Run periodically on a subset (typically the noise pool).
- Returns candidate cluster shapes.
- Algorithm-interchangeable: HDBSCAN, mean-shift, BIRCH, etc.

**Representation** — "what is a cluster, in the DB"
- Stateful. Each cluster = `{stable_id, center, radius, member_count, status, parent_id}`.
- Powers hot-path assignment, lifecycle UI, URLs.
- Independent of which discovery algorithm is used.

The discovery output is canonicalized into the stable representation through a **stitching** step (see below). The current system conflates these — cluster identity = HDBSCAN's per-run integer label — which is the source of fragility.

---

## Algorithm comparison

### HDBSCAN (current)

**How it works:**
1. For each point, compute *core distance* = distance to k-th nearest neighbor (`min_samples`).
2. Compute *mutual reachability distance* between all pairs (max of the two core distances and the actual distance).
3. Build minimum spanning tree over those distances.
4. Cut edges longest-first to build a hierarchy of nested clusters.
5. Pick clusters that "persist" most across density levels (stability metric).

**Strengths in our setting:**
- Handles **variable density** (AI-Slop mega-cluster + tiny niche cluster at the same time) — the real differentiator vs DBSCAN/k-means/mean-shift.
- No `k` needed.
- Explicit noise concept.
- Arbitrary cluster shape (less load-bearing in 3072D — see note below).

**Weaknesses:**
- Output is per-point integer labels, not a portable region representation.
- Re-runs on different data → different label assignments → no native stable identity.
- Slow at 3072D — all-pairs MR distance is the bottleneck. ~10 min at 100K, multi-hour at 500K, prohibitive at 1M+.
- Stability extraction is opaque and hard to predict.

### Mean-shift

**How it works:**
For each point, "roll uphill" through the density landscape until reaching a mode (peak):
```
current = p
loop:
  neighbors = points within bandwidth h of current
  current = mean(neighbors)
  break when current stops moving
```
Points converging to the same mode form one cluster. The mode is the cluster center.

**Strengths in our setting:**
- **Centers are first-class outputs** — exactly what the representation layer needs.
- No `k` needed; bandwidth maps directly to "minimum cluster radius."
- Hot-path-friendly: a new video can run one mean-shift step to find its convergence mode.
- Doesn't assume spherical clusters.

**Weaknesses:**
- Single bandwidth parameter — can't handle wildly different cluster densities at once (same problem as DBSCAN).
- Naive O(n²) per iteration; needs FAISS / ANN to scale.
- No native noise concept (filter post-hoc).

### BIRCH

**How it works:**
Maintains a tree of *Cluster Features* (CFs):
```
CF = (N, LinearSum, SquaredSum)
center = LS / N
radius = sqrt(SS/N - (LS/N)²)
CFs are additive: CF_a + CF_b = (N_a+N_b, LS_a+LS_b, SS_a+SS_b)
```
Inserting a new point:
1. Walk down the tree to the closest leaf.
2. If absorbing it keeps radius ≤ threshold T → absorb (update CF upward).
3. Otherwise create a new leaf-CF; split if leaf overflows.

**Strengths in our setting:**
- **True streaming** — adding a video is O(log n), no re-cluster.
- Centers + radii fall out for free.
- Memory bounded.

**Weaknesses:**
- Spherical-ish assumption (one radius per CF, not full covariance).
- Sensitive to insertion order on the margins.
- sklearn implementation is decent but less battle-tested than HDBSCAN.

### DBSCAN

The original. One global `eps` for density threshold. **Skip** — HDBSCAN dominates it for our use case (variable-density tolerance).

### Side-by-side

| | Centers as output | Streaming-friendly | Granularity knob | Speed @ 100K × 3072D |
|---|---|---|---|---|
| HDBSCAN | derived after | batch | `min_cluster_size` | slow (~10 min) |
| Mean-shift | native | doable | `bandwidth` | medium with FAISS (~5 min) |
| BIRCH | native | true streaming | `threshold T` | fast (~1 min) |
| DBSCAN | derived | batch | `eps` | medium |

### Note on "arbitrary shape"

In low-D this is HDBSCAN's selling point (snake / ring / manifold clusters). In **3072D** it's much less load-bearing — distance concentration makes most clusters look roughly cap-shaped on the unit sphere anyway. The variable-density advantage is what actually matters for our data.

---

## Noise re-clustering: a useful experiment

Question raised: if we cluster 100K and get 30K noise, will re-clustering those 30K with the same params surface new clusters?

**Yes** — and this validates the static-space mental model.

Why: HDBSCAN's density is **relative to the data given to it**. Removing the dense mega-clusters changes the density landscape — small blobs that were "low density" relative to AI-Slop are now "high density" relative to other noise. They surface as clusters.

Practical recommendation: when re-clustering noise, **lower `min_cluster_size`** (e.g. from 50 → 15). The point of the noise re-cluster is to find smaller, emerging niches — they're naturally below the threshold tuned for the full dataset.

Run this experiment as a one-off script first to validate before wiring it into a job.

---

## The stitching layer (the load-bearing piece)

Whichever discovery algorithm we use, **identity must persist across runs**. A stitching step compares the new partition to the previous one and assigns stable IDs.

### Core operation

For every pair `(C_old_i, C_new_j)`, compute Jaccard overlap of memberships:

```
overlap = |members(C_old) ∩ members(C_new)| / |members(C_old) ∪ members(C_new)|
```

Membership overlap is unambiguous; geometric "shape comparison" in 3072D is messy. Centroid distance can be used as a tiebreaker for borderline cases.

### Resolution rules

| Pattern | Event | Action |
|---|---|---|
| One C_old strongly matches one C_new (overlap ≥ 0.5) | **same** | Inherit stable_id; log size delta as `grew` / `shrank` |
| C_old has no successor with overlap ≥ 0.2 | **died** | Mark dormant or dead |
| C_new has no predecessor with overlap ≥ 0.2 | **born** | Mint new stable_id |
| One C_old splits across two C_new (each ~0.3-0.5) | **split** | Mint two new IDs; record parent_id |
| Two C_old merge into one C_new (each ~0.3-0.5) | **merged** | Mint new ID; record both parent_ids |

### Worked example

Yesterday:
```
C_1 = {v1..v10}     stable_id = ai-girls
C_2 = {v11..v15}    stable_id = vintage-cars
```

5 new videos arrive. Today's HDBSCAN run:
```
C'_1 = {v1, v2, v3, v5, v7, v8, v9, v10, v100, v101}   (ai-girls + 2 new, lost v4, v6)
C'_2 = {v11, v12, v13, v14, v15, v102}                  (vintage-cars + 1)
C'_3 = {v103, v104, v4, v6}                             (emerging niche)
```

Overlap matrix:

| | C_1 | C_2 |
|---|---|---|
| C'_1 | 0.67 | 0 |
| C'_2 | 0 | 0.83 |
| C'_3 | 0.15 | 0 |

Resolutions:
- `C'_1` → SAME as C_1, inherits `ai-girls`. Event: `grew (+2, -2)`.
- `C'_2` → SAME as C_2, inherits `vintage-cars`. Event: `grew (+1)`.
- `C'_3` → no match, **BORN**. Mints new stable_id.

Notice that the 2 videos shed by ai-girls (v4, v6) ended up in the new niche — useful signal for "niches that splinter off existing clusters."

### Threshold tuning

- `≥ 0.5` → "same" — tune by running HDBSCAN twice on the same data and checking the floor of overlap for genuine "same" cases.
- `0.2 to 0.5` → split / merge candidate zone.
- `< 0.2` → no relationship.

### Centroid distance as a tiebreaker

When membership overlap is borderline (~0.4), check whether centroids are within some cosine threshold. Close centers + moderate overlap → lean toward "same" rather than "split." This is the only place "shape" (geometric similarity) is consulted.

---

## Lifecycle event taxonomy

In the static-space model:

- **Born** — noise crystallized; a new dense region appeared in the noise pool.
- **Growing** — hot path is adding videos at a high rate.
- **Stable** — steady inflow.
- **Dormant** — region stopped receiving new videos (trend fading; the region itself doesn't disappear).
- **Reactivated** — dormant cluster getting fresh videos again.
- **Splitting** — one cluster's region got dense enough that internal substructure is detectable. Often spawns L2 sub-niches under an L1.
- **Merging** — should be rare in a static space; if frequent, the radius parameter is too loose.

---

## Center management

- **L1 centers**: lock at birth, refresh periodically via cold-path. Stable identity layer.
- **L2 centers**: rolling-mean updates as new members are assigned. More responsive to current shape.
- **Track center drift over time** — a cluster whose center drifts > ~0.05 cosine over 6 months is potentially developing internal structure. Trigger an L2 noise-recluster within that L1 specifically.

---

## Compute reality check

| Dataset size | HDBSCAN at 3072D | Daily feasibility |
|---|---|---|
| 100K | ~10 min | yes |
| 500K | ~3-5 hours | tight |
| 1M | ~12-24 hours | no |
| 5M+ | days | even weekly is hard |

The all-pairs mutual-reachability step is the bottleneck (roughly O(n² × d), approximations help but don't change the curve qualitatively).

---

## Recommended architecture

### If we expect to stay under ~500K videos for the next year

**Daily HDBSCAN + stitching layer.** Highest partition quality, simplest mental model, the stitching engineering is a one-time cost.

### If we expect to cross 1M+ videos

**Layered approach** — can't afford daily full re-runs:
- Hot path: BIRCH-CF maintains centers incrementally per video.
- Cold path: weekly HDBSCAN on noise pool only.
- Yearly: full HDBSCAN re-run + stitch (acceptable as occasional heavy job).

### Middle path (the one to actually ship first)

- **Weekly** full HDBSCAN re-run (vs daily — diminishing returns, big compute saving).
- **Stitching layer** for stable IDs across runs.
- **Daily** noise-only HDBSCAN re-run (much cheaper since noise is bounded).
- **Hot path** (per-video) — cosine-to-centroid assignment.

This gives us ~95% of the daily-HDBSCAN quality at ~5% of the compute. The stitching engineering is identical either way, and we can tighten cadence later.

---

## Schema sketch

```sql
clusters (
  stable_id          text PK,
  level              int,         -- 1 or 2 (L1 / L2)
  parent_id          text,        -- for splits: the cluster we came from
  center             vector(3072),
  radius             float,
  member_count       int,
  status             text,        -- live / dormant / dead / split / merged
  born_at            timestamp,
  last_seen_at       timestamp
);

cluster_snapshots (
  cluster_id         text,
  snapshot_at        timestamp,
  size               int,
  top_keywords       text[],
  centroid_drift     float        -- cosine distance from previous snapshot
);

cluster_events (
  cluster_id         text,
  event              text,        -- born / grew / shrank / split / merged / died
  at                 timestamp,
  payload            jsonb        -- event-specific data
);

video_cluster (
  video_id           text,
  cluster_id_l1      text,
  cluster_id_l2      text,
  assigned_at        timestamp,
  confidence         float,       -- cosine to assigned center
  source             text         -- 'hot' (per-video) or 'cold' (re-cluster)
);
```

---

## Open decisions

1. **Cadence**: daily vs weekly full HDBSCAN re-run? Depends on dataset growth rate.
2. **Bandwidth / threshold tuning**: needs to be empirically validated on a known-stable period.
3. **Whether to ship BIRCH-CF as the long-term hot path now** (vs cosine-to-centroid) — the latter is simpler and probably enough for current scale.
4. **L2 strategy**: rolling refresh on every cold-path run, or only when L1 center drifts past threshold?
5. **Noise re-cluster experiment** as a one-off script first — validates the static-space mental model before wiring into a job.

---

## What to do next (when we come back to this)

1. Run the **noise re-cluster experiment** as a one-off script. Validate that hidden niches surface from the 30K noise pool.
2. Spec the **stitching layer** as a standalone Python/TS module — it's algorithm-agnostic and the most valuable piece.
3. Design the **`clusters` + `cluster_events` schema migration**.
4. Decide cadence and ship the **weekly full + daily noise** middle-path job.
5. Defer BIRCH-CF until we hit the 500K wall.
