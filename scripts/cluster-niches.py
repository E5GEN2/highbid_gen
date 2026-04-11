#!/usr/bin/env python3
"""
Sub-niche discovery via HDBSCAN clustering on video title embeddings.
Input: JSON file path as arg (or stdin)
Output: JSON to stdout with clusters, assignments, labels, 2D coordinates.
"""

import sys
import json
import numpy as np
import psycopg2

def main():
    # Read input
    if len(sys.argv) > 1:
        with open(sys.argv[1], 'r') as f:
            config = json.load(f)
    else:
        config = json.load(sys.stdin)

    db_url = config['db_url']
    keyword = config['keyword']
    min_cluster_size = config.get('min_cluster_size', None)
    min_samples = config.get('min_samples', None)
    umap_dims = config.get('umap_dims', 50)

    # 1. Fetch embeddings from pgvector DB
    conn = psycopg2.connect(db_url)
    cur = conn.cursor()
    cur.execute(
        "SELECT video_id, title, embedding FROM niche_video_vectors WHERE keyword = %s",
        (keyword,)
    )
    rows = cur.fetchall()
    conn.close()

    if len(rows) < 10:
        print(json.dumps({
            "error": f"Only {len(rows)} embedded videos for '{keyword}'. Need at least 10.",
            "num_clusters": 0, "num_noise": 0, "total_videos": len(rows),
            "clusters": [], "assignments": []
        }))
        return

    video_ids = [r[0] for r in rows]
    titles = [r[1] or '' for r in rows]

    # Parse embeddings — pgvector returns string like "[0.1,0.2,...]"
    embeddings = []
    for r in rows:
        emb = r[2]
        if isinstance(emb, str):
            emb = emb.strip('[]')
            emb = [float(x) for x in emb.split(',')]
        embeddings.append(emb)

    X = np.array(embeddings, dtype=np.float32)
    n = X.shape[0]
    dim = X.shape[1]

    sys.stderr.write(f"[cluster] {n} videos, {dim} dims for '{keyword}'\n")

    # 2. Auto-tune min_cluster_size
    if min_cluster_size is None:
        min_cluster_size = max(5, int(n * 0.02))
    if min_samples is None:
        min_samples = max(3, min_cluster_size // 2)

    sys.stderr.write(f"[cluster] min_cluster_size={min_cluster_size}, min_samples={min_samples}\n")

    # 3. UMAP reduce to umap_dims for clustering
    from umap import UMAP

    reducer_cluster = UMAP(
        n_components=umap_dims,
        n_neighbors=15,
        metric='cosine',
        random_state=42,
        verbose=False
    )
    X_reduced = reducer_cluster.fit_transform(X)
    sys.stderr.write(f"[cluster] UMAP {dim}D -> {umap_dims}D done\n")

    # 4. HDBSCAN clustering
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

    # 5. UMAP reduce to 2D for scatter plot
    reducer_2d = UMAP(
        n_components=2,
        n_neighbors=15,
        metric='cosine',
        random_state=42,
        verbose=False
    )
    X_2d = reducer_2d.fit_transform(X)
    sys.stderr.write(f"[cluster] UMAP {dim}D -> 2D done\n")

    # 6. TF-IDF labeling per cluster
    from sklearn.feature_extraction.text import TfidfVectorizer
    import re

    # Clean titles for TF-IDF
    def clean_title(t):
        t = re.sub(r'[^\w\s]', ' ', t.lower())
        t = re.sub(r'\s+', ' ', t).strip()
        # Remove very common YouTube words
        stopwords = {'how', 'to', 'the', 'a', 'an', 'i', 'my', 'you', 'your', 'this', 'that',
                     'is', 'are', 'was', 'were', 'in', 'on', 'for', 'with', 'and', 'or', 'of',
                     'from', 'it', 'its', 'can', 'do', 'will', 'be', 'no', 'not', 'but', 'so',
                     'just', 'get', 'got', 'make', 'made', 'using', 'use', 'new', 'best',
                     'top', 'full', 'guide', 'tutorial', 'video', 'videos', 'watch'}
        words = [w for w in t.split() if w not in stopwords and len(w) > 2]
        return ' '.join(words)

    cluster_indices = sorted(set(labels) - {-1})
    cluster_labels = {}

    if num_clusters > 1:
        # Build per-cluster document (all titles concatenated)
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
                cluster_labels[ci] = ' '.join(top_terms[:3]) if top_terms else f'Cluster {ci}'
        except Exception as e:
            sys.stderr.write(f"[cluster] TF-IDF labeling error: {e}\n")
            for ci in cluster_indices:
                cluster_labels[ci] = f'Cluster {ci}'
    elif num_clusters == 1:
        cluster_labels[cluster_indices[0]] = keyword

    # 7. Build output
    clusters_out = []
    for ci in cluster_indices:
        mask = labels == ci
        indices = np.where(mask)[0]
        count = int(np.sum(mask))

        # Centroid in 2D
        centroid_2d = X_2d[mask].mean(axis=0).tolist()

        # Representative video (closest to centroid in reduced space)
        cluster_reduced = X_reduced[mask]
        centroid_reduced = cluster_reduced.mean(axis=0)
        distances = np.linalg.norm(cluster_reduced - centroid_reduced, axis=1)
        rep_idx = indices[distances.argmin()]
        rep_video_id = video_ids[rep_idx]

        # Top titles for AI labeling later
        top_title_indices = indices[:10]

        clusters_out.append({
            'cluster_index': int(ci),
            'video_count': count,
            'auto_label': cluster_labels.get(ci, f'Cluster {ci}'),
            'representative_video_id': int(rep_video_id),
            'centroid_2d': [round(c, 4) for c in centroid_2d],
            'video_ids': [int(video_ids[i]) for i in indices],
            'top_titles': [titles[i] for i in top_title_indices],
        })

    # Assignments
    assignments_out = []
    for i in range(n):
        ci = int(labels[i])
        # Distance to cluster centroid (in reduced space)
        if ci >= 0:
            mask = labels == ci
            centroid = X_reduced[mask].mean(axis=0)
            dist = float(np.linalg.norm(X_reduced[i] - centroid))
        else:
            dist = -1.0

        assignments_out.append({
            'video_id': int(video_ids[i]),
            'cluster_index': ci,
            'x_2d': round(float(X_2d[i][0]), 4),
            'y_2d': round(float(X_2d[i][1]), 4),
            'distance': round(dist, 4),
        })

    result = {
        'num_clusters': num_clusters,
        'num_noise': num_noise,
        'total_videos': n,
        'clusters': clusters_out,
        'assignments': assignments_out,
    }

    print(json.dumps(result))


if __name__ == '__main__':
    main()
