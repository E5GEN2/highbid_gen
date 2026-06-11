/**
 * Local pipeline runner — drives the producer (startJob + runJob) entirely
 * on this machine, no Next.js server, no Railway deploy.
 *
 *   npx tsx --tsconfig ./tsconfig.json scripts/local/render.mts <mode> [args]
 *
 * Modes:
 *   from-job <jobId>          Clone an existing job's script_jsonb from the
 *                             DB and re-render it LOCALLY. Proves the whole
 *                             loop with zero refactor. (Step 1)
 *
 * Assets land in ./clips (local, persistent). The final mp4 absolute path is
 * printed + copied to ./clips/_latest.mp4 for quick inspection.
 *
 * Env: parsed from .env.local. DB connects with ssl:false (Railway TCP proxy
 * has no SSL). CLIPS_DIR is forced to ./clips BEFORE the pipeline is imported.
 */

import { readFileSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import path from 'path';
import pg from 'pg';

// ── 1. Load .env.local (don't overwrite anything already in the shell env) ──
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const envText = readFileSync(path.join(repoRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const i = line.indexOf('=');
  if (i < 0) continue;
  const k = line.slice(0, i).trim();
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (k && process.env[k] === undefined) process.env[k] = v;
}

// ── 2. Force LOCAL storage + non-SSL DB BEFORE importing the pipeline ──
const CLIPS = path.join(repoRoot, 'clips');
mkdirSync(CLIPS, { recursive: true });
process.env.CLIPS_DIR = CLIPS;
process.env.PGSSLMODE = 'disable';      // Railway proxy host has no SSL
process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';

// --local → run against the mirrored local Postgres (hbgen_local) instead of
// Railway. Populate it first with scripts/local/pull-local.mts.
if (process.argv.includes('--local')) {
  process.env.DATABASE_URL = 'postgresql://localhost:5432/hbgen_local';
  console.log('[db] LOCAL hbgen_local');
} else {
  console.log('[db] RAILWAY');
}

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

async function main() {
  const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const [mode, arg1] = positional;
  if (mode !== 'from-job' || !arg1) {
    console.error('usage: render.mts from-job <jobId>');
    process.exit(1);
  }
  const srcJobId = parseInt(arg1, 10);

  // ── 3. Pull the source script_jsonb directly via pg (no SSL) ──
  log(`loading script from job ${srcJobId}…`);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  const r = await pool.query<{ script_jsonb: unknown }>(
    `SELECT script_jsonb FROM content_gen_producer_jobs WHERE id = $1`,
    [srcJobId],
  );
  await pool.end();
  if (r.rows.length === 0) { console.error(`job ${srcJobId} not found`); process.exit(1); }
  const script = r.rows[0].script_jsonb as import('../../lib/content-gen/concrete-script').ConcreteScript;
  log(`script loaded: ${script.slots.length} slots, ${script.slots.reduce((a, s) => a + s.gems.length, 0)} gems`);

  // ── 4. Dynamic-import the pipeline (env is set, so CLIPS_DIR is correct) ──
  log(`CLIPS_DIR = ${process.env.CLIPS_DIR}`);
  const { startJob, runJob, getJobStatus } = await import('../../lib/content-gen/producer');

  // ── 5. Insert a fresh local job + run every gem LOCALLY ──
  log('startJob…');
  const jobId = await startJob({ script });
  log(`local job id = ${jobId} — running…`);
  const result = await runJob(jobId);

  const status = await getJobStatus(jobId);
  log(`done — ok=${result.ok} gems ${status.job?.gems_done}/${status.job?.gems_total} failed=${status.job?.gems_failed}`);
  if (result.error) log('error:', result.error);

  // ── 6. Resolve the local mp4 + copy to ./clips/_latest.mp4 ──
  const url = result.final_video_url ?? status.job?.final_video_url ?? '';
  const m = /[?&]path=([^&]+)/.exec(url);
  if (m) {
    const localMp4 = path.join(CLIPS, 'producer_renders', decodeURIComponent(m[1]));
    if (existsSync(localMp4)) {
      const latest = path.join(CLIPS, '_latest.mp4');
      copyFileSync(localMp4, latest);
      log(`mp4 → ${localMp4}`);
      log(`copy → ${latest}`);
    } else {
      log(`expected mp4 not on disk: ${localMp4}`);
    }
  } else {
    log('no final_video_url produced');
  }
  process.exit(result.ok ? 0 : 1);
}

main().catch(e => { console.error('runner crashed:', e); process.exit(1); });
