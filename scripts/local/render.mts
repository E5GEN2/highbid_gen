/**
 * Local pipeline runner — drives the producer (startJob + runJob) entirely
 * on this machine, no Next.js server, no Railway deploy.
 *
 *   npx tsx --tsconfig ./tsconfig.json scripts/local/render.mts <mode> [args]
 *
 * Modes:
 *   from-job <jobId>          Clone an existing job's script_jsonb from the
 *                             DB and re-render it LOCALLY.
 *   from-channels <UC..,UC..> <beat_id> [--logos UC..,UC..]
 *                             Build a FRESH listicle script via
 *                             lib/content-gen/listicle-builder (same code
 *                             the production route uses) and render it.
 *
 * Flags:
 *   --local                   Use the mirrored local Postgres (hbgen_local).
 *                             Populate first via scripts/local/pull-local.mts.
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

// --labels → TECHNICAL MODE: stamp each slot's slot_id top-right so review
// feedback can reference exact beats ("niche_1_mm_rpm issue X").
if (process.argv.includes('--labels')) {
  process.env.HB_DEBUG_LABELS = '1';
  console.log('[mode] TECHNICAL — slot labels on');
}

// --local → run against the mirrored local Postgres (hbgen_local) instead of
// Railway. Populate it first with scripts/local/pull-local.mts.
if (process.argv.includes('--local')) {
  // Keep the Railway URL reachable for services the local mirror can't
  // serve (embedding lookups for similar-channel discovery).
  process.env.HB_RAILWAY_DB_URL = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://localhost:5432/hbgen_local';
  console.log('[db] LOCAL hbgen_local (Railway kept for embeddings)');
} else {
  console.log('[db] RAILWAY');
}

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

async function main() {
  const argv = process.argv.slice(2);
  const positional = argv.filter(a => !a.startsWith('--'));
  const [mode, arg1, arg2] = positional;

  let script: import('../../lib/content-gen/concrete-script').ConcreteScript;

  if (mode === 'from-job' && arg1) {
    // ── 3a. Pull the source script_jsonb directly via pg (no SSL) ──
    const srcJobId = parseInt(arg1, 10);
    log(`loading script from job ${srcJobId}…`);
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
    const r = await pool.query<{ script_jsonb: unknown }>(
      `SELECT script_jsonb FROM content_gen_producer_jobs WHERE id = $1`,
      [srcJobId],
    );
    await pool.end();
    if (r.rows.length === 0) { console.error(`job ${srcJobId} not found`); process.exit(1); }
    script = r.rows[0].script_jsonb as typeof script;
  } else if (mode === 'from-channels' && arg1 && arg2) {
    // ── 3b. Build a FRESH script via the shared listicle builder ──
    const channels = arg1.split(',').map(s => s.trim()).filter(Boolean);
    const logosIdx = argv.indexOf('--logos');
    const intro_logos_channels = logosIdx >= 0 && argv[logosIdx + 1]
      ? argv[logosIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
      : undefined;
    log(`building fresh listicle: ${channels.length} channel(s), beat=${arg2}` +
        (intro_logos_channels ? `, intro logos=${intro_logos_channels.length}` : ''));
    const { buildListicleScript } = await import('../../lib/content-gen/listicle-builder');
    const built = await buildListicleScript({ channels, beat_id: arg2, intro_logos_channels });
    if (!built.script) {
      console.error('listicle build failed:', built.error, built.failures);
      process.exit(1);
    }
    if (built.failures.length) log('warnings:', JSON.stringify(built.failures));
    script = built.script;
  } else {
    console.error('usage: render.mts from-job <jobId> [--local] [--labels]');
    console.error('       render.mts from-channels <UC..,UC..> <beat_id> [--logos UC..,UC..] [--local] [--labels]');
    process.exit(1);
  }
  log(`script ready: ${script.slots.length} slots, ${script.slots.reduce((a, s) => a + s.gems.length, 0)} gems`);

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
