/**
 * render-verify.mts — DEEP post-render verification (beyond the render-qa.mts gate).
 * Catches the classes render-qa missed (job 139 passed the gate yet had 11 real defects):
 *   A. VO number != displayed number   — narration text vs Gemini-OCR of the FRAME the render used
 *   B. highlight on the wrong row       — about-panel scan: joined-anchor fails -> box on Joined not subs
 *   C. whole-page-black capture         — the FRAME the render used (tool_cache asset) is nav-only black
 *   D. corrupted VO money               — narration carries raw "$N,NNN" digits TTS garbles
 *
 *   npx tsx --tsconfig ./tsconfig.json scripts/local/render-verify.mts <jobId>
 *
 * KEY: the frame the render COMPOSED is the gem's content_gen_tool_cache asset (the cache key omits
 * the stat value + date_bucket, so a fresh re-capture does NOT replace it — that desync IS Type A &
 * the recurring niche_4 black). We OCR/scan THAT asset, not the latest content_gen_yt_screens row.
 * Vision = direct Google gemini-2.5-flash via xgodo proxy (PapaiAPI ignores inline images).
 */
import { readFileSync } from 'fs';
import path from 'path';
import pg from 'pg';
import sharp from 'sharp';
import { composeAboutPanelMG } from '../../lib/content-gen/yt-compose-mg';

const repoRoot = process.cwd();
for (const l of readFileSync(path.join(repoRoot, '.env.local'), 'utf8').split('\n')) { const i = l.indexOf('='); if (i < 0) continue; const k = l.slice(0, i).trim(); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (k && process.env[k] === undefined) process.env[k] = v; }
const local = new pg.Pool({ connectionString: 'postgresql://localhost:5432/hbgen_local', ssl: false });
local.on('error', () => {});
const jobId = Number(process.argv[2] || 139);
const out: Array<{ check: string; slot: string; ok: boolean | null; detail: string }> = [];
const add = (check: string, slot: string, ok: boolean | null, detail: string) => out.push({ check, slot, ok, detail });

async function geminiVisionJSON(imgB64: string, prompt: string): Promise<any> {
  const { getRandomHealthyProxy } = await import('../../lib/xgodo-proxy');
  const { fetchViaProxy } = await import('../../lib/proxy-dispatcher');
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: imgB64 } }] }], generationConfig: { temperature: 0, maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } } });
  let res: any = null, lastStatus = 0;
  for (let attempt = 1; attempt <= 6 && !res?.ok; attempt++) {
    const keyRow = await local.query<{ key: string }>(`SELECT key FROM xgodo_api_keys WHERE service='google_ai_studio' AND status='active' AND (banned_until IS NULL OR banned_until < NOW()) ORDER BY RANDOM() LIMIT 1`);
    const apiKey = keyRow.rows[0]?.key; if (!apiKey) break;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    res = null;
    try { const proxy = await getRandomHealthyProxy().catch(() => null); if (proxy?.url) res = await fetchViaProxy(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, timeoutMs: 45000 }, proxy.url); } catch {}
    if (!res || !res.ok) { try { const rr = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(45000) }); res = { ok: rr.ok, status: rr.status, json: () => rr.json() }; } catch {} }
    lastStatus = res?.status ?? lastStatus;
    if (!res?.ok && attempt < 6) await new Promise(r => setTimeout(r, 1200 * attempt));
  }
  if (!res || !res.ok) throw new Error(`gemini HTTP ${lastStatus}`);
  const data = await res.json() as any;
  const raw = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join('').trim() ?? '';
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}'); if (s < 0 || e <= s) throw new Error(`no JSON: ${raw.slice(0, 80)}`);
  return JSON.parse(raw.slice(s, e + 1));
}

const ytLabel = (n: number) => n >= 1e6 ? (Math.floor(n / 1e5) / 10).toFixed(1) + 'M' : n >= 1000 ? Math.floor(n / 1000) + 'K' : String(Math.floor(n));
const STAT_BY_DP: Record<string, string> = {
  'channel.subscribers': 'the subscriber count of the channel (e.g. "108K subscribers")',
  'channel.total_views': 'the total view count of the channel (e.g. "10,405,762 views" or "10.4M views")',
  'video.top_video': "the view count of the single most prominent / largest video card shown (e.g. '2.3M views')",
};

// The FRAME the render composed = the gem's tool_cache asset (NOT the latest content_gen_yt_screens).
async function renderedFrame(channelId: string, kind: string, ann?: string): Promise<{ p: string; date: string } | null> {
  let q = `SELECT asset_paths FROM content_gen_tool_cache WHERE tool='yt_capture' AND asset_paths::text LIKE $1`;
  const params: string[] = [`%${channelId}_${kind}_%`];
  if (ann) { q += ` AND asset_paths::text LIKE $2`; params.push(`%ann-${ann}%`); }
  q += ` ORDER BY last_used_at DESC NULLS LAST, created_at DESC LIMIT 1`;
  const row = (await local.query<{ asset_paths: string[] }>(q, params)).rows[0];
  const p = Array.isArray(row?.asset_paths) ? row.asset_paths.find(a => /\.png$/.test(a)) : null;
  if (!p) return null;
  return { p, date: p.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? '?' };
}
const capGem = (slot: any) => (slot.gems || []).find((g: any) => g.tool === 'yt_capture');

// ─── A. VO number vs displayed number ───
async function checkA(slots: any[]) {
  const beats = slots.filter(s => STAT_BY_DP[s.data_point_id] && capGem(s));
  const run = async (slot: any) => {
    const cap = capGem(slot); const { channelId, kind, annotate_element: ann } = cap.args;
    const fr = await renderedFrame(channelId, kind, ann);
    if (!fr) return add('A.number', slot.slot_id, null, `no tool_cache frame for ${channelId}/${kind}`);
    let b64: string; try { b64 = (await sharp(fr.p).resize({ width: 1440, withoutEnlargement: true }).png().toBuffer()).toString('base64'); } catch { return add('A.number', slot.slot_id, null, `frame unreadable`); }
    const prompt = `Audit a YouTube listicle frame for number accuracy.\nVoiceover for this beat: "${slot.narration}"\nThe screenshot is exactly what is on screen during that narration.\nReturn ONLY JSON: {"narrated": <integer the narration states for ${STAT_BY_DP[slot.data_point_id]}>, "displayed": <integer visibly shown for that stat, or null>, "displayed_label": "<exact on-screen text>"}`;
    try { const r = await geminiVisionJSON(b64, prompt); const nar = Number(r.narrated), disp = r.displayed == null ? null : Number(r.displayed);
      if (disp == null || !isFinite(disp)) return add('A.number', slot.slot_id, null, `UNREADABLE displayed (frame ${fr.date})`);
      const nl = ytLabel(nar), dl = ytLabel(disp);
      add('A.number', slot.slot_id, nl === dl, `narrated ${nl} vs displayed ${dl} (raw ${nar} vs ${disp}, frame ${fr.date})`);
    } catch (e) { add('A.number', slot.slot_id, null, `OCR err: ${(e as Error).message.slice(0, 50)}`); }
  };
  const q = [...beats]; await Promise.all(Array.from({ length: 5 }, async () => { while (q.length) await run(q.shift()); }));
}

// ─── B. about-panel highlight row (re-run the scan; flag if joined-anchor fails or below[0]!=bottom-anchored subs) ───
async function checkB(slots: any[]) {
  const beats = slots.filter(s => /channel_proof_1$/.test(s.slot_id) && capGem(s)?.args?.kind === 'about_page');
  for (const slot of beats) {
    const cap = capGem(slot); const { channelId } = cap.args;
    const fr = await renderedFrame(channelId, 'about_page', 'subscriber_count') || await renderedFrame(channelId, 'about_page');
    if (!fr) { add('B.highlight', slot.slot_id, null, 'no about_page frame'); continue; }
    const cgr = (await local.query<{ bboxes_jsonb: any }>(`SELECT bboxes_jsonb FROM content_gen_yt_screens WHERE local_path=$1 LIMIT 1`, [fr.p])).rows[0]
      ?? (await local.query<{ bboxes_jsonb: any }>(`SELECT bboxes_jsonb FROM content_gen_yt_screens WHERE channel_id=$1 AND kind='about_page' ORDER BY created_at DESC LIMIT 1`, [channelId])).rows[0];
    const jd = cgr?.bboxes_jsonb?.joined_date;
    if (!jd) { add('B.highlight', slot.slot_id, null, 'no joined_date bbox'); continue; }
    try {
      const { path: composed, map } = await composeAboutPanelMG(fr.p, jd);
      const { data, info } = await sharp(composed).raw().toBuffer({ resolveWithObject: true });
      const rows: Array<{ top: number; h: number }> = []; let inRow = false, sy = 0;
      for (let y = 200; y < 900; y++) { let b = 0; for (let x = 650; x < 760; x++) { const o = (y * info.width + x) * info.channels; b += (data[o] + data[o + 1] + data[o + 2]) / 3; } b /= 110; if (b > 50 && !inRow) { sy = y; inRow = true; } else if (b <= 50 && inRow) { const h = y - sy; if (h >= 8 && h < 30) rows.push({ top: sy, h }); inRow = false; } }
      const jc = (map as any).offY + (jd.y - (map as any).cropY) * (map as any).scale + (jd.h * (map as any).scale) / 2;
      const jIdx = rows.findIndex(r => jc >= r.top - 4 && jc <= r.top + r.h + 6);
      // The FIXED compose BOTTOM-anchors the subs band to rows[length-3] (invariant tail
      // subs/videos/views). Verify that row exists and sits BELOW the Joined center — independent of
      // the joined-anchor jIdx (which is -1 on exactly the modals that triggered the original bug).
      const bottomSubs = rows[rows.length - 3];
      const ok = rows.length >= 4 && !!bottomSubs && bottomSubs.top > jc - 4;
      add('B.highlight', slot.slot_id, ok, `bottomSubs.top=${bottomSubs?.top} jc=${jc.toFixed(0)} jIdx=${jIdx} rows=${rows.length} (frame ${fr.date})`);
    } catch (e) { add('B.highlight', slot.slot_id, null, `scan err: ${(e as Error).message.slice(0, 50)}`); }
  }
}

// ─── C. whole-page-black on the FRAME the render used (channel_page / videos_tab*) ───
async function checkC(slots: any[]) {
  const seen = new Set<string>();
  for (const slot of slots) {
    const cap = capGem(slot); if (!cap) continue; const { channelId, kind } = cap.args;
    if (!/channel_page|videos_tab/.test(kind)) continue;
    const key = channelId + '/' + kind; if (seen.has(key)) continue; seen.add(key);
    const fr = await renderedFrame(channelId, kind, cap.args.annotate_element);
    if (!fr) { add('C.black', slot.slot_id, null, `no frame ${channelId}/${kind}`); continue; }
    try {
      const buf = await sharp(fr.p).resize({ width: 400 }).greyscale().raw().toBuffer();
      const a = Array.from(buf).sort((x, y) => x - y);
      const p90 = a[Math.floor(0.9 * (a.length - 1))];
      const luma = a.reduce((s, v) => s + v, 0) / a.length;
      const size = (await import('fs')).statSync(fr.p).size;
      const black = luma < 25 || size < 30000;   // nav-only-black: whole page failed to render
      // UNIFORM DIM: even the bright UI chrome + white title text is washed gray. p90 is the tell —
      // a crisp capture (even dark-CONTENT niches like AI-films) keeps p90>=130 from the white text/
      // header; a dimmed capture collapses to p90~73 (niche_7, 2026-06-28). max-white (p99) does NOT
      // catch it (the duration badge stays 255). dark CONTENT is fine; dark CHROME is the defect.
      const dimmed = p90 < 100;
      add('C.black', `${channelId.slice(0, 10)}/${kind}`, !black && !dimmed, `luma=${luma.toFixed(0)} p90=${p90} bytes=${size}${black ? ' ←BLACK' : ''}${dimmed ? ' ←DIMMED' : ''} (frame ${fr.date})`);
    } catch { add('C.black', slot.slot_id, null, 'stat failed'); }
  }
}

// ─── D. corrupted VO money — narration carries raw "$N" / "$N,NNN" digits TTS garbles ───
function checkD(slots: any[]) {
  for (const slot of slots) {
    const narr: string = slot.narration || '';
    if (!/mm_|lump|translates|earn|revenue|dollar/i.test(slot.slot_id + ' ' + narr)) continue;
    const m = narr.match(/\$[\d][\d,]*/);            // "$7,500", "$12" — un-verbalized currency
    if (m) add('D.money', slot.slot_id, false, `un-verbalized currency "${m[0]}" in narration: "${narr.trim()}"`);
  }
}

async function main() {
  const slots: any[] = (await local.query(`SELECT script_jsonb->'slots' s FROM content_gen_producer_jobs WHERE id=$1`, [jobId])).rows[0]?.s || [];
  console.log(`render-verify job ${jobId} — ${slots.length} slots\n`);
  await checkA(slots); await checkB(slots); await checkC(slots); checkD(slots);
  out.sort((a, b) => (a.check + a.slot).localeCompare(b.check + b.slot));
  let fail = 0, unk = 0;
  for (const r of out) { const tag = r.ok === true ? '✅' : r.ok === false ? '❌ FAIL' : '⚠️  UNK'; if (r.ok === false) fail++; if (r.ok === null) unk++; console.log(`${tag}  [${r.check}] ${r.slot} — ${r.detail}`); }
  const byType = ['A.number', 'B.highlight', 'C.black', 'D.money'].map(c => { const rs = out.filter(r => r.check === c); return `${c}: ${rs.filter(r => r.ok === false).length} fail / ${rs.filter(r => r.ok === null).length} unk / ${rs.length}`; });
  console.log(`\n${byType.join('  |  ')}\nVERIFY: ${fail === 0 ? '✅ PASS' : `❌ ${fail} FAIL`} (${unk} unknown)`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
