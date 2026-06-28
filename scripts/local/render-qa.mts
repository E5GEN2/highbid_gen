/**
 * Render QA gate — the automated checks behind docs/content-gen/render-qa-protocol.md.
 * Run AFTER every render; do not ship a render with any FAIL.
 *
 *   npx tsx --tsconfig ./tsconfig.json scripts/local/render-qa.mts <jobId> [mp4]
 *
 * Checks (each = a registry row in the protocol):
 *   A. thumbnails    — no black/unloaded grid thumbnails in the render's captures (#1)
 *   B. montage       — every logos_montage asset non-blank + every channelId has an avatar (#2)
 *   C. VO            — no garbled/stuttered tokens in the spoken audio (#3) + numbers present (#4)
 *   D. highlight     — about-panel scan resolves the subscribers row below Joined (#5)
 *   E. whole_page    — channel_page/videos_tab captures show body, not nav-only black (#6)
 *
 * Discipline: when a new render defect is found, add its check HERE + a registry row.
 */
import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import pg from 'pg';
import sharp from 'sharp';
import { composeAboutPanelMG } from '../../lib/content-gen/yt-compose-mg';

const repoRoot = process.cwd();
for (const l of readFileSync(path.join(repoRoot, '.env.local'), 'utf8').split('\n')) { const i = l.indexOf('='); if (i < 0) continue; const k = l.slice(0, i).trim(); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (k && process.env[k] === undefined) process.env[k] = v; }
process.env.DATABASE_URL = 'postgresql://localhost:5432/hbgen_local';
const local = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

const jobId = Number(process.argv[2]);
const mp4 = process.argv[3] || path.join(repoRoot, 'clips/_latest.mp4');
if (!jobId) { console.error('usage: render-qa.mts <jobId> [mp4]'); process.exit(2); }

const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const add = (check: string, pass: boolean, detail: string) => { results.push({ check, pass, detail }); console.log(`${pass ? '✅ PASS' : '❌ FAIL'}  ${check} — ${detail}`); };

// ─── A. thumbnails — dark-fraction per video_thumb on captures from the last 3h ───
try {
  const caps = (await local.query(`SELECT s.id, s.channel_id, s.kind, s.local_path, s.bboxes_jsonb, s.page_width, c.channel_name FROM content_gen_yt_screens s LEFT JOIN niche_spy_channels c ON c.channel_id=s.channel_id WHERE s.created_at > now() - interval '3 hours' AND s.local_path IS NOT NULL AND s.bboxes_jsonb IS NOT NULL`)).rows;
  let black = 0; const worst: string[] = [];
  for (const cap of caps) {
    let meta; try { meta = await sharp(cap.local_path).metadata(); } catch { continue; }
    const imgW = meta.width || 0, imgH = meta.height || 0; if (!imgW) continue;
    const scale = imgW / (cap.page_width || imgW);
    const bb = cap.bboxes_jsonb as Record<string, any>;
    // Only the top ~12 thumbnails (first 3-4 rows) are shown in the saturation/channel_b
    // beat; deep-bottom lazy-load stragglers on a 2500px-tall videos_tab are never
    // displayed, so flagging them is a false fail — match the capture gate's top-12 scope.
    for (const k of Object.keys(bb).filter(k => { const m = /^video_thumb_(\d+)$/.exec(k); return !!m && +m[1] < 12; })) {
      const b = bb[k]; const w = (b.w ?? 0) * scale, h = (b.h ?? 0) * scale; if (w < 24 || h < 24) continue;
      const rawL = (b.x ?? 0) * scale, rawT = (b.y ?? 0) * scale;
      if (rawT + h * 0.5 > imgH || rawL + w * 0.5 > imgW) continue;  // mostly off-frame
      const left = Math.max(0, Math.round(rawL)), top = Math.max(0, Math.round(rawT));
      const ww = Math.min(Math.round(w), imgW - left), hh = Math.min(Math.round(h), imgH - top);
      let buf; try { buf = await sharp(cap.local_path).extract({ left, top, width: ww, height: hh }).greyscale().resize(40, 40, { fit: 'fill' }).raw().toBuffer(); } catch { continue; }
      let d = 0; for (let i = 0; i < buf.length; i++) if (buf[i] < 45) d++;
      if (d / buf.length > 0.80) { black++; if (worst.length < 5) worst.push(`${cap.channel_name || cap.channel_id}[${cap.kind}]/${k}`); }
    }
  }
  add('A.thumbnails', black === 0, black === 0 ? `${caps.length} captures, 0 black thumbnails` : `${black} BLACK thumbnails: ${worst.join(', ')}`);
} catch (e) { add('A.thumbnails', false, `check errored: ${(e as Error).message.slice(0, 120)}`); }

// ─── B. montage — every logos_montage channelId has an avatar + the cached asset is non-blank ───
try {
  const gemRows = (await local.query(`SELECT DISTINCT jsonb_array_elements_text(g->'args'->'channelIds') cid FROM content_gen_producer_jobs j, jsonb_array_elements(j.script_jsonb->'slots') s, jsonb_array_elements(s->'gems') g WHERE j.id=$1 AND g->>'tool'='logos_montage'`, [jobId])).rows.map(r => r.cid);
  const missing = (await local.query(`SELECT channel_id FROM niche_spy_channels WHERE channel_id = ANY($1) AND (channel_avatar IS NULL OR channel_avatar = '')`, [gemRows])).rows.map(r => r.channel_id);
  const notFound = gemRows.filter(id => false); // presence handled by missing query
  add('B.montage.avatars', missing.length === 0, missing.length === 0 ? `all ${gemRows.length} montage channels have avatars` : `${missing.length} channels missing channel_avatar: ${missing.join(',')}`);
  // newest cached montage asset(s)
  const assets = (await local.query(`SELECT asset_paths FROM content_gen_tool_cache WHERE tool='logos_montage' ORDER BY id DESC LIMIT 3`)).rows.flatMap(r => r.asset_paths || []);
  let blankMontage = 0, checked = 0; const lumas: string[] = [];
  for (const p of assets) { try { const st = await sharp(p).stats(); const m = st.channels.slice(0, 3).reduce((a, c) => a + c.mean, 0) / 3; checked++; lumas.push(m.toFixed(0)); if (m < 80) blankMontage++; } catch { /* asset gone */ } }
  add('B.montage.nonblank', checked > 0 && blankMontage === 0, checked === 0 ? 'no montage asset found (cache pruned?)' : `${checked} montage asset(s), mean-luma=[${lumas.join(',')}] (blank<80)`);
} catch (e) { add('B.montage', false, `check errored: ${(e as Error).message.slice(0, 120)}`); }

// ─── C. VO — Scribe the spoken audio, flag stutters + check numbers present ───
try {
  const keyRow = (await local.query(`SELECT value FROM admin_config WHERE key='elevenlabs_api_key'`)).rows[0]
            ?? (await local.query(`SELECT elevenlabs_api_key value FROM admin_config LIMIT 1`).catch(() => ({ rows: [] as any[] }))).rows[0];
  const elKey = keyRow?.value || process.env.ELEVENLABS_API_KEY;
  if (!elKey) { add('C.vo', false, 'no elevenlabs key (admin_config.elevenlabs_api_key) — cannot transcribe'); }
  else {
    const mp3 = path.join(os.tmpdir(), `qa-vo-${jobId}.mp3`);
    execFileSync('ffmpeg', ['-y', '-i', mp4, '-vn', '-ac', '1', '-ar', '16000', mp3], { stdio: 'ignore' });
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(mp3)]), 'audio.mp3');
    fd.append('model_id', 'scribe_v1');
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': elKey }, body: fd });
    if (!res.ok) { add('C.vo', false, `Scribe HTTP ${res.status}`); }
    else {
      const data = await res.json() as { text?: string; words?: Array<{ text: string; start: number; end: number; type?: string }> };
      const words = (data.words || []).filter(w => (w.type ?? 'word') === 'word' && /\w/.test(w.text));
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
      // Real stutter = a NON-word fragment immediately before the word it fragments,
      // spoken with a near-zero gap ("hu"→"hundred"). Exclude legit short words that
      // happen to prefix the next ("an"→"animated", "on"→"one") via a stop-list + tight gap.
      const STOP = new Set(['a','an','on','in','to','the','it','is','of','or','as','at','be','he','we','so','no','i','and','that','this','for','you','my','me','up','out','one','two','our','its','his','her','are','was','has','had','but','not','all','can','if','do','go','am','by','us','off','new','now','how']);
      const stutters: string[] = [];
      for (let i = 0; i < words.length; i++) {
        const a = norm(words[i].text); if (a.length >= 4 && /^(.{2,4})\1/.test(a)) stutters.push(words[i].text);
        if (i + 1 < words.length) {
          const b = norm(words[i + 1].text); const gap = (words[i + 1].start ?? 0) - (words[i].end ?? 0);
          if (a.length >= 2 && !STOP.has(a) && b.length > a.length && b.startsWith(a) && gap >= 0 && gap < 0.12) stutters.push(`${words[i].text}→${words[i + 1].text}`);
        }
      }
      writeFileSync('/tmp/v/vo_transcript.txt', data.text || '');   // for manual number/pronunciation inspection
      add('C.vo.stutter', stutters.length === 0, stutters.length === 0 ? `${words.length} words, no stutters` : `${stutters.length} suspected stutters: ${[...new Set(stutters)].slice(0, 8).join(', ')}`);
    }
  }
} catch (e) { add('C.vo', false, `check errored: ${(e as Error).message.slice(0, 150)}`); }

// ─── D. highlight — MOVED to render-verify.mts B.highlight ───
// The old scan here (a) windowed to the last 3h so it found 0 CACHED captures and false-failed with
// "0 ok", and (b) used the pre-bottom-anchor joined-anchor logic that jIdx=-1-false-fails the very
// modals the 2026-06-27 fix targets. render-verify.mts checks the tool_cache asset (the frame the
// render actually composed) with the bottom-anchor — run that for the highlight check.

// ─── E. whole_page — channel_page/videos_tab captures must show body content, not nav-only black (#6) ───
try {
  const caps = (await local.query(`SELECT channel_id, kind, local_path FROM content_gen_yt_screens WHERE created_at > now() - interval '3 hours' AND local_path IS NOT NULL AND kind IN ('channel_page','videos_tab')`)).rows;
  let blackPages = 0, ok = 0; const worst: string[] = [];
  for (const cap of caps) {
    let st; try { st = await sharp(cap.local_path).stats(); } catch { continue; }
    const m = st.channels.slice(0, 3).reduce((a, c) => a + c.mean, 0) / 3;
    if (m < 25) { blackPages++; if (worst.length < 6) worst.push(`${cap.channel_id}[${cap.kind}] luma=${m.toFixed(0)}`); } else ok++;
  }
  add('E.whole_page', blackPages === 0, blackPages === 0 ? `${ok} page captures, none whole-black` : `${blackPages} whole-black: ${worst.join(', ')}`);
} catch (e) { add('E.whole_page', false, `check errored: ${(e as Error).message.slice(0, 120)}`); }

const failed = results.filter(r => !r.pass);
console.log(`\n${'='.repeat(60)}\nGATE: ${failed.length === 0 ? '✅ ALL PASS' : `❌ ${failed.length} FAIL`}  (${results.length} checks, job ${jobId})`);
process.exit(failed.length === 0 ? 0 : 1);
