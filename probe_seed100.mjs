/**
 * 100 /api/niche-spy/video-seed/expand calls against fresh unembedded
 * videos with live thumbnails, after:
 *   - static SOCKS5 proxy pool plugged in
 *   - key pool swept down to 119 active (mostly clean)
 *   - video-seed embed path moved through fetchViaProxy
 *
 * Compare against pre-fix run: 71% fully ok, 17% partial, 12% fail.
 */
import pg from 'pg';
const { Pool } = pg;

const TOKEN = 'hba_bee5391e36d740b9e3b9a2033165dacc8177dc1abba82c936617819bda3b47cf';
const BASE = 'https://rofe.ai';
const N_TESTS = 100;
const WORKERS = 6;
const PER_TEST_CANDIDATES = 3;
const NEEDED = N_TESTS * (1 + PER_TEST_CANDIDATES);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const r = await pool.query(`
  SELECT url, thumbnail FROM niche_spy_videos
   WHERE combined_embedding_v2 IS NULL
     AND thumbnail IS NOT NULL AND length(thumbnail) > 0
     AND fetched_at IS NOT NULL
   ORDER BY fetched_at DESC LIMIT 3000`);
await pool.end();
console.log(`Sampled ${r.rows.length} recent unembedded rows. Pre-filtering by thumbnail liveness...`);

const live = [];
let liveIdx = 0;
async function liveWorker() {
  while (liveIdx < r.rows.length && live.length < NEEDED + 50) {
    const row = r.rows[liveIdx++];
    if (!row) return;
    try {
      const res = await fetch(row.thumbnail, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
      if (res.ok) live.push(row.url);
    } catch { /* dead */ }
  }
}
const lT0 = Date.now();
await Promise.all(Array.from({ length: 16 }, () => liveWorker()));
console.log(`Live filter: ${live.length}/${liveIdx} live (${(live.length*100/liveIdx).toFixed(1)}%) in ${Date.now()-lT0}ms`);
if (live.length < (1 + PER_TEST_CANDIDATES)) { console.error('not enough live URLs'); process.exit(1); }

const tests = Array.from({ length: N_TESTS }, () => {
  const shuffled = [...live].sort(() => Math.random() - 0.5);
  return { seedUrl: shuffled[0], candidateUrls: shuffled.slice(1, 1 + PER_TEST_CANDIDATES) };
});

const results = [];
let idx = 0;
async function worker() {
  while (true) {
    const myIdx = idx++;
    if (myIdx >= tests.length) return;
    const t = tests[myIdx];
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE}/api/niche-spy/video-seed/expand`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...t, topK: PER_TEST_CANDIDATES }),
        signal: AbortSignal.timeout(180_000),
      });
      const j = await res.json();
      const elapsed = Date.now() - t0;
      if (!j.ok) {
        results.push({ i: myIdx, ok: false, elapsed, error: (j.error || '').slice(0, 120) });
      } else {
        const seedErr = j.seed?.embedError;
        const sims = (j.candidates || []).map(c => c.similarity).filter(s => s != null);
        const errs = (j.candidates || []).map(c => c.error).filter(Boolean);
        results.push({
          i: myIdx, ok: !seedErr && sims.length === PER_TEST_CANDIDATES,
          seedErr, sims, errCount: errs.length, errSample: errs[0]?.slice(0, 100), elapsed,
        });
      }
    } catch (e) {
      results.push({ i: myIdx, ok: false, elapsed: Date.now() - t0, error: e.message?.slice(0, 120) });
    }
    if ((myIdx + 1) % 10 === 0) {
      process.stderr.write(`  progress: ${myIdx+1}/${N_TESTS}  ok=${results.filter(x=>x.ok).length}\n`);
    }
  }
}
const tStart = Date.now();
await Promise.all(Array.from({ length: WORKERS }, () => worker()));
const total = Date.now() - tStart;

const ok = results.filter(r => r.ok).length;
const partial = results.filter(r => !r.ok && r.sims && r.sims.length > 0).length;
const fail = results.length - ok;
const latencies = results.map(r => r.elapsed).sort((a, b) => a - b);
console.log(`\n=== Summary (${total}ms wall, ${WORKERS} workers, ALL fresh live videos) ===`);
console.log(`  fully ok: ${ok}/${results.length} (${(ok*100/results.length).toFixed(1)}%)`);
console.log(`  partial: ${partial}`);
console.log(`  full fail: ${fail - partial}`);
console.log(`  latency: p50=${latencies[Math.floor(latencies.length*0.5)]}ms p95=${latencies[Math.floor(latencies.length*0.95)]}ms p99=${latencies[Math.floor(latencies.length*0.99)]}ms`);

const allSims = results.flatMap(r => r.sims ?? []);
if (allSims.length) {
  const lo = Math.min(...allSims), hi = Math.max(...allSims);
  const mean = allSims.reduce((a, b) => a + b, 0) / allSims.length;
  console.log(`  similarities: ${allSims.length} | min=${lo.toFixed(4)} mean=${mean.toFixed(4)} max=${hi.toFixed(4)}`);
}
const errCounts = new Map();
for (const r of results) {
  if (r.ok) continue;
  const key = r.error?.slice(0, 60) || r.seedErr?.slice(0, 60) || r.errSample?.slice(0, 60) || 'unknown';
  errCounts.set(key, (errCounts.get(key) ?? 0) + 1);
}
if (errCounts.size) {
  console.log(`\n=== Failure modes ===`);
  for (const [k, v] of [...errCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${v}× ${k}`);
}
