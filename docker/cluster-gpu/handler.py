"""
RunPod Serverless handler for GPU-accelerated niche clustering.

Two operating modes the Railway side can dispatch:

  mode='cluster'  (default)
    One-shot UMAP+HDBSCAN over a single set of video_ids. Used by
    standalone subdivide requests (POST /api/admin/niche-tree/cluster/
    :id/subdivide). Payload mirrors the config the local CPU pipeline
    writes to a tmpfile and pipes via stdin — same script, same I/O.

  mode='global_bake'  (the L1 path when executionMode='gpu')
    Single container start covers L1 plus every qualifying L2
    subdivide. Avoids paying RunPod's ~30s cold start per L2 in a 50-
    cluster bake. Each L2 still re-fetches its slice from Railway PG
    (cheaper than re-loading the whole 3072d × 393k corpus), but the
    GPU + cuML cache stay warm so per-L2 wall time is ~30–60s.

Output:
  - 'cluster' mode → cluster-niches.py's JSON verbatim.
  - 'global_bake' mode → {
        l1: <cluster-niches.py result>,
        l2: {
          by_parent_cluster_index: { '<idx>': <cluster-niches.py result>, ... },
          baked: int, skipped: int, errors: int,
        },
        runtime: { ... }
      }

Why subprocess instead of importing cluster-niches.py?
  Each call gets a clean Python interpreter, isolating UMAP/HDBSCAN
  state across runs (the libraries are not great about cleaning up
  globals). The fresh-interpreter cost is ~5s of cuML import; for L2
  subdivides each completes in 30–60s anyway, so the overhead is
  noise. If we ever push L2 to many small subdivides we can refactor
  cluster-niches.py to expose a library entrypoint.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Optional

import runpod
import psycopg2


SCRIPT_PATH = '/app/cluster-niches.py'


class PgLogSink:
    """Background writer that ships subprocess stderr lines to the
    Railway pgvector DB so the Node side can stream them into the
    niche-tree run's recentLogs without polling RunPod (which has no
    public log endpoint for serverless jobs).

    Lazy-opens one psycopg2 connection. Buffers lines; flushes every
    ~500ms or when the buffer hits 20 lines. Errors are swallowed —
    losing a few log lines must never break the actual clustering job.
    """

    def __init__(self, db_url: Optional[str], job_id: Optional[str]) -> None:
        self.db_url = db_url
        self.job_id = job_id
        self.enabled = bool(db_url and job_id)
        self._buf: list[str] = []
        self._lock = threading.Lock()
        self._stopped = False
        self._conn = None  # psycopg2 connection, lazy
        self._thread = threading.Thread(target=self._flush_loop, daemon=True) if self.enabled else None
        if self._thread:
            self._thread.start()

    def write(self, line: str) -> None:
        if not self.enabled:
            return
        with self._lock:
            self._buf.append(line)

    def _ensure_conn(self):
        if self._conn is None:
            self._conn = psycopg2.connect(self.db_url, connect_timeout=15)
            self._conn.autocommit = True
        return self._conn

    def _flush_once(self):
        with self._lock:
            if not self._buf:
                return
            lines = self._buf[:]
            self._buf.clear()
        try:
            conn = self._ensure_conn()
            with conn.cursor() as cur:
                # Multi-row insert keeps round-trips low when the
                # subprocess emits a burst (e.g. UMAP done + HDBSCAN
                # results + per-cluster labels back-to-back).
                vals = b','.join(
                    cur.mogrify('(%s, %s)', (self.job_id, line)) for line in lines
                )
                cur.execute(b'INSERT INTO runpod_job_logs (job_id, line) VALUES ' + vals)
        except Exception as e:
            sys.stderr.write(f'[pg-log] flush failed: {e}\n')
            # Tear down the connection so the next attempt reopens.
            try:
                if self._conn is not None:
                    self._conn.close()
            except Exception:
                pass
            self._conn = None

    def _flush_loop(self):
        while not self._stopped:
            time.sleep(0.5)
            self._flush_once()
        # Final flush on stop so trailing lines aren't dropped.
        self._flush_once()

    def stop(self):
        self._stopped = True
        if self._thread is not None:
            self._thread.join(timeout=3)
        try:
            if self._conn is not None:
                self._conn.close()
        except Exception:
            pass


def _run_one_clustering(payload: dict[str, Any], log_sink: Optional[PgLogSink] = None) -> tuple[dict[str, Any] | None, str, list[str], float]:
    """Subprocess one invocation of cluster-niches.py with `payload`.

    Returns (result_dict, error_str, stderr_tail, elapsed_seconds).
    On success: result_dict is the parsed JSON, error_str is ''.
    On failure: result_dict is None, error_str describes the failure.

    When `log_sink` is provided, every stderr line is also forwarded
    to it (PG insert) — that's how the Node side gets live progress
    during a global_bake.
    """
    payload = {**payload, 'use_gpu': True}
    payload.setdefault('keyword', 'global')

    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as fh:
        json.dump(payload, fh)
        config_path = fh.name

    started = time.monotonic()
    stderr_tail: list[str] = []
    try:
        proc = subprocess.Popen(
            ['python3', '-u', SCRIPT_PATH, config_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd='/app',
            env={**os.environ, 'PYTHONUNBUFFERED': '1'},
        )

        def drain_stderr():
            assert proc.stderr is not None
            for raw in iter(proc.stderr.readline, b''):
                line = raw.decode('utf-8', errors='replace').rstrip('\n')
                sys.stderr.write(line + '\n')
                sys.stderr.flush()
                stderr_tail.append(line)
                if len(stderr_tail) > 400:
                    del stderr_tail[: len(stderr_tail) - 400]
                if log_sink is not None:
                    log_sink.write(line)

        t = threading.Thread(target=drain_stderr, daemon=True)
        t.start()

        assert proc.stdout is not None
        stdout_bytes = proc.stdout.read()
        rc = proc.wait()
        t.join(timeout=2)
        elapsed = time.monotonic() - started

        if rc != 0:
            return (None,
                    f'cluster-niches.py exited with code {rc}',
                    stderr_tail,
                    elapsed)

        text = stdout_bytes.decode('utf-8', errors='replace').strip()
        try:
            result = json.loads(text)
        except json.JSONDecodeError as e:
            return (None,
                    f'failed to parse script stdout as JSON: {e}; head={text[:300]}',
                    stderr_tail,
                    elapsed)

        if isinstance(result, dict) and result.get('error'):
            return (None, str(result['error']), stderr_tail, elapsed)

        return (result, '', stderr_tail, elapsed)
    finally:
        try:
            os.unlink(config_path)
        except OSError:
            pass


def _handle_cluster(payload: dict[str, Any], log_sink: Optional[PgLogSink] = None) -> dict[str, Any]:
    """Existing single-cluster mode — payload is forwarded verbatim."""
    result, err, stderr_tail, elapsed = _run_one_clustering(payload, log_sink=log_sink)
    if result is None:
        return {
            'error': err,
            'stderr_tail': '\n'.join(stderr_tail[-80:]),
            'elapsed_seconds': round(elapsed, 1),
        }
    result.setdefault('runtime', {}).update({
        'mode': 'cluster',
        'gpu': True,
        'elapsed_seconds': round(elapsed, 1),
        'cuda_visible_devices': os.environ.get('CUDA_VISIBLE_DEVICES'),
    })
    return result


def _handle_global_bake(payload: dict[str, Any], log_sink: Optional[PgLogSink] = None) -> dict[str, Any]:
    # Local emit helper — sends handler's own markers to BOTH stderr
    # (RunPod dashboard) AND the PG sink (visible from Node-side
    # niche-tree run logs). Without this, [bake] L1/L2 lines only
    # appeared in RunPod's console and couldn't be queried via our
    # /admin/tools/runpod-logs endpoint.
    def _emit(line: str) -> None:
        sys.stderr.write(line + '\n')
        sys.stderr.flush()
        if log_sink is not None:
            log_sink.write(line)
    """L1 + L2 in one container session.

    Input shape:
      {
        mode: 'global_bake',
        db_url: '...',
        source: 'combined_v2',
        l1: { min_cluster_size, min_samples, umap_dims, n_neighbors?,
              outlier_iqr_mult?, min_score?, video_ids? },
        l2: { min_parent_size: 200, min_cluster_size?, min_samples?,
              umap_dims?, n_neighbors?, outlier_iqr_mult? }
      }

    The l1 section is forwarded almost verbatim to cluster-niches.py.
    After L1 completes, we walk its `clusters` array and for every
    cluster where size >= l2.min_parent_size we run cluster-niches.py
    again with that cluster's video_ids and the L2 params.
    """
    db_url = payload.get('db_url')
    if not db_url:
        return {'error': 'db_url is required in input payload'}

    source = payload.get('source', 'combined_v2')
    l1_cfg: dict[str, Any] = dict(payload.get('l1') or {})
    l2_cfg: dict[str, Any] = dict(payload.get('l2') or {})

    started = time.monotonic()

    # ---- L1 ---------------------------------------------------------
    l1_payload = {
        'db_url': db_url,
        'source': source,
        'keyword': '__global__',
        'video_ids': l1_cfg.get('video_ids'),
        'min_cluster_size': l1_cfg.get('min_cluster_size', 80),
        'min_samples':      l1_cfg.get('min_samples', 10),
        'umap_dims':        l1_cfg.get('umap_dims', 50),
        'n_neighbors':      l1_cfg.get('n_neighbors', 5),
        'compute_2d':       False,
        'outlier_iqr_mult': l1_cfg.get('outlier_iqr_mult', 3.0),
    }
    _emit(f"[bake] L1 starting (min_cluster_size={l1_payload['min_cluster_size']})")
    l1_result, l1_err, l1_stderr, l1_elapsed = _run_one_clustering(l1_payload, log_sink=log_sink)
    if l1_result is None:
        return {
            'error': f'L1 failed: {l1_err}',
            'stderr_tail': '\n'.join(l1_stderr[-100:]),
            'elapsed_seconds': round(time.monotonic() - started, 1),
        }
    _emit(f"[bake] L1 done in {l1_elapsed:.1f}s: "
          f"{l1_result.get('num_clusters', 0)} clusters, "
          f"{l1_result.get('num_noise', 0)} noise")

    # ---- L2 (per qualifying L1 cluster) -----------------------------
    min_parent = int(l2_cfg.get('min_parent_size', 200))
    l2_by_parent: dict[str, Any] = {}
    baked = 0
    skipped_small = 0
    errors = 0
    error_details: list[dict[str, Any]] = []

    l1_clusters = l1_result.get('clusters') or []
    # Sort biggest-first so we get visible progress on the most
    # impactful niches early in the run.
    l1_clusters_sorted = sorted(
        l1_clusters,
        key=lambda c: int(c.get('video_count') or 0),
        reverse=True,
    )

    for cluster in l1_clusters_sorted:
        cluster_idx = cluster.get('cluster_index')
        video_ids = cluster.get('video_ids') or []
        if not isinstance(cluster_idx, int):
            continue
        if len(video_ids) < min_parent:
            skipped_small += 1
            continue

        # L2 min_cluster_size: caller can pin it via l2_cfg, otherwise
        # scale to ~2% of parent size (matches the Node side default
        # for L2 baking).
        sub_min_cluster = l2_cfg.get('min_cluster_size')
        if sub_min_cluster is None:
            sub_min_cluster = max(10, round(len(video_ids) * 0.02))
        sub_min_samples = l2_cfg.get('min_samples')
        if sub_min_samples is None:
            sub_min_samples = max(3, min(int(sub_min_cluster), 10))

        l2_payload = {
            'db_url': db_url,
            'source': source,
            'keyword': f'subdivide:{cluster_idx}',
            'video_ids': video_ids,
            'min_cluster_size': int(sub_min_cluster),
            'min_samples':      int(sub_min_samples),
            'umap_dims':        int(l2_cfg.get('umap_dims', 50)),
            'n_neighbors':      int(l2_cfg.get('n_neighbors', 5)),
            'compute_2d':       False,
            'outlier_iqr_mult': float(l2_cfg.get('outlier_iqr_mult', 3.0)),
        }
        _emit(f"[bake] L2 cluster {cluster_idx} ({len(video_ids)} vids) starting")
        sub_result, sub_err, sub_stderr, sub_elapsed = _run_one_clustering(l2_payload, log_sink=log_sink)
        if sub_result is None:
            errors += 1
            error_details.append({
                'parent_cluster_index': cluster_idx,
                'error': sub_err,
                'stderr_tail': '\n'.join(sub_stderr[-30:]),
            })
            _emit(f"[bake] L2 cluster {cluster_idx} FAILED: {sub_err[:200]}")
            continue
        l2_by_parent[str(cluster_idx)] = sub_result
        baked += 1
        _emit(f"[bake] L2 cluster {cluster_idx} done in {sub_elapsed:.1f}s: "
              f"{sub_result.get('num_clusters', 0)} sub-clusters, "
              f"{sub_result.get('num_noise', 0)} noise")

    elapsed = time.monotonic() - started
    _emit(f"[bake] done in {elapsed:.1f}s — L1 + {baked} L2 baked "
          f"({skipped_small} skipped <{min_parent}, {errors} errors)")

    return {
        'l1': l1_result,
        'l2': {
            'by_parent_cluster_index': l2_by_parent,
            'baked': baked,
            'skipped_small': skipped_small,
            'errors': errors,
            'error_details': error_details,
            'min_parent_size': min_parent,
        },
        'runtime': {
            'mode': 'global_bake',
            'gpu': True,
            'elapsed_seconds': round(elapsed, 1),
            'cuda_visible_devices': os.environ.get('CUDA_VISIBLE_DEVICES'),
        },
    }


def handler(event: dict[str, Any]) -> dict[str, Any]:
    """Entrypoint invoked once per RunPod job."""
    payload = event.get('input') or {}
    if not isinstance(payload, dict):
        return {'error': f'expected dict input, got {type(payload).__name__}'}

    mode = (payload.get('mode') or 'cluster').lower()

    # Open a PG sink for live progress streaming to Node. job_id comes
    # from the RunPod event envelope (event["id"]); the DB URL is the
    # same one the script uses to fetch embeddings, so no extra config.
    # If db_url is missing we skip silently — Node side will get no
    # progress but the actual clustering still works.
    job_id = event.get('id')
    db_url = payload.get('db_url')
    sink = PgLogSink(db_url=db_url if isinstance(db_url, str) else None,
                     job_id=job_id if isinstance(job_id, str) else None)
    if sink.enabled:
        sink.write(f'[handler] mode={mode} job_id={job_id}')

    try:
        if mode == 'global_bake':
            return _handle_global_bake(payload, log_sink=sink)
        return _handle_cluster(payload, log_sink=sink)
    finally:
        # Final flush so trailing per-stage lines reach Node before
        # the worker scales down (idle_timeout=5s).
        sink.stop()


if __name__ == '__main__':
    runpod.serverless.start({'handler': handler})
