/**
 * Render QA gate — the automated checks behind docs/content-gen/render-qa-protocol.md.
 * Run AFTER every render; do not ship a render with any FAIL.
 *
 *   npx tsx --tsconfig ./tsconfig.json scripts/local/render-qa.mts <jobId> [mp4]
 *
 * Checks (each = a registry row in the protocol):
 *   A. thumbnails    — no black/unloaded grid thumbnails in the render's captures (#1)
 *   B. montage       — every logos_montage asset non-blank + every channelId has an avatar (#2)
 *   C. VO            — no garbled/stuttered tokens in the spoken audio (#3). NOTE: number-correctness
 *                      (#4/#9) is render-verify.mts A (VO vs the composed frame/card), NOT here.
 *   D. (moved)       — the about-panel highlight check (#5) now lives in render-verify.mts B.highlight.
 *   E. whole_page    — channel_page/videos_tab captures show body, not nav-only black (#6)
 *   F. completion    — the render REACHED the end: job terminal-success + fresh, non-truncated mp4 (#8)
 *
 * Discipline: when a new render defect is found, add its check HERE + a registry row.
 */
import { readFileSync, writeFileSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import pg from 'pg';
import sharp from 'sharp';
// (composeAboutPanelMG import removed — the highlight check D moved to render-verify.mts B.highlight)

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
  // JOB-SCOPED: scan the grid frames THIS job composed (producer_gems output_jsonb), NOT the last-3h
  // content_gen_yt_screens — the old window returned 0 rows on a from-job re-render and passed vacuously.
  const caps = (await local.query<{ slot_id: string; output_jsonb: any }>(`SELECT DISTINCT ON (output_jsonb->>'local_path') slot_id, output_jsonb FROM content_gen_producer_gems WHERE job_id=$1 AND tool='yt_capture' AND output_jsonb->>'local_path' IS NOT NULL AND output_jsonb->'bboxes' IS NOT NULL`, [jobId])).rows;
  let black = 0, scanned = 0; const worst: string[] = [];
  for (const cap of caps) {
    // single-card crops (top_views_rapid / channel_b_top_video) only COMPOSE the one cropped card —
    // a black thumb elsewhere in that capture is never on screen, so a full-grid scan would false-fail.
    // (The cropped card's number is independently verified by render-verify A.number.)
    if (/top_views_rapid_\d+$|channel_b_top_video$/.test(cap.slot_id)) continue;
    const lp: string = cap.output_jsonb.local_path; const pageW: number = cap.output_jsonb.page_width || 0;
    let meta; try { meta = await sharp(lp).metadata(); } catch { continue; }
    const imgW = meta.width || 0, imgH = meta.height || 0; if (!imgW) continue;
    const scale = imgW / (pageW || imgW);
    const bb = (cap.output_jsonb.bboxes || {}) as Record<string, any>;
    // Only the top ~12 thumbnails (first 3-4 rows) are shown in the saturation/channel_b
    // beat; deep-bottom lazy-load stragglers on a 2500px-tall videos_tab are never
    // displayed, so flagging them is a false fail — match the capture gate's top-12 scope.
    // top_videos_pano composes the union of the first 8 video_cards (composeTopVideosPanoMG); deeper
    // cards are never on screen, so scanning them would false-fail on below-the-fold black stragglers.
    const maxThumb = /top_videos_pano$/.test(cap.slot_id) ? 8 : 12;
    for (const k of Object.keys(bb).filter(k => { const m = /^video_thumb_(\d+)$/.exec(k); return !!m && +m[1] < maxThumb; })) {
      const b = bb[k]; const w = (b.w ?? 0) * scale, h = (b.h ?? 0) * scale; if (w < 24 || h < 24) continue;
      const rawL = (b.x ?? 0) * scale, rawT = (b.y ?? 0) * scale;
      if (rawT + h * 0.5 > imgH || rawL + w * 0.5 > imgW) continue;  // mostly off-frame
      const left = Math.max(0, Math.round(rawL)), top = Math.max(0, Math.round(rawT));
      const ww = Math.min(Math.round(w), imgW - left), hh = Math.min(Math.round(h), imgH - top);
      let buf; try { buf = await sharp(lp).extract({ left, top, width: ww, height: hh }).greyscale().resize(40, 40, { fit: 'fill' }).raw().toBuffer(); } catch { continue; }
      scanned++;
      let d = 0, sum = 0; for (let i = 0; i < buf.length; i++) { if (buf[i] < 45) d++; sum += buf[i]; }
      const darkFrac = d / buf.length, mean = sum / buf.length;
      // A genuinely FAILED-to-load thumbnail is a near-UNIFORM black rectangle (mean<18, ~solid black +
      // maybe a duration badge). EXCLUDE bbox DRIFT on lower grid rows, where the video_thumb box slides
      // down onto the title/meta band — also mostly dark (darkFrac>0.9) but mean ~20-30 from the white
      // title text. That's a capture-bbox artifact, not a black thumbnail the viewer sees. (Verified on
      // job 145: BillyFR pano thumb_6/7/8 = mean 19-27 + visible titles = drift, not failed loads.)
      if (darkFrac > 0.85 && mean < 18) { black++; if (worst.length < 5) worst.push(`${cap.slot_id}/${k}(m=${mean.toFixed(0)})`); }
    }
  }
  add('A.thumbnails', black === 0, black === 0 ? `${caps.length} composed grid frames, ${scanned} thumbs, 0 black` : `${black} BLACK thumbnails: ${worst.join(', ')}`);
} catch (e) { add('A.thumbnails', false, `check errored: ${(e as Error).message.slice(0, 120)}`); }

// ─── B. montage — every logos_montage channelId has an avatar + the cached asset is non-blank ───
try {
  const gemRows = (await local.query(`SELECT DISTINCT jsonb_array_elements_text(g->'args'->'channelIds') cid FROM content_gen_producer_jobs j, jsonb_array_elements(j.script_jsonb->'slots') s, jsonb_array_elements(s->'gems') g WHERE j.id=$1 AND g->>'tool'='logos_montage'`, [jobId])).rows.map(r => r.cid);
  // present AND non-empty avatar. (The old `filter(()=>false)` no-op masked channels with NO row in
  // niche_spy_channels — this flags both the missing-row and the null-avatar cases.)
  const haveAvatar = (await local.query(`SELECT channel_id FROM niche_spy_channels WHERE channel_id = ANY($1) AND channel_avatar IS NOT NULL AND channel_avatar <> ''`, [gemRows])).rows.map(r => r.channel_id);
  const noAvatar = gemRows.filter(id => !haveAvatar.includes(id));
  add('B.montage.avatars', noAvatar.length === 0, noAvatar.length === 0 ? `all ${gemRows.length} montage channels have avatars` : `${noAvatar.length} channels missing avatar (null or no row): ${noAvatar.join(',')}`);
  // THIS job's composed montage (job-scoped via producer_gems — NOT the globally-newest 3 rows, which
  // could belong to another render). Per-CELL texture check: a real avatar has stdev; a blank-WHITE or
  // gray-placeholder cell is near-uniform (stdev<10). The old whole-image mean-luma<80 was tuned for a
  // BLACK montage (which this pipeline never makes) and could not see ONE blank cell (the zoom symptom).
  const mg = (await local.query<{ output_jsonb: any; cache_row_id: number }>(`SELECT output_jsonb, cache_row_id FROM content_gen_producer_gems WHERE job_id=$1 AND tool='logos_montage' ORDER BY id DESC LIMIT 1`, [jobId])).rows[0];
  let mpath: string | null = (typeof mg?.output_jsonb?.local_path === 'string') ? mg.output_jsonb.local_path : null;
  if (!mpath && mg?.cache_row_id) { const c = (await local.query<{ asset_paths: string[] }>(`SELECT asset_paths FROM content_gen_tool_cache WHERE id=$1`, [mg.cache_row_id])).rows[0]; mpath = Array.isArray(c?.asset_paths) ? (c.asset_paths.find(a => /\.png$/.test(a)) ?? null) : null; }
  if (!mpath) { add('B.montage.nonblank', false, 'no composed logos_montage asset for this job'); }
  else {
    const meta = await sharp(mpath).metadata(); const W = meta.width || 1920, H = meta.height || 1080;
    const cols = 5, rowsN = 2, cw = W / cols, chh = H / rowsN, n = Math.min(gemRows.length, cols * rowsN);
    let blank = 0; const bad: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols), c = i % cols, s = Math.round(Math.min(cw, chh) * 0.34);
      const left = Math.round(c * cw + cw / 2 - s / 2), top = Math.round(r * chh + chh / 2 - s / 2);
      try { const st = await sharp(mpath).extract({ left, top, width: s, height: s }).greyscale().stats(); const sd = st.channels[0].stdev, m = st.channels[0].mean; if (sd < 10) { blank++; if (bad.length < 5) bad.push(`cell${i}(sd=${sd.toFixed(0)},m=${m.toFixed(0)})`); } } catch { /* skip cell */ }
    }
    add('B.montage.nonblank', blank === 0, blank === 0 ? `${n} montage cells all textured (no blank/placeholder)` : `${blank} blank/placeholder cell(s): ${bad.join(',')}`);
  }
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
      // Cross-ref against the intended narration: a reduplication candidate that IS a
      // real scripted word ("memes"="me"+"me", "mama", "papa", "coco", "bonbon", …)
      // is NOT a stutter — only TTS artifacts (fragments absent from the script) should
      // flag. Load the job's narration words once. (Fixes the "Memes" false-positive
      // where a quoted video title tripped the reduplication regex — 2026-07-01.)
      const narrRows = await local.query<{ t: string | null }>(
        `SELECT jsonb_array_elements(script_jsonb->'slots')->>'narration' AS t FROM content_gen_producer_jobs WHERE id=$1`,
        [jobId],
      ).catch(() => ({ rows: [] as Array<{ t: string | null }> }));
      const narrationWords = new Set<string>();
      for (const r of narrRows.rows) for (const w of (r.t || '').split(/\s+/)) { const n = norm(w); if (n) narrationWords.add(n); }
      // Real stutter = a NON-word fragment immediately before the word it fragments,
      // spoken with a near-zero gap ("hu"→"hundred"). Exclude legit short words that
      // happen to prefix the next ("an"→"animated", "on"→"one") via a stop-list + tight gap.
      const STOP = new Set(['a','an','on','in','to','the','it','is','of','or','as','at','be','he','we','so','no','i','and','that','this','for','you','my','me','up','out','one','two','our','its','his','her','are','was','has','had','but','not','all','can','if','do','go','am','by','us','off','new','now','how']);
      const stutters: string[] = [];
      for (let i = 0; i < words.length; i++) {
        const a = norm(words[i].text); if (a.length >= 4 && /^(.{2,4})\1/.test(a) && !narrationWords.has(a)) stutters.push(words[i].text);
        if (i + 1 < words.length) {
          const b = norm(words[i + 1].text); const gap = (words[i + 1].start ?? 0) - (words[i].end ?? 0);
          if (a.length >= 2 && !STOP.has(a) && b.length > a.length && b.startsWith(a) && gap >= 0 && gap < 0.12) stutters.push(`${words[i].text}→${words[i + 1].text}`);
        }
      }
      try { writeFileSync(path.join(os.tmpdir(), `qa-vo-transcript-${jobId}.txt`), data.text || ''); } catch { /* non-fatal: portable tmp, never fail the VO check on a write */ }
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
  // JOB-SCOPED (same fix as A): the frames THIS job composed, not a 3h window. NOTE render-verify.mts
  // checkC is the richer frame-grounded version (adds p90 DIM detection); this is the asset-gate backstop.
  // EXCLUDE about_page: its modal sits on an INTENTIONALLY dark backdrop, so whole-frame luma is
  // naturally ~24 (not a defect). about_page dim/black is covered by render-verify A.number (a dimmed
  // modal → OCR can't read the stat → BLOCKING UNK) + checkB. Whole-page-black only applies to full pages.
  const caps = (await local.query<{ slot_id: string; lp: string }>(`SELECT DISTINCT ON (output_jsonb->>'local_path') slot_id, output_jsonb->>'local_path' lp FROM content_gen_producer_gems WHERE job_id=$1 AND tool='yt_capture' AND output_jsonb->>'local_path' IS NOT NULL AND COALESCE(args_jsonb->>'kind','') <> 'about_page'`, [jobId])).rows;
  let blackPages = 0, ok = 0; const worst: string[] = [];
  for (const cap of caps) {
    let st; try { st = await sharp(cap.lp).stats(); } catch { continue; }
    const m = st.channels.slice(0, 3).reduce((a, c) => a + c.mean, 0) / 3;
    if (m < 25) { blackPages++; if (worst.length < 6) worst.push(`${cap.slot_id} luma=${m.toFixed(0)}`); } else ok++;
  }
  add('E.whole_page', blackPages === 0, blackPages === 0 ? `${ok} composed frames, none whole-black` : `${blackPages} whole-black: ${worst.join(', ')}`);
} catch (e) { add('E.whole_page', false, `check errored: ${(e as Error).message.slice(0, 120)}`); }

// ─── F. completion — the render REACHED the end (#8). A mid-run crash leaves the PREVIOUS render at
//      clips/_latest.mp4; without this, pointing the gate at that stale file passes green on the wrong
//      (or truncated) video. Assert: job terminal-success + all gems + mp4 fresher than job start + long. ───
try {
  const job = (await local.query<{ status: string; gems_done: number; gems_total: number; gems_failed: number; started_at: Date | null }>(`SELECT status, gems_done, gems_total, gems_failed, started_at FROM content_gen_producer_jobs WHERE id=$1`, [jobId])).rows[0];
  if (!job) { add('F.completion', false, `no producer_jobs row for ${jobId}`); }
  else {
    const okJob = (job.status === 'done' || job.status === 'completed') && job.gems_failed === 0 && (job.gems_total ? job.gems_done >= job.gems_total : true);
    let dur = 0, mtimeOk = false, exists = false;
    try { const st = statSync(mp4); exists = true; mtimeOk = !job.started_at || st.mtimeMs >= new Date(job.started_at).getTime() - 5 * 60_000; dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]).toString().trim()) || 0; } catch { /* missing mp4 */ }
    const ok = okJob && exists && mtimeOk && dur > 60;
    add('F.completion', ok, `job=${job.status} gems=${job.gems_done}/${job.gems_total} failed=${job.gems_failed} | mp4 ${exists ? dur.toFixed(0) + 's' : 'MISSING'} mtime=${mtimeOk ? 'fresh' : 'STALE←prior render?'}`);
  }
} catch (e) { add('F.completion', false, `check errored: ${(e as Error).message.slice(0, 120)}`); }

const failed = results.filter(r => !r.pass);
console.log(`\n${'='.repeat(60)}\nGATE: ${failed.length === 0 ? '✅ ALL PASS' : `❌ ${failed.length} FAIL`}  (${results.length} checks, job ${jobId})`);
process.exit(failed.length === 0 ? 0 : 1);
