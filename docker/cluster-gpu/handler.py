"""
RunPod Serverless handler for GPU-accelerated niche clustering.

The Railway side POSTs to /run with an `input` payload that mirrors the
config JSON the existing CPU pipeline writes to a tmpfile and pipes via
stdin. We dump that payload to /tmp/config.json, force use_gpu=True,
and shell out to /app/cluster-niches.py — identical interface to the
local CPU run, just executed on a CUDA box.

Why subprocess instead of importing?
  Each /run invocation gets a fresh process anyway (RunPod recycles
  the worker between jobs), and shelling out keeps the script's stderr
  → stdout separation intact. The CPU and GPU paths therefore exercise
  the SAME script with the SAME I/O contract.

Input shape (event["input"]):
  {
    "db_url":           "postgres://...",          # required
    "video_ids":        [int, ...] | null,         # null = all rows
    "source":           "combined_v2",             # or title_v2 / thumbnail_v2 / etc.
    "min_cluster_size": 80,
    "min_samples":      10,
    "umap_dims":        50,
    "n_neighbors":      5,                         # optional
    "compute_2d":       false,                     # optional, default true
    "outlier_iqr_mult": 3.0,                       # optional
    "keyword":          "global"                   # sentinel for the script's logging path
  }

Output (returned to the caller verbatim):
  Whatever cluster-niches.py prints on stdout — i.e. the same JSON
  shape the Node-side parser already understands. On error the handler
  returns { "error": "...", "stderr_tail": "..." } and sets the
  RunPod job status to failed.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from typing import Any

import runpod


SCRIPT_PATH = '/app/cluster-niches.py'


def handler(event: dict[str, Any]) -> dict[str, Any]:
    """Entrypoint invoked once per RunPod job."""
    payload = event.get('input') or {}

    if not isinstance(payload, dict):
        return {'error': f'expected dict input, got {type(payload).__name__}'}

    # The CPU pipeline writes its config to a tmpfile and passes the
    # path as argv[1]. We do the same — keeps the handler trivial and
    # the script's interface unchanged.
    payload['use_gpu'] = True

    if not payload.get('db_url'):
        return {'error': 'db_url is required in input payload'}

    # Cluster-niches.py treats missing/empty video_ids as "all rows in
    # the source table", which is what we want for global L1 runs.
    payload.setdefault('keyword', 'global')

    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as fh:
        json.dump(payload, fh)
        config_path = fh.name

    started = time.monotonic()
    try:
        proc = subprocess.Popen(
            ['python3', '-u', SCRIPT_PATH, config_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd='/app',
            env={**os.environ, 'PYTHONUNBUFFERED': '1'},
        )

        # Stream stderr to *our* stderr so RunPod's log viewer shows the
        # per-stage progress lines ([cluster] UMAP done, etc.) in
        # near-real-time. stdout is captured silently — it's the
        # result JSON we return to the caller.
        stderr_tail: list[str] = []
        stdout_chunks: list[bytes] = []

        # Read stdout off the main thread via communicate(); stderr
        # gets a small background drain loop so we don't deadlock on
        # large stderr buffers.
        import threading

        def drain_stderr():
            assert proc.stderr is not None
            for raw in iter(proc.stderr.readline, b''):
                line = raw.decode('utf-8', errors='replace').rstrip('\n')
                sys.stderr.write(line + '\n')
                sys.stderr.flush()
                stderr_tail.append(line)
                # Keep memory bounded — only the last 200 lines.
                if len(stderr_tail) > 200:
                    del stderr_tail[: len(stderr_tail) - 200]

        t = threading.Thread(target=drain_stderr, daemon=True)
        t.start()

        assert proc.stdout is not None
        stdout_bytes = proc.stdout.read()
        rc = proc.wait()
        t.join(timeout=2)
        elapsed = time.monotonic() - started

        if rc != 0:
            return {
                'error': f'cluster-niches.py exited with code {rc}',
                'stderr_tail': '\n'.join(stderr_tail[-80:]),
                'elapsed_seconds': round(elapsed, 1),
            }

        # Script prints exactly one JSON object on stdout. Parse it and
        # return verbatim so the Node side's parser keeps working.
        text = stdout_bytes.decode('utf-8', errors='replace').strip()
        try:
            result = json.loads(text)
        except json.JSONDecodeError as e:
            return {
                'error': f'failed to parse script stdout as JSON: {e}',
                'stdout_head': text[:500],
                'stderr_tail': '\n'.join(stderr_tail[-40:]),
                'elapsed_seconds': round(elapsed, 1),
            }

        # Attach handler-side metadata so callers can sanity-check
        # which backend produced the run.
        result.setdefault('runtime', {})
        result['runtime'].update({
            'gpu': True,
            'elapsed_seconds': round(elapsed, 1),
            'cuda_visible_devices': os.environ.get('CUDA_VISIBLE_DEVICES'),
        })
        return result

    finally:
        try:
            os.unlink(config_path)
        except OSError:
            pass


if __name__ == '__main__':
    runpod.serverless.start({'handler': handler})
