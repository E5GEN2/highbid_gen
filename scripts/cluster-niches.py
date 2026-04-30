#!/usr/bin/env python3
"""
Sub-niche discovery via HDBSCAN clustering on video embeddings.

Input JSON supports four embedding sources:
  - title_v1     → niche_video_vectors           (gemini-embedding-001, titles)
  - title_v2     → niche_video_vectors_title_v2  (gemini-embedding-2-preview, titles)
  - thumbnail_v2 → niche_video_vectors_thumb_v2  (image embeddings)
  - combined     → concatenation of title_v2 + thumbnail_v2 (L2-normalised halves)
                   only videos present in BOTH spaces are clustered.

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
}


def parse_embedding(raw):
    """pgvector returns vectors as strings like '[0.1,0.2,...]'."""
    if isinstance(raw, str):
        return [float(x) for x in raw.strip('[]').split(',')]
    return list(raw)


def fetch_single_source(cur, table, keyword, video_ids):
    """Pull (video_id, title, embedding) rows from one table, optionally filtered to video_ids.

    When keyword == '__global__' (sentinel used by the niche-tree global
    clustering), the keyword filter is dropped — we want every embedding
    across all keywords. Vector tables can have the same video_id stored
    under multiple keywords (the same video discovered via different
    searches); DISTINCT ON (video_id) keeps one embedding per video. The
    embeddings are computed from the title/thumbnail not the keyword,
    so the duplicate rows are interchangeable.
    """
    if keyword == '__global__':
        if video_ids:
            placeholders = ','.join(['%s'] * len(video_ids))
            cur.execute(
                f"SELECT DISTINCT ON (video_id) video_id, title, embedding "
                f"FROM {table} WHERE video_id IN ({placeholders})",
                list(video_ids)
            )
        else:
            cur.execute(
                f"SELECT DISTINCT ON (video_id) video_id, title, embedding FROM {table}"
            )
        return cur.fetchall()

    if video_ids:
        placeholders = ','.join(['%s'] * len(video_ids))
        cur.execute(
            f"SELECT video_id, title, embedding FROM {table} WHERE keyword = %s AND video_id IN ({placeholders})",
            [keyword] + list(video_ids)
        )
    else:
        cur.execute(
            f"SELECT video_id, title, embedding FROM {table} WHERE keyword = %s",
            (keyword,)
        )
    return cur.fetchall()


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
        print(json.dumps({'error': f"Invalid source '{source}'. Expected title_v1 | title_v2 | thumbnail_v2 | combined."}))
        return

    conn = psycopg2.connect(db_url)
    cur = conn.cursor()

    # --- Fetch embeddings based on source ---
    if source == 'combined':
        # Pull from both v2 tables, inner-join on video_id
        title_rows = fetch_single_source(cur, TABLE_BY_SOURCE['title_v2'], keyword, video_ids)
        thumb_rows = fetch_single_source(cur, TABLE_BY_SOURCE['thumbnail_v2'], keyword, video_ids)
        title_map = {r[0]: (r[1], r[2]) for r in title_rows}
        thumb_map = {r[0]: r[2] for r in thumb_rows}
        common_ids = sorted(set(title_map.keys()) & set(thumb_map.keys()))
        sys.stderr.write(f"[cluster] combined: title={len(title_rows)} thumb={len(thumb_rows)} intersection={len(common_ids)}\n")
        rows = []
        for vid in common_ids:
            title, title_emb = title_map[vid]
            thumb_emb = thumb_map[vid]
            rows.append((vid, title, (title_emb, thumb_emb)))
    else:
        table = TABLE_BY_SOURCE[source]
        raw_rows = fetch_single_source(cur, table, keyword, video_ids)
        sys.stderr.write(f"[cluster] {source}: fetched {len(raw_rows)} rows from {table}\n")
        rows = raw_rows
    conn.close()

    if len(rows) < 10:
        print(json.dumps({
            'error': f"Only {len(rows)} embedded videos for '{keyword}' in {source}. Need at least 10.",
            'num_clusters': 0, 'num_noise': 0, 'total_videos': len(rows),
            'clusters': [], 'assignments': []
        }))
        return

    # Build the feature matrix
    video_ids_final = [r[0] for r in rows]
    titles = [r[1] or '' for r in rows]
    if source == 'combined':
        # Concat L2-normalised title + thumb halves — each half contributes equally
        feats = []
        for _, _, (t_raw, th_raw) in rows:
            t = l2_normalize(np.array(parse_embedding(t_raw), dtype=np.float32))
            th = l2_normalize(np.array(parse_embedding(th_raw), dtype=np.float32))
            feats.append(np.concatenate([t, th]))
        X = np.stack(feats)
    else:
        X = np.array([parse_embedding(r[2]) for r in rows], dtype=np.float32)

    n = X.shape[0]
    dim = X.shape[1]
    sys.stderr.write(f"[cluster] X shape=({n},{dim}) source={source}\n")

    # --- Auto-tune HDBSCAN params ---
    if min_cluster_size is None:
        min_cluster_size = max(5, int(n * 0.005))   # 0.5% of videos, floor 5
    if min_samples is None:
        min_samples = max(5, min(min_cluster_size, 15))
    sys.stderr.write(f"[cluster] min_cluster_size={min_cluster_size}, min_samples={min_samples}\n")

    # --- UMAP to umap_dims for clustering ---
    from umap import UMAP
    n_neighbors = config.get('n_neighbors', 5)
    reducer_cluster = UMAP(
        n_components=umap_dims,
        n_neighbors=n_neighbors,
        metric='cosine',
        min_dist=0.0,
        random_state=42,
        verbose=False
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
    num_clusters = len(set(labels)) - (1 if -1 in labels else 0)
    num_noise = int(np.sum(labels == -1))
    sys.stderr.write(f"[cluster] HDBSCAN: {num_clusters} clusters, {num_noise} noise\n")

    # --- 2D UMAP for scatter ---
    reducer_2d = UMAP(
        n_components=2,
        n_neighbors=n_neighbors,
        metric='cosine',
        min_dist=0.0,
        random_state=42,
        verbose=False
    )
    X_2d = reducer_2d.fit_transform(X)

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
