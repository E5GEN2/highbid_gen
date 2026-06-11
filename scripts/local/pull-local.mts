/**
 * pull-local.mts — mirror everything the pipeline needs from Railway → local.
 *
 *   npx tsx --tsconfig ./tsconfig.json scripts/local/pull-local.mts [channelId...]
 *
 * Phases:
 *   1. TABLES  — copy Railway tables → local hbgen_local DB (TRUNCATE + INSERT,
 *                column-intersection, jsonb-safe). niche_spy_videos is copied
 *                selectively for the given channel IDs (defaults to the
 *                "Top 10 Faceless YouTube Niches" draft group).
 *   2. ASSETS  — download capture PNGs / TTS mp3s / SFX mp3s from rofe.ai
 *                file APIs into ./clips/{yt_screens,tts,sfx}.
 *   3. REWRITE — point local DB asset paths (/data/clips/... and /tmp/clips/...)
 *                at ./clips so caches HIT locally.
 *
 * Idempotent — safe to re-run; existing files are skipped.
 */

import { readFileSync, mkdirSync, existsSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import pg from 'pg';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const CLIPS = path.join(repoRoot, 'clips');
const LOCAL_DB = 'postgresql://localhost:5432/hbgen_local';
const ROFE = 'https://rofe.ai';
const BEARER = 'hba_bee5391e36d740b9e3b9a2033165dacc8177dc1abba82c936617819bda3b47cf';

// Default: the "Top 10 Faceless YouTube Niches" draft group.
const DEFAULT_CHANNELS = [
  'UC2RkPC-fzVCAdOEwc11Eesw', // Finest Explainer
  'UCM6UaLvydAAnhWP-g_Ra9yw', // NoFL
  'UCZkXbMH4DMKbpzh846FOqPQ', // Vikings Life
  'UCxt3KKN_pF70SWEA9xBOJ8A', // வானிமணி தமிழில்
  'UCjByBYYazGapmHpD3fd4mpA', // Dreamy Flow
  'UClEH97oWJjrm1PX6ZCEcafQ', // SkyWhisper
  'UCWbM5p20UDzs1VLGa9ku2Jw', // Myths-creature
  'UClAGMt7guAFHHGIVCUin_ew', // UNSTOPPABLE
  'UC6WfwZLK0d3EmG6QCSzQPwA', // phantomized
  'UCdeUiI5M1FLtKrXQPxdzB-A', // Pets Memes
];

// Tables copied in full (all are small).
const FULL_TABLES = [
  'admin_config',
  'content_gen_channel_analysis',
  'channel_analysis',
  'content_gen_yt_screens',
  'content_gen_voice_assets',
  'content_gen_sfx_assets',
  'content_gen_tool_cache',
  'content_gen_tool_version_overrides',
  'content_gen_producer_jobs',
  'content_gen_producer_gems',
  'content_gen_scripts',
  'xgodo_api_keys',
  'xgodo_proxy_health',
  'niche_spy_channels',
];

// .env.local DATABASE_URL → Railway
function railwayUrl(): string {
  const line = readFileSync(path.join(repoRoot, '.env.local'), 'utf8')
    .split('\n').find(l => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL not in .env.local');
  let v = line.slice('DATABASE_URL='.length).trim();
  if ((v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
  return v;
}

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

async function columnsOf(pool: pg.Pool | pg.Client, table: string): Promise<Array<{ name: string; type: string }>> {
  const r = await pool.query(
    `SELECT column_name name, data_type type FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]);
  return r.rows;
}

async function copyTable(src: pg.Pool, dst: pg.Pool | pg.Client, table: string, where = '', params: unknown[] = []) {
  const srcCols = await columnsOf(src, table);
  const dstCols = await columnsOf(dst, table);
  if (!srcCols.length) { log(`  ${table}: missing on Railway — skip`); return; }
  if (!dstCols.length) { log(`  ${table}: missing locally — skip`); return; }
  const dstByName = new Map(dstCols.map(c => [c.name, c]));
  const cols = srcCols.filter(c => dstByName.has(c.name));
  const names = cols.map(c => `"${c.name}"`).join(', ');

  await dst.query(`TRUNCATE TABLE ${table} CASCADE`);
  const sel = `SELECT ${names} FROM ${table} ${where}`;
  const rows = (await src.query(sel, params)).rows;
  if (!rows.length) { log(`  ${table}: 0 rows`); return; }

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values: unknown[] = [];
    const tuples = batch.map((row, bi) => {
      const ph = cols.map((c, ci) => {
        let v = (row as Record<string, unknown>)[c.name];
        // jsonb columns: stringify so JS arrays don't become pg arrays
        if (v !== null && v !== undefined && (c.type === 'jsonb' || c.type === 'json') && typeof v === 'object') {
          v = JSON.stringify(v);
        }
        values.push(v);
        return `$${bi * cols.length + ci + 1}${c.type === 'jsonb' ? '::jsonb' : c.type === 'json' ? '::json' : ''}`;
      });
      return `(${ph.join(',')})`;
    });
    await dst.query(`INSERT INTO ${table} (${names}) VALUES ${tuples.join(',')}`, values);
  }
  log(`  ${table}: ${rows.length} rows`);

  // Fix sequence for serial PKs so future local INSERTs don't collide.
  const pk = await dst.query(
    `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
      WHERE i.indrelid=$1::regclass AND i.indisprimary`, [table]).catch(() => ({ rows: [] as { attname: string }[] }));
  for (const { attname } of pk.rows) {
    await dst.query(
      `SELECT setval(pg_get_serial_sequence($1,$2), COALESCE((SELECT MAX("${attname}")::bigint FROM ${table}), 1))`,
      [table, attname]).catch(() => {});
  }
}

async function download(url: string, dest: string): Promise<number> {
  if (existsSync(dest) && statSync(dest).size > 0) return 0; // cached
  const res = await fetch(url, { headers: { Authorization: `Bearer ${BEARER}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error(`suspiciously small (${buf.length}b)`);
  writeFileSync(dest, buf);
  return buf.length;
}

async function pullAssets(local: pg.Pool) {
  for (const d of ['yt_screens', 'tts', 'sfx', 'producer_renders/images', 'group_audio']) {
    mkdirSync(path.join(CLIPS, d), { recursive: true });
  }
  type Job = { url: string; dest: string; label: string };
  const jobs: Job[] = [];

  const screens = await local.query(`SELECT id, local_path FROM content_gen_yt_screens WHERE local_path IS NOT NULL AND status='ok'`);
  for (const r of screens.rows) {
    jobs.push({
      url: `${ROFE}/api/admin/content-gen/yt-capture/file?id=${r.id}`,
      dest: path.join(CLIPS, 'yt_screens', path.basename(r.local_path)),
      label: `screen#${r.id}`,
    });
  }
  const voices = await local.query(`SELECT text_hash, local_path FROM content_gen_voice_assets WHERE local_path IS NOT NULL`);
  for (const r of voices.rows) {
    jobs.push({
      url: `${ROFE}/api/admin/content-gen/voice/file?hash=${r.text_hash}`,
      dest: path.join(CLIPS, 'tts', path.basename(r.local_path)),
      label: `tts:${r.text_hash.slice(0, 8)}`,
    });
  }
  const sfx = await local.query(`SELECT sfx_hash, local_path FROM content_gen_sfx_assets WHERE local_path IS NOT NULL`);
  for (const r of sfx.rows) {
    jobs.push({
      url: `${ROFE}/api/admin/content-gen/sfx/file?hash=${r.sfx_hash}`,
      dest: path.join(CLIPS, 'sfx', path.basename(r.local_path)),
      label: `sfx:${r.sfx_hash.slice(0, 8)}`,
    });
  }

  log(`assets to mirror: ${jobs.length}`);
  let ok = 0, skipped = 0, failed = 0;
  const CONC = 8;
  for (let i = 0; i < jobs.length; i += CONC) {
    await Promise.all(jobs.slice(i, i + CONC).map(async j => {
      try {
        const n = await download(j.url, j.dest);
        if (n === 0) skipped++; else ok++;
      } catch (e) {
        failed++;
        console.warn(`  ! ${j.label}: ${(e as Error).message}`);
      }
    }));
  }
  log(`assets: ${ok} downloaded, ${skipped} already present, ${failed} failed`);
}

async function rewritePaths(local: pg.Pool) {
  // Point every stored path at ./clips. Handles /data/clips (Railway) and
  // /tmp/clips (old local default).
  const reps: Array<[string, string]> = [
    ['/data/clips', CLIPS],
    ['/tmp/clips', CLIPS],
  ];
  for (const [from, to] of reps) {
    await local.query(`UPDATE content_gen_yt_screens   SET local_path = replace(local_path, $1, $2) WHERE local_path LIKE $1 || '%'`, [from, to]);
    await local.query(`UPDATE content_gen_voice_assets SET local_path = replace(local_path, $1, $2) WHERE local_path LIKE $1 || '%'`, [from, to]);
    await local.query(`UPDATE content_gen_sfx_assets   SET local_path = replace(local_path, $1, $2) WHERE local_path LIKE $1 || '%'`, [from, to]);
    await local.query(
      `UPDATE content_gen_tool_cache
          SET asset_paths = (SELECT array_agg(replace(p, $1, $2)) FROM unnest(asset_paths) p),
              output_jsonb = replace(output_jsonb::text, $1, $2)::jsonb
        WHERE EXISTS (SELECT 1 FROM unnest(asset_paths) p WHERE p LIKE $1 || '%')
           OR output_jsonb::text LIKE '%' || $1 || '%'`, [from, to]);
    await local.query(
      `UPDATE content_gen_producer_gems
          SET output_jsonb = replace(output_jsonb::text, $1, $2)::jsonb
        WHERE output_jsonb::text LIKE '%' || $1 || '%'`, [from, to]);
  }
  log('paths rewritten → ' + CLIPS);
}

async function main() {
  const channels = process.argv.slice(2).filter(a => a.startsWith('UC'));
  const chList = channels.length ? channels : DEFAULT_CHANNELS;

  const src = new pg.Pool({ connectionString: railwayUrl(), ssl: false, max: 4 });
  // Single client (not pool) so session_replication_role=replica sticks —
  // disables FK triggers while mirroring tables that reference subsystems
  // we don't copy (e.g. channel_analysis → shorts_channels).
  const dstClient = new pg.Client({ connectionString: LOCAL_DB });
  await dstClient.connect();
  await dstClient.query(`SET session_replication_role = replica`);

  log('phase 1 — tables');
  for (const t of FULL_TABLES) await copyTable(src, dstClient, t);
  await copyTable(src, dstClient, 'niche_spy_videos', `WHERE channel_id = ANY($1)`, [chList]);
  await dstClient.query(`SET session_replication_role = DEFAULT`);
  await dstClient.end();
  const dst = new pg.Pool({ connectionString: LOCAL_DB, max: 4 });

  log('phase 2 — asset files');
  await pullAssets(dst);

  log('phase 3 — path rewrite');
  await rewritePaths(dst);

  // Sanity: confirm keys + channels + assets are present locally.
  const keys = await dst.query(`SELECT count(*)::int n FROM admin_config`);
  const chans = await dst.query(`SELECT count(*)::int n FROM niche_spy_channels WHERE channel_id = ANY($1)`, [chList]);
  const el = await dst.query(`SELECT count(*)::int n FROM admin_config WHERE key='elevenlabs_api_key' AND value IS NOT NULL`);
  log(`sanity: admin_config=${keys.rows[0].n} keys (elevenlabs present=${el.rows[0].n}), draft channels present=${chans.rows[0].n}/${chList.length}`);

  await src.end(); await dst.end();
  log('PULL COMPLETE — local DB + assets ready');
}

main().catch(e => { console.error('pull failed:', e); process.exit(1); });
