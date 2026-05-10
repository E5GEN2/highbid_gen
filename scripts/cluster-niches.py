#!/usr/bin/env python3
"""
Sub-niche discovery via HDBSCAN clustering on video embeddings.

Input JSON supports five embedding sources:
  - title_v1     → niche_video_vectors              (gemini-embedding-001, titles)
  - title_v2     → niche_video_vectors_title_v2     (gemini-embedding-2-preview, titles)
  - thumbnail_v2 → niche_video_vectors_thumb_v2     (image embeddings)
  - combined     → concatenation of title_v2 + thumbnail_v2 (L2-normalised halves);
                   only videos present in BOTH spaces are clustered (6144D output).
  - combined_v2  → niche_video_vectors_combined_v2  (joint title+image multimodal,
                   one 3072D vector per video — preferred)

Output: clusters, assignments, 2D coords, auto-labels via TF-IDF.
"""

import sys
import json
import numpy as np
import psycopg2

TABLE_BY_SOURCE = {
    'title_v1':      'niche_video_vectors',
    'title_v2':      'niche_video_vectors_title_v2',
    'thumbnail_v2':  'niche_video_vectors_thumb_v2',
    'combined_v2':   'niche_video_vectors_combined_v2',
}


def parse_embedding(raw):
    """pgvector returns vectors as strings like '[0.1,0.2,...]'."""
    if isinstance(raw, str):
        return [float(x) for x in raw.strip('[]').split(',')]
    return list(raw)


def fetch_single_source(cur, table, keyword, video_ids):
    """Pull (video_id, title, embedding) rows from one table.

    Used for the deprecated 'combined' source path (small datasets only,
    where holding all rows in memory is fine). The much-larger global
    'combined_v2' path uses stream_single_source_into_matrix() below.

    Filter logic: if `video_ids` is provided, that's the precise filter
    we use — drop the keyword filter entirely, because the same video
    can live under multiple keywords (the same URL discovered via
    different searches) and the embeddings are computed from the
    title/thumbnail not the keyword, so duplicates are interchangeable.
    DISTINCT ON (video_id) keeps one row per video.

    Without `video_ids`, fall back to the legacy per-keyword path used
    by lib/clustering.ts. The '__global__' sentinel still means
    "every embedding in the table" in that path, while any other
    keyword string is used as a literal filter.
    """
    if video_ids:
        placeholders = ','.join(['%s'] * len(video_ids))
        cur.execute(
            f"SELECT DISTINCT ON (video_id) video_id, title, embedding "
            f"FROM {table} WHERE video_id IN ({placeholders})",
            list(video_ids)
        )
        return cur.fetchall()

    # No video_ids — legacy per-keyword path
    if keyword == '__global__':
        cur.execute(
            f"SELECT DISTINCT ON (video_id) video_id, title, embedding FROM {table}"
        )
    else:
        cur.execute(
            f"SELECT video_id, title, embedding FROM {table} WHERE keyword = %s",
            (keyword,)
        )
    return cur.fetchall()


def stream_single_source_into_matrix(conn, table, keyword, video_ids):
    """Stream (video_id, title, embedding) rows directly into a
    pre-allocated numpy matrix to avoid holding both the raw row list
    AND the parsed X simultaneously.

    For the global combined_v2 run (393K × 3072D), the naive fetchall +
    list-comprehension build path peaks at ~35 GB and OOMs the
    container. Streaming via a server-side named cursor keeps peak RAM
    ≈ size_of(X) + tiny per-batch overhead.

    Returns (video_ids, titles, X).
    """
    # Step 1: fast COUNT to size the matrix.
    count_cur = conn.cursor()
    if video_ids:
        placeholders = ','.join(['%s'] * len(video_ids))
        count_cur.execute(
            f"SELECT COUNT(DISTINCT video_id) FROM {table} WHERE video_id IN ({placeholders})",
            list(video_ids)
        )
    elif keyword == '__global__':
        count_cur.execute(f"SELECT COUNT(DISTINCT video_id) FROM {table}")
    else:
        count_cur.execute(f"SELECT COUNT(*) FROM {table} WHERE keyword = %s", (keyword,))
    total = count_cur.fetchone()[0]
    count_cur.close()

    sys.stderr.write(f"[cluster] {table}: total rows to stream = {total}\n")

    if total == 0:
        return [], [], np.empty((0, 0), dtype=np.float32)

    # Step 2: server-side named cursor for true streaming. Without name=,
    # psycopg2 uses a client-side cursor that buffers the entire result
    # set up front — defeating the purpose.
    stream_cur = conn.cursor(name='cluster_stream')
    stream_cur.itersize = 1000   # rows per network round-trip
    if video_ids:
        placeholders = ','.join(['%s'] * len(video_ids))
        stream_cur.execute(
            f"SELECT DISTINCT ON (video_id) video_id, title, embedding FROM {table} "
            f"WHERE video_id IN ({placeholders})",
            list(video_ids)
        )
    elif keyword == '__global__':
        stream_cur.execute(
            f"SELECT DISTINCT ON (video_id) video_id, title, embedding FROM {table}"
        )
    else:
        stream_cur.execute(
            f"SELECT video_id, title, embedding FROM {table} WHERE keyword = %s",
            (keyword,)
        )

    video_ids_out = []
    titles_out = []
    X = None   # allocated lazily once we see the first row's dimension
    idx = 0
    BATCH = 1000

    while True:
        chunk = stream_cur.fetchmany(BATCH)
        if not chunk:
            break
        for vid, title, raw in chunk:
            if isinstance(raw, str):
                vec = np.fromstring(raw.strip('[]'), sep=',', dtype=np.float32)
            else:
                vec = np.array(list(raw), dtype=np.float32)
            if X is None:
                X = np.empty((total, vec.shape[0]), dtype=np.float32)
            video_ids_out.append(vid)
            titles_out.append(title or '')
            X[idx] = vec
            idx += 1

    stream_cur.close()

    # Trim if DB returned fewer rows than the count claimed (race on
    # concurrent inserts) or if we're returning early.
    if X is None:
        return [], [], np.empty((0, 0), dtype=np.float32)
    return video_ids_out, titles_out, X[:idx]


def l2_normalize(v):
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


def main():
    # Read input
    if len(sys.argv) > 1:
        with open(sys.argv[1], 'r') as f:
            config = json.load(f)
    else:
        config = json.load(sys.stdin)

    db_url = config['db_url']
    keyword = config['keyword']
    video_ids = config.get('video_ids') or None
    min_cluster_size = config.get('min_cluster_size')
    min_samples = config.get('min_samples')
    umap_dims = config.get('umap_dims', 50)
    source = config.get('source', 'title_v1')

    if source != 'combined' and source not in TABLE_BY_SOURCE:
        print(json.dumps({'error': f"Invalid source '{source}'. Expected title_v1 | title_v2 | thumbnail_v2 | combined | combined_v2."}))
        return

    conn = psycopg2.connect(db_url)

    # --- Fetch embeddings based on source ---
    #
    # Non-combined sources stream directly into a pre-allocated numpy
    # matrix via stream_single_source_into_matrix. This avoids the
    # ~35 GB peak that the old "fetchall + list-comprehension build X"
    # path hit on 393K × 3072D and OOM-killed the container.
    #
    # The deprecated 'combined' source still uses the in-memory path —
    # only ever called for small per-keyword runs where it's harmless.
    if source == 'combined':
        cur = conn.cursor()
        title_rows = fetch_single_source(cur, TABLE_BY_SOURCE['title_v2'], keyword, video_ids)
        thumb_rows = fetch_single_source(cur, TABLE_BY_SOURCE['thumbnail_v2'], keyword, video_ids)
        cur.close()
        title_map = {r[0]: (r[1], r[2]) for r in title_rows}
        thumb_map = {r[0]: r[2] for r in thumb_rows}
        common_ids = sorted(set(title_map.keys()) & set(thumb_map.keys()))
        sys.stderr.write(f"[cluster] combined: title={len(title_rows)} thumb={len(thumb_rows)} intersection={len(common_ids)}\n")
        n_rows = len(common_ids)
        if n_rows < 10:
            conn.close()
            print(json.dumps({
                'error': f"Only {n_rows} embedded videos for '{keyword}' in combined. Need at least 10.",
                'num_clusters': 0, 'num_noise': 0, 'total_videos': n_rows,
                'clusters': [], 'assignments': []
            }))
            return
        video_ids_final = list(common_ids)
        titles = [title_map[vid][0] or '' for vid in common_ids]
        # Probe dim on first row, build in place
        t0_raw = title_map[common_ids[0]][1]
        th0_raw = thumb_map[common_ids[0]]
        t0 = np.fromstring(t0_raw.strip('[]'), sep=',', dtype=np.float32) if isinstance(t0_raw, str) else np.array(list(t0_raw), dtype=np.float32)
        th0 = np.fromstring(th0_raw.strip('[]'), sep=',', dtype=np.float32) if isinstance(th0_raw, str) else np.array(list(th0_raw), dtype=np.float32)
        X = np.empty((n_rows, t0.shape[0] + th0.shape[0]), dtype=np.float32)
        for i, vid in enumerate(common_ids):
            t_raw = title_map[vid][1]
            th_raw = thumb_map[vid]
            t_arr = np.fromstring(t_raw.strip('[]'), sep=',', dtype=np.float32) if isinstance(t_raw, str) else np.array(list(t_raw), dtype=np.float32)
            th_arr = np.fromstring(th_raw.strip('[]'), sep=',', dtype=np.float32) if isinstance(th_raw, str) else np.array(list(th_raw), dtype=np.float32)
            X[i, :t0.shape[0]] = l2_normalize(t_arr)
            X[i, t0.shape[0]:] = l2_normalize(th_arr)
        del title_rows, thumb_rows, title_map, thumb_map, common_ids
    else:
        table = TABLE_BY_SOURCE[source]
        video_ids_final, titles, X = stream_single_source_into_matrix(conn, table, keyword, video_ids)
        n_rows = len(video_ids_final)
        sys.stderr.write(f"[cluster] {source}: streamed {n_rows} rows from {table}\n")
        if n_rows < 10:
            conn.close()
            print(json.dumps({
                'error': f"Only {n_rows} embedded videos for '{keyword}' in {source}. Need at least 10.",
                'num_clusters': 0, 'num_noise': 0, 'total_videos': n_rows,
                'clusters': [], 'assignments': []
            }))
            return
    conn.close()

    n = X.shape[0]
    dim = X.shape[1]
    sys.stderr.write(f"[cluster] X shape=({n},{dim}) source={source}\n")

    # --- Auto-tune HDBSCAN params ---
    if min_cluster_size is None:
        min_cluster_size = max(5, int(n * 0.005))   # 0.5% of videos, floor 5
    if min_samples is None:
        min_samples = max(5, min(min_cluster_size, 15))
    sys.stderr.write(f"[cluster] min_cluster_size={min_cluster_size}, min_samples={min_samples}\n")

    # --- PCA pre-reduction for large/high-dim datasets ---
    # UMAP on raw 3072D × 400K+ vectors OOMs the Railway container
    # (peak ~15-20 GB during graph construction). PCA pre-reduce to
    # ~256D first: trades a tiny variance loss (typically >95% retained
    # on dense embedding spaces like Gemini's) for a 12× memory drop.
    #
    # Only triggers when N*D exceeds ~200M cells — small/dev runs use the
    # original direct-UMAP path so behaviour is unchanged below the
    # threshold. Threshold is empirical: 114K × 3072 (~350M cells) ran
    # fine on the existing container; 393K × 3072 (~1.2B cells) OOM'd.
    PCA_TRIGGER_CELLS = 200_000_000
    PCA_DIMS = 256
    cells = n * dim
    if cells > PCA_TRIGGER_CELLS:
        from sklearn.decomposition import PCA
        pca_dims = min(PCA_DIMS, n - 1, dim)
        sys.stderr.write(f"[cluster] dataset {n}*{dim}={cells} cells > {PCA_TRIGGER_CELLS} threshold; PCA {dim}D -> {pca_dims}D\n")
        pca = PCA(n_components=pca_dims, svd_solver='randomized', random_state=42)
        X = pca.fit_transform(X).astype(np.float32)
        evr = float(pca.explained_variance_ratio_.sum())
        sys.stderr.write(f"[cluster] PCA done; retained variance = {evr:.4f} ({pca_dims}D)\n")
        del pca
        # Update dim so downstream logging is accurate
        dim = X.shape[1]

    # --- UMAP to umap_dims for clustering ---
    # Operates on either the raw embedding (small datasets) or the
    # PCA-reduced one (large datasets). low_memory=True still halves
    # peak RAM on the UMAP graph construction itself.
    from umap import UMAP
    n_neighbors = config.get('n_neighbors', 5)
    reducer_cluster = UMAP(
        n_components=umap_dims,
        n_neighbors=n_neighbors,
        metric='cosine',
        min_dist=0.0,
        random_state=42,
        low_memory=True,         # halves peak RAM on wide inputs (>3K dims)
        verbose=False,
    )
    X_reduced = reducer_cluster.fit_transform(X)
    sys.stderr.write(f"[cluster] UMAP {dim}D -> {umap_dims}D done\n")

    # --- HDBSCAN ---
    import hdbscan
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=min_samples,
        cluster_selection_method='eom',
        metric='euclidean'
    )
    labels = clusterer.fit_predict(X_reduced)
    num_clusters_raw = len(set(labels)) - (1 if -1 in labels else 0)
    num_noise_raw = int(np.sum(labels == -1))
    sys.stderr.write(f"[cluster] HDBSCAN: {num_clusters_raw} clusters, {num_noise_raw} noise (pre-cleanup)\n")

    # --- Outlier cleanup: per-cluster Tukey IQR fence on centroid distance ---
    # HDBSCAN clusters via mutual-reachability distance, which builds a
    # single-linkage tree. Long "tendrils" can pull stragglers into a
    # cluster — points labeled as in-cluster but euclidean-far from the
    # centroid in feature space. Example from a real run: 7 scary-story
    # videos labeled into a "bitcoin crypto" cluster at d=6.29 while the
    # core sat at d<0.5.
    #
    # Per cluster: compute Q1, Q3, IQR on euclidean distance to centroid.
    # Demote anything above (Q3 + iqr_mult * IQR) back to noise (-1).
    # Multiplier defaults to 3.0 — lenient enough to keep legitimate
    # cluster-edge members, strict enough to catch the d=4-6 outliers
    # that are clearly miscategorized.
    iqr_mult = float(config.get('outlier_iqr_mult', 3.0))
    cleanup_demoted = 0
    cleanup_clusters_affected = 0
    if iqr_mult > 0:
        cluster_indices_raw = sorted(set(labels) - {-1})
        for ci in cluster_indices_raw:
            cluster_members = np.where(labels == ci)[0]
            if cluster_members.size < 4:
                continue  # too few points for meaningful quartiles
            pts = X_reduced[cluster_members]
            centroid = pts.mean(axis=0)
            dists = np.linalg.norm(pts - centroid, axis=1)
            q1, q3 = np.percentile(dists, [25, 75])
            iqr = q3 - q1
            if iqr <= 0:
                continue  # degenerate (all distances equal); nothing to do
            upper_fence = q3 + iqr_mult * iqr
            outlier_local = dists > upper_fence
            n_out = int(outlier_local.sum())
            if n_out == 0:
                continue
            labels[cluster_members[outlier_local]] = -1
            cleanup_demoted += n_out
            cleanup_clusters_affected += 1

    num_clusters = len(set(labels)) - (1 if -1 in labels else 0)
    num_noise = int(np.sum(labels == -1))
    if cleanup_demoted > 0:
        sys.stderr.write(
            f"[cluster] outlier cleanup (Tukey {iqr_mult}*IQR): demoted "
            f"{cleanup_demoted} videos across {cleanup_clusters_affected} "
            f"clusters; final {num_clusters} clusters, {num_noise} noise\n"
        )
    else:
        sys.stderr.write(f"[cluster] outlier cleanup: nothing to demote\n")

    # --- 2D UMAP for scatter (optional) ---
    # The user-side scatter view (/api/niche-spy/clusters/scatter) needs
    # x_2d / y_2d per assignment; per-keyword runs always compute it.
    # Global niche-tree runs skip it via compute_2d=false to halve UMAP
    # wall time on the full dataset — the niche tree admin tab doesn't
    # render a scatter, and we can recompute it separately later if we
    # promote the tree to user-side.
    compute_2d = bool(config.get('compute_2d', True))
    if compute_2d:
        reducer_2d = UMAP(
            n_components=2,
            n_neighbors=n_neighbors,
            metric='cosine',
            min_dist=0.0,
            random_state=42,
            low_memory=True,
            verbose=False,
        )
        X_2d = reducer_2d.fit_transform(X)
        sys.stderr.write(f"[cluster] UMAP {dim}D -> 2D scatter done\n")
    else:
        X_2d = np.zeros((n, 2), dtype=np.float32)
        sys.stderr.write(f"[cluster] 2D scatter skipped (compute_2d=false)\n")

    # --- TF-IDF per-cluster auto-labels (titles only — same regardless of source) ---
    from sklearn.feature_extraction.text import TfidfVectorizer
    import re

    def clean_title(t):
        t = re.sub(r'[^\w\s]', ' ', t.lower())
        t = re.sub(r'\s+', ' ', t).strip()
        stopwords = {'how', 'to', 'the', 'a', 'an', 'i', 'my', 'you', 'your', 'this', 'that',
                     'is', 'are', 'was', 'were', 'in', 'on', 'for', 'with', 'and', 'or', 'of',
                     'from', 'it', 'its', 'can', 'do', 'will', 'be', 'no', 'not', 'but', 'so',
                     'just', 'get', 'got', 'make', 'made', 'using', 'use', 'new', 'best',
                     'top', 'full', 'guide', 'tutorial', 'video', 'videos', 'watch'}
        words = [w for w in t.split() if w not in stopwords and len(w) > 2]
        return ' '.join(words)

    cluster_indices = sorted(set(labels) - {-1})
    cluster_labels_map = {}

    if num_clusters > 1:
        cluster_docs = []
        for ci in cluster_indices:
            mask = labels == ci
            cluster_titles = [clean_title(titles[i]) for i in range(n) if mask[i]]
            cluster_docs.append(' '.join(cluster_titles))
        try:
            vectorizer = TfidfVectorizer(max_features=500, ngram_range=(1, 2))
            tfidf_matrix = vectorizer.fit_transform(cluster_docs)
            feature_names = vectorizer.get_feature_names_out()
            for idx, ci in enumerate(cluster_indices):
                scores = tfidf_matrix[idx].toarray().flatten()
                top_indices = scores.argsort()[-5:][::-1]
                top_terms = [feature_names[i] for i in top_indices if scores[i] > 0]
                cluster_labels_map[ci] = ' '.join(top_terms[:3]) if top_terms else f'Cluster {ci}'
        except Exception as e:
            sys.stderr.write(f"[cluster] TF-IDF labeling error: {e}\n")
            for ci in cluster_indices:
                cluster_labels_map[ci] = f'Cluster {ci}'
    elif num_clusters == 1:
        cluster_labels_map[cluster_indices[0]] = keyword

    # --- Build output ---
    clusters_out = []
    for ci in cluster_indices:
        mask = labels == ci
        indices = np.where(mask)[0]
        count = int(np.sum(mask))

        centroid_2d = X_2d[mask].mean(axis=0).tolist()

        cluster_reduced = X_reduced[mask]
        centroid_reduced = cluster_reduced.mean(axis=0)
        distances = np.linalg.norm(cluster_reduced - centroid_reduced, axis=1)
        rep_idx = indices[distances.argmin()]
        rep_video_id = video_ids_final[rep_idx]

        clusters_out.append({
            'cluster_index': int(ci),
            'video_count': count,
            'auto_label': cluster_labels_map.get(ci, f'Cluster {ci}'),
            'representative_video_id': int(rep_video_id),
            'centroid_2d': [round(c, 4) for c in centroid_2d],
            'video_ids': [int(video_ids_final[i]) for i in indices],
            'top_titles': [titles[i] for i in indices[:10]],
        })

    assignments_out = []
    for i in range(n):
        ci = int(labels[i])
        if ci >= 0:
            mask = labels == ci
            centroid = X_reduced[mask].mean(axis=0)
            dist = float(np.linalg.norm(X_reduced[i] - centroid))
        else:
            dist = -1.0
        assignments_out.append({
            'video_id': int(video_ids_final[i]),
            'cluster_index': ci,
            'x_2d': round(float(X_2d[i][0]), 4),
            'y_2d': round(float(X_2d[i][1]), 4),
            'distance': round(dist, 4),
        })

    print(json.dumps({
        'num_clusters': num_clusters,
        'num_noise': num_noise,
        'total_videos': n,
        'source': source,
        'clusters': clusters_out,
        'assignments': assignments_out,
    }))


if __name__ == '__main__':
    main()
