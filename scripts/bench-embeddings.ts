/**
 * Embedding strategy benchmark — real production workload.
 *
 * Runs the same embed-batch.py path against the real xgodo USA proxy
 * pool and the real AI Studio key inventory, embedding videos that
 * actually need thumbnail_v2 embeddings. Successful embeddings get
 * written back to the DB so the bench is also useful work, not throw-
 * away. Each strategy gets its own slice of the corpus so we never
 * double-write the same row.
 *
 * Goal: find the combination of (concurrency × rotation × ban policy)
 * that maximises successful embeds per minute and minimises wasted
 * 429s. Winning strategy gets ported back to lib/embeddings.ts.
 *
 * Usage:
 *   set -a && source .env.local && set +a
 *   npx tsx scripts/bench-embeddings.ts
 *
 *   CORPUS=400 THREADS=20 npx tsx scripts/bench-embeddings.ts
 *   STRATEGY='round-robin' npx tsx scripts/bench-embeddings.ts
 *
 * Env vars:
 *   CORPUS    — total videos to embed across all strategies (default 200)
 *   THREADS   — concurrent workers per strategy run (default 10)
 *   BATCH     — videos per API call (default 5; max 100)
 *   STRATEGY  — substring match against strategy name (default: all)
 *   DRY_RUN   — '1' to skip DB writes (still measures everything else)
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getPool } from '@/lib/db';
import { getProxies, type ProxyInfo, reloadProxies } from '@/lib/xgodo-proxy';

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');
const MODEL = 'gemini-embedding-2-preview';
const COL = 'thumbnail_embedding_v2';
const STAMP = 'thumbnail_embedded_v2_at';

interface Pair { key: string; proxyUrl: string; proxyDeviceId: string; }
interface CorpusItem { id: number; thumbnailUrl: string; mimeType: string; data: string; }

type ErrorKind = 'rate_limit' | 'auth_denied' | 'proxy' | 'short' | 'other';
interface BatchResult {
  ok: boolean;
  pair: Pair;
  itemIds: number[];
  embeddings?: number[][];   // present iff ok
  startedAt: number;
  durationMs: number;
  errorKind?: ErrorKind;
  errorMsg?: string;
  embeddingsReturned: number;
}

interface StrategyMetrics {
  name: string;
  threads: number;
  totalWallMs: number;
  totalBatches: number;
  successfulBatches: number;
  failedBatches: number;
  errorBreakdown: Record<ErrorKind, number>;
  embedsReturned: number;
  embedsAttempted: number;
  throughputPerSec: number;
  uniqueKeysUsed: number;
  uniqueProxiesUsed: number;
  keyHistogram: { p50: number; p90: number; p99: number; max: number };
  dbWritten: number;
}

// ── Pair sources ──────────────────────────────────────────────────────
async function loadKeys(): Promise<string[]> {
  const pool = await getPool();
  const r = await pool.query<{ key: string }>(
    `SELECT key FROM xgodo_api_keys
      WHERE service='google_ai_studio' AND status='active'
        AND (banned_until IS NULL OR banned_until < NOW())
      ORDER BY id ASC`,
  );
  return r.rows.map(row => row.key);
}

function buildPairs(keys: string[], proxies: ProxyInfo[]): Pair[] {
  if (proxies.length === 0) throw new Error('no USA proxies available');
  return keys.map((key, i) => ({
    key,
    proxyUrl: proxies[i % proxies.length].url,
    proxyDeviceId: proxies[i % proxies.length].deviceId.slice(0, 8),
  }));
}

// ── Corpus loader (real video rows missing thumbnail_v2) ──────────────
function thumbnailUrlFor(row: { thumbnail: string | null; url: string | null }): string | null {
  if (row.thumbnail && row.thumbnail.trim().length > 0) return row.thumbnail;
  const m = row.url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (m) return `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg`;
  return null;
}

async function fetchImageBase64(url: string): Promise<{ mimeType: string; data: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const mimeType = res.headers.get('content-type')?.split(';')[0].trim() || 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    return { mimeType, data: buf.toString('base64') };
  } catch { return null; }
}

async function buildCorpus(size: number): Promise<CorpusItem[]> {
  const pool = await getPool();
  // Pull 1.5x what we need — some thumbnails will fail to download and
  // get filtered out, so we want headroom.
  const overshoot = Math.ceil(size * 1.5);
  const r = await pool.query<{ id: number; thumbnail: string | null; url: string | null }>(
    `SELECT id, thumbnail, url FROM niche_spy_videos
      WHERE ${COL} IS NULL
        AND ((thumbnail IS NOT NULL AND thumbnail != '') OR (url IS NOT NULL AND url != ''))
      ORDER BY score DESC NULLS LAST
      LIMIT $1`,
    [overshoot],
  );
  const candidates: Array<{ id: number; thumbnailUrl: string }> = [];
  for (const row of r.rows) {
    const url = thumbnailUrlFor(row);
    if (url) candidates.push({ id: row.id, thumbnailUrl: url });
  }
  console.log(`Pre-fetching thumbnails (target ${size}, ${candidates.length} candidates)…`);

  const out: CorpusItem[] = [];
  let inflight = 0;
  let i = 0;
  const CONCURRENCY = 32;
  await new Promise<void>((resolve) => {
    const tick = () => {
      while (inflight < CONCURRENCY && i < candidates.length && out.length < size) {
        const c = candidates[i++];
        inflight++;
        fetchImageBase64(c.thumbnailUrl).then(img => {
          if (img && out.length < size) {
            out.push({ id: c.id, thumbnailUrl: c.thumbnailUrl, mimeType: img.mimeType, data: img.data });
          }
          inflight--;
          if (out.length >= size || (i >= candidates.length && inflight === 0)) {
            resolve();
          } else {
            tick();
          }
        });
      }
      if (i >= candidates.length && inflight === 0) resolve();
    };
    tick();
  });
  console.log(`  → got ${out.length} thumbnails ready (size requested=${size})`);
  return out;
}

// ── One batch call (image embedding via multimodal model) ────────────
async function callEmbed(pair: Pair, items: CorpusItem[]): Promise<BatchResult> {
  const inputs = items.map(it => ({ type: 'image' as const, mimeType: it.mimeType, data: it.data }));
  const tmpFile = path.join(os.tmpdir(), `bench_embed_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({ inputs, key: pair.key, model: MODEL, proxy: pair.proxyUrl }));
  const itemIds = items.map(i => i.id);

  const startedAt = Date.now();
  let stdout = '', stderr = '';
  try {
    const r = await execFileAsync('python3', [path.join(SCRIPTS_DIR, 'embed-batch.py'), tmpFile],
      { timeout: 90_000, maxBuffer: 200 * 1024 * 1024 });
    stdout = String(r.stdout); stderr = String(r.stderr);
  } catch (err) {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const msg = (e.stdout || e.stderr || e.message || '').slice(0, 240);
    return { ok: false, pair, itemIds, startedAt, durationMs: Date.now() - startedAt, errorKind: 'proxy', errorMsg: msg, embeddingsReturned: 0 };
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
  const dur = Date.now() - startedAt;
  void stderr;

  let parsed: unknown;
  try { parsed = JSON.parse(stdout); }
  catch { return { ok: false, pair, itemIds, startedAt, durationMs: dur, errorKind: 'other', errorMsg: stdout.slice(0, 200), embeddingsReturned: 0 }; }

  if (!Array.isArray(parsed)) {
    const errMsg = (parsed as { error?: string })?.error || 'unknown';
    let kind: ErrorKind = 'other';
    if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) kind = 'rate_limit';
    else if (errMsg.includes('403') && errMsg.includes('denied')) kind = 'auth_denied';
    else if (errMsg.includes('curl') || errMsg.includes('Tunnel') || errMsg.includes('Connection')) kind = 'proxy';
    return { ok: false, pair, itemIds, startedAt, durationMs: dur, errorKind: kind, errorMsg: errMsg.slice(0, 200), embeddingsReturned: 0 };
  }

  const embs = parsed as number[][];
  const valid = embs.filter(e => Array.isArray(e) && e.length > 0).length;
  if (valid < items.length) {
    return { ok: false, pair, itemIds, startedAt, durationMs: dur, errorKind: 'short', errorMsg: `got ${valid}/${items.length}`, embeddingsReturned: valid };
  }
  return { ok: true, pair, itemIds, embeddings: embs, startedAt, durationMs: dur, embeddingsReturned: valid };
}

// ── DB writeback ─────────────────────────────────────────────────────
async function writeEmbeddings(results: BatchResult[]): Promise<number> {
  if (process.env.DRY_RUN === '1') return 0;
  const pool = await getPool();
  let written = 0;
  for (const r of results) {
    if (!r.ok || !r.embeddings) continue;
    for (let i = 0; i < r.itemIds.length; i++) {
      const e = r.embeddings[i];
      if (!e || e.length === 0) continue;
      try {
        await pool.query(
          `UPDATE niche_spy_videos SET ${COL} = $1::real[], ${STAMP} = NOW() WHERE id = $2`,
          [`{${e.join(',')}}`, r.itemIds[i]],
        );
        written++;
      } catch (err) {
        console.warn(`[bench] DB write failed for id=${r.itemIds[i]}: ${(err as Error).message.slice(0, 120)}`);
      }
    }
  }
  return written;
}

// ── Strategies ───────────────────────────────────────────────────────
type Strategy = (params: { pairs: Pair[]; corpus: CorpusItem[]; threads: number; batchSize: number; }) => Promise<BatchResult[]>;

function makeBatches(corpus: CorpusItem[], batchSize: number): CorpusItem[][] {
  const out: CorpusItem[][] = [];
  for (let i = 0; i < corpus.length; i += batchSize) out.push(corpus.slice(i, i + batchSize));
  return out;
}

// (1) Pinned threads, no ban awareness — current production-ish baseline.
const stratPinned: Strategy = async ({ pairs, corpus, threads, batchSize }) => {
  const batches = makeBatches(corpus, batchSize);
  const results: BatchResult[] = [];
  let nextBatch = 0;
  async function worker(threadId: number) {
    const myPair = pairs[threadId % pairs.length];
    while (true) {
      const idx = nextBatch++;
      if (idx >= batches.length) break;
      const r = await callEmbed(myPair, batches[idx]);
      results.push(r);
    }
  }
  await Promise.all(Array.from({ length: threads }, (_, i) => worker(i)));
  return results;
};

// (2) Global round-robin via shared atomic counter. 5-min ban + retry.
const stratRoundRobin: Strategy = async ({ pairs, corpus, threads, batchSize }) => {
  const batches = makeBatches(corpus, batchSize);
  const results: BatchResult[] = [];
  let nextBatch = 0, pairIdx = 0;
  const banned = new Map<string, number>();
  const BAN_MS = 5 * 60 * 1000;
  function pickPair(): Pair {
    const now = Date.now();
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[(pairIdx + i) % pairs.length];
      const ex = banned.get(p.key);
      if (!ex || ex < now) { pairIdx = (pairIdx + i + 1) % pairs.length; return p; }
    }
    return pairs[pairIdx++ % pairs.length];
  }
  async function worker() {
    while (true) {
      const idx = nextBatch++;
      if (idx >= batches.length) break;
      let attempt = 0, r: BatchResult;
      do {
        const pair = pickPair();
        r = await callEmbed(pair, batches[idx]);
        if (!r.ok && (r.errorKind === 'rate_limit' || r.errorKind === 'auth_denied')) {
          banned.set(pair.key, Date.now() + BAN_MS);
        }
        attempt++;
      } while (!r.ok && attempt < 3 && (r.errorKind === 'rate_limit' || r.errorKind === 'auth_denied' || r.errorKind === 'proxy'));
      results.push(r);
    }
  }
  await Promise.all(Array.from({ length: threads }, () => worker()));
  return results;
};

// (3) Random pick per call from active set. 5-min ban + retry.
const stratRandom: Strategy = async ({ pairs, corpus, threads, batchSize }) => {
  const batches = makeBatches(corpus, batchSize);
  const results: BatchResult[] = [];
  let nextBatch = 0;
  const banned = new Map<string, number>();
  const BAN_MS = 5 * 60 * 1000;
  function pickPair(): Pair {
    const now = Date.now();
    const active = pairs.filter(p => { const e = banned.get(p.key); return !e || e < now; });
    if (active.length === 0) return pairs[Math.floor(Math.random() * pairs.length)];
    return active[Math.floor(Math.random() * active.length)];
  }
  async function worker() {
    while (true) {
      const idx = nextBatch++;
      if (idx >= batches.length) break;
      let attempt = 0, r: BatchResult;
      do {
        const pair = pickPair();
        r = await callEmbed(pair, batches[idx]);
        if (!r.ok && (r.errorKind === 'rate_limit' || r.errorKind === 'auth_denied')) {
          banned.set(pair.key, Date.now() + BAN_MS);
        }
        attempt++;
      } while (!r.ok && attempt < 3 && (r.errorKind === 'rate_limit' || r.errorKind === 'auth_denied' || r.errorKind === 'proxy'));
      results.push(r);
    }
  }
  await Promise.all(Array.from({ length: threads }, () => worker()));
  return results;
};

// (4) Random pick + short ban (30s) — Gemini per-key minute window
//     resets fast, so a 5-min park might leave keys idle longer than needed.
const stratRandomShortBan: Strategy = async ({ pairs, corpus, threads, batchSize }) => {
  const batches = makeBatches(corpus, batchSize);
  const results: BatchResult[] = [];
  let nextBatch = 0;
  const banned = new Map<string, number>();
  const BAN_MS = 30 * 1000;
  function pickPair(): Pair {
    const now = Date.now();
    const active = pairs.filter(p => { const e = banned.get(p.key); return !e || e < now; });
    if (active.length === 0) return pairs[Math.floor(Math.random() * pairs.length)];
    return active[Math.floor(Math.random() * active.length)];
  }
  async function worker() {
    while (true) {
      const idx = nextBatch++;
      if (idx >= batches.length) break;
      let attempt = 0, r: BatchResult;
      do {
        const pair = pickPair();
        r = await callEmbed(pair, batches[idx]);
        if (!r.ok && (r.errorKind === 'rate_limit' || r.errorKind === 'auth_denied')) {
          banned.set(pair.key, Date.now() + BAN_MS);
        }
        attempt++;
      } while (!r.ok && attempt < 3 && (r.errorKind === 'rate_limit' || r.errorKind === 'auth_denied' || r.errorKind === 'proxy'));
      results.push(r);
    }
  }
  await Promise.all(Array.from({ length: threads }, () => worker()));
  return results;
};

// ── Metrics ─────────────────────────────────────────────────────────
function aggregate(name: string, threads: number, wallMs: number, results: BatchResult[], totalAttempted: number, dbWritten: number): StrategyMetrics {
  const errs: Record<ErrorKind, number> = { rate_limit: 0, auth_denied: 0, proxy: 0, short: 0, other: 0 };
  const keyCounts = new Map<string, number>();
  const proxyCounts = new Map<string, number>();
  let succ = 0, fail = 0, embedsReturned = 0;
  for (const r of results) {
    keyCounts.set(r.pair.key, (keyCounts.get(r.pair.key) ?? 0) + 1);
    proxyCounts.set(r.pair.proxyDeviceId, (proxyCounts.get(r.pair.proxyDeviceId) ?? 0) + 1);
    if (r.ok) { succ++; embedsReturned += r.embeddingsReturned; }
    else { fail++; if (r.errorKind) errs[r.errorKind]++; }
  }
  const counts = [...keyCounts.values()].sort((a, b) => a - b);
  const pct = (q: number) => counts.length === 0 ? 0 : counts[Math.floor((counts.length - 1) * q)];
  return {
    name, threads,
    totalWallMs: wallMs, totalBatches: results.length,
    successfulBatches: succ, failedBatches: fail,
    errorBreakdown: errs,
    embedsReturned, embedsAttempted: totalAttempted,
    throughputPerSec: embedsReturned / Math.max(0.001, wallMs / 1000),
    uniqueKeysUsed: keyCounts.size, uniqueProxiesUsed: proxyCounts.size,
    keyHistogram: { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: counts[counts.length - 1] || 0 },
    dbWritten,
  };
}

function printMetrics(m: StrategyMetrics) {
  const sec = (m.totalWallMs / 1000).toFixed(1);
  const errSum = Object.values(m.errorBreakdown).reduce((a, b) => a + b, 0);
  const errPct = m.totalBatches === 0 ? 0 : (errSum / m.totalBatches * 100);
  console.log(`\n── ${m.name} (threads=${m.threads}) ──`);
  console.log(`  wall: ${sec}s  throughput: ${m.throughputPerSec.toFixed(1)} embeds/s  embeds: ${m.embedsReturned}/${m.embedsAttempted}  written-to-DB: ${m.dbWritten}`);
  console.log(`  batches: ${m.successfulBatches} ok / ${m.failedBatches} fail (${errPct.toFixed(1)}% err)`);
  console.log(`  errors: 429=${m.errorBreakdown.rate_limit}  403=${m.errorBreakdown.auth_denied}  proxy=${m.errorBreakdown.proxy}  short=${m.errorBreakdown.short}  other=${m.errorBreakdown.other}`);
  console.log(`  unique keys touched: ${m.uniqueKeysUsed}   unique proxies: ${m.uniqueProxiesUsed}`);
  console.log(`  per-key calls: p50=${m.keyHistogram.p50}  p90=${m.keyHistogram.p90}  p99=${m.keyHistogram.p99}  max=${m.keyHistogram.max}`);
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const corpusSize = parseInt(process.env.CORPUS || '200');
  const threads = parseInt(process.env.THREADS || '10');
  const batchSize = parseInt(process.env.BATCH || '5');
  const only = process.env.STRATEGY;
  const dry = process.env.DRY_RUN === '1';

  console.log(`Bench setup: corpus=${corpusSize} batch=${batchSize} threads=${threads}${only ? ` only="${only}"` : ''}${dry ? ' DRY_RUN=1 (no DB writes)' : ''}`);

  await reloadProxies();
  const proxies = await getProxies();
  const keys = await loadKeys();
  console.log(`Loaded: ${keys.length} active keys, ${proxies.length} USA proxies`);
  if (keys.length === 0 || proxies.length === 0) { console.error('Missing keys or proxies — aborting.'); process.exit(1); }

  const fullCorpus = await buildCorpus(corpusSize);
  const pairs = buildPairs(keys, proxies);

  const all: { name: string; fn: Strategy }[] = [
    { name: 'pinned (no ban)',          fn: stratPinned },
    { name: 'round-robin (5min ban)',   fn: stratRoundRobin },
    { name: 'random (5min ban)',        fn: stratRandom },
    { name: 'random (30s ban)',         fn: stratRandomShortBan },
  ];
  const toRun = only ? all.filter(s => s.name.includes(only)) : all;
  if (toRun.length === 0) { console.error(`No strategy matches "${only}"`); process.exit(1); }

  // Slice the corpus per strategy so we never double-write the same row.
  const sliceSize = Math.floor(fullCorpus.length / toRun.length);
  console.log(`Slicing corpus across ${toRun.length} strategies — ${sliceSize} videos each.\n`);

  const metrics: StrategyMetrics[] = [];
  for (let i = 0; i < toRun.length; i++) {
    const { name, fn } = toRun[i];
    const slice = fullCorpus.slice(i * sliceSize, (i + 1) * sliceSize);
    console.log(`▶ Running: ${name}  (${slice.length} videos in this slice)`);
    const start = Date.now();
    const res = await fn({ pairs, corpus: slice, threads, batchSize });
    const wall = Date.now() - start;
    const written = await writeEmbeddings(res);
    metrics.push(aggregate(name, threads, wall, res, slice.length, written));
  }

  console.log(`\n══ RESULTS ══`);
  for (const m of metrics) printMetrics(m);

  console.log(`\n══ SUMMARY (sorted by throughput) ══`);
  const sorted = [...metrics].sort((a, b) => b.throughputPerSec - a.throughputPerSec);
  console.log(`  strategy                         t/sec    err%   wall    keys-touched   db-written`);
  for (const m of sorted) {
    const errSum = Object.values(m.errorBreakdown).reduce((a, b) => a + b, 0);
    const errPct = m.totalBatches === 0 ? 0 : (errSum / m.totalBatches * 100);
    console.log(`  ${m.name.padEnd(32)} ${m.throughputPerSec.toFixed(1).padStart(6)}  ${errPct.toFixed(1).padStart(5)}  ${(m.totalWallMs/1000).toFixed(1).padStart(5)}s  ${m.uniqueKeysUsed.toString().padStart(4)}            ${m.dbWritten}`);
  }

  await (await getPool()).end();
}

main().catch(e => { console.error(e); process.exit(1); });
