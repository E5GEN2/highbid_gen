/**
 * Ingest Google API keys from an xgodo job-submission dump into the
 * xgodo_api_keys table.
 *
 * Input: a text file (or stdin) containing the page dump from xgodo's
 * "Submitted Tasks" view. The script doesn't care about row ordering —
 * it just regex-greps every (key, remote_device_id) pair, attaches the
 * nearest worker name above it, dedupes, validates, and inserts.
 *
 * Usage:
 *   npx tsx scripts/ingest-xgodo-keys.ts <file>            # default: youtube_data
 *   npx tsx scripts/ingest-xgodo-keys.ts <file> --service=google_ai_studio
 *   cat dump.txt | npx tsx scripts/ingest-xgodo-keys.ts -  # read stdin
 *   DRY_RUN=1 npx tsx scripts/ingest-xgodo-keys.ts dump.txt
 *
 * Idempotent — UNIQUE (service, key) means re-runs are safe.
 */
import fs from 'fs';
import { getPool } from '@/lib/db';

type Service = 'youtube_data' | 'google_ai_studio';
const SERVICES: readonly Service[] = ['youtube_data', 'google_ai_studio'];

// Google API keys are exactly `AIzaSy` + 33 chars from [A-Za-z0-9_-].
// Anything else (e.g. the random "jkQWTQbNOACg" garbage in the dump) is
// rejected here so we don't ship junk into the rotation.
const KEY_RE = /^AIzaSy[A-Za-z0-9_-]{33}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseDump(text: string): Array<{ key: string; remote_device_id: string; worker: string | null }> {
  // The xgodo page dump rows look like:
  //   <date>
  //   <worker_name>
  //   key\tAIzaSy...
  //   remote_device_id\t<uuid>
  //   awaitng review
  // The worker name is the line above the `key` line. We walk lines and
  // grab triples on the fly so we keep the worker association.
  const lines = text.split(/\r?\n/);
  const out: Array<{ key: string; remote_device_id: string; worker: string | null }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Match "key\tAIzaSy..." or just "key AIzaSy..." (whitespace-tolerant)
    const km = line.match(/^key\s+(\S+)/);
    if (!km) continue;
    const key = km[1];
    if (!KEY_RE.test(key)) continue;

    // Look ahead for the matching remote_device_id line — usually the
    // next non-blank line.
    let device: string | null = null;
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const dm = lines[j].trim().match(/^remote_device_id\s+(\S+)/);
      if (dm) { device = dm[1]; break; }
    }
    if (!device || !UUID_RE.test(device)) continue;

    // Walk back for the worker name — first non-empty, non-date line above.
    let worker: string | null = null;
    for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
      const w = lines[j].trim();
      if (!w) continue;
      if (/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d/i.test(w)) continue;
      if (/^(awaitng review|approved|rejected)$/i.test(w)) continue;
      if (/^key\s/i.test(w) || /^remote_device_id\s/i.test(w)) continue;
      worker = w;
      break;
    }

    out.push({ key, remote_device_id: device, worker });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const fileArg = args.find(a => !a.startsWith('-'));
  const serviceArg = (args.find(a => a.startsWith('--service='))?.split('=')[1] || 'youtube_data') as Service;
  if (!SERVICES.includes(serviceArg)) {
    console.error(`invalid --service. valid: ${SERVICES.join(', ')}`);
    process.exit(2);
  }
  if (!fileArg) {
    console.error('usage: npx tsx scripts/ingest-xgodo-keys.ts <file|-> [--service=youtube_data|google_ai_studio]');
    process.exit(2);
  }

  const dryRun = process.env.DRY_RUN === '1';
  const text = fileArg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(fileArg, 'utf8');
  const parsed = parseDump(text);
  console.log(`Parsed ${parsed.length} (key, device, worker) triples from input.`);

  // Dedupe by key (some workers re-submit the same key on a different day
  // → we keep the first occurrence's metadata).
  const byKey = new Map<string, { key: string; remote_device_id: string; worker: string | null }>();
  for (const r of parsed) if (!byKey.has(r.key)) byKey.set(r.key, r);
  const unique = [...byKey.values()];
  console.log(`Unique keys after dedupe: ${unique.length}`);

  // Worker breakdown — useful for sanity (one worker shouldn't dominate)
  const byWorker = new Map<string, number>();
  for (const r of unique) byWorker.set(r.worker ?? '?', (byWorker.get(r.worker ?? '?') ?? 0) + 1);
  const top = [...byWorker.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`Top workers (by unique-key count):`);
  for (const [w, n] of top) console.log(`  ${w.padEnd(25)} ${n}`);

  if (dryRun) {
    console.log('\nDRY_RUN — no inserts.');
    return;
  }

  const pool = await getPool();

  // Bulk insert with ON CONFLICT — idempotent so re-runs are safe.
  // Only the key itself goes into the table; device/worker stay as
  // dump-time telemetry (printed above) since they're not used for
  // routing or anything else downstream.
  let inserted = 0;
  let skippedDup = 0;
  for (const r of unique) {
    const res = await pool.query(
      `INSERT INTO xgodo_api_keys (service, key, source, status)
       VALUES ($1, $2, 'xgodo', 'active')
       ON CONFLICT (service, key) DO NOTHING
       RETURNING id`,
      [serviceArg, r.key],
    );
    if (res.rowCount && res.rowCount > 0) inserted += 1;
    else skippedDup += 1;
  }

  // Final stats.
  const total = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM xgodo_api_keys WHERE service = $1`,
    [serviceArg],
  );
  const active = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM xgodo_api_keys WHERE service = $1 AND status = 'active'`,
    [serviceArg],
  );

  console.log(`\nIngest complete (service=${serviceArg}):`);
  console.log(`  inserted:        ${inserted}`);
  console.log(`  skipped (dup):   ${skippedDup}`);
  console.log(`  table total:     ${total.rows[0].cnt}`);
  console.log(`  active in pool:  ${active.rows[0].cnt}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
