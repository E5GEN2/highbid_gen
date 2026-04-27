/**
 * xgodo job-level bucket helpers.
 *
 * Wraps the employer-facing bucket endpoints added 2026-04-27:
 *   GET    /api/v2/bucket/:job_id            — list every (job, device) bucket
 *   GET    /api/v2/bucket/:job_id/:device_id — read one
 *   PUT    /api/v2/bucket/:job_id/:device_id — replace (no merge)
 *   DELETE /api/v2/bucket/:job_id            — wipe all
 *   DELETE /api/v2/bucket/:job_id/:device_id — wipe one
 *
 * These work for ALL task statuses (we no longer need a running task_id),
 * which lets us read per-device state for the Vizard YT-upload reporting
 * dashboard regardless of whether a task is in flight.
 */

const XGODO_API = 'https://xgodo.com/api/v2';

export interface XgodoJobBucket {
  _id: string;
  job_id: string;
  remote_device_id: string;
  data: Record<string, unknown>;
  updated_at: string;
  device_name: string | null;
}

export interface ListJobBucketsResp {
  buckets: XgodoJobBucket[];
  total: number;
  page: number;
  pages: number;
}

/**
 * List every bucket attached to a job. Pages internally and returns the
 * concatenated list. Caller must own the job (or have it shared with at
 * least `view`). Empty list on 404.
 *
 * Page size is capped at 100 by xgodo, so for large jobs we walk pages.
 */
export async function listJobBuckets(
  token: string,
  jobId: string,
  opts: { pageSize?: number; maxPages?: number } = {}
): Promise<XgodoJobBucket[]> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 1), 100);
  const maxPages = opts.maxPages ?? 20; // 2000 buckets ceiling — way more than we'd ever have
  const out: XgodoJobBucket[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = `${XGODO_API}/bucket/${jobId}?page=${page}&limit=${pageSize}`;
    const r = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (r.status === 404) return out; // job inaccessible / no buckets at all
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`xgodo list buckets ${r.status}: ${text.slice(0, 200)}`);
    }

    const body = (await r.json()) as ListJobBucketsResp;
    if (!Array.isArray(body.buckets) || body.buckets.length === 0) break;
    out.push(...body.buckets);

    // Stop once we've consumed every page xgodo reported.
    if (body.pages && page >= body.pages) break;
    if (body.buckets.length < pageSize) break;
  }

  return out;
}

/** Read a single (job, device) bucket. Returns null on 404 (no bucket yet). */
export async function getJobDeviceBucket(
  token: string,
  jobId: string,
  deviceId: string
): Promise<XgodoJobBucket | null> {
  const r = await fetch(`${XGODO_API}/bucket/${jobId}/${deviceId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`xgodo get bucket ${r.status}: ${text.slice(0, 200)}`);
  }
  const body = (await r.json()) as { bucket: XgodoJobBucket };
  return body.bucket || null;
}
