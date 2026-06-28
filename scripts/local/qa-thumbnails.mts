/**
 * QA: detect BLACK / unloaded video thumbnails in beat captures.
 *
 * YouTube lazy-loads grid thumbnails; if a videos_tab/channel_page capture is
 * shot before they paint, the thumbnail regions render solid black in the final
 * video (user 2026-06-26: "Spy Cat Girl" card + the Royal Walls Archives grid).
 *
 * Metric = FRACTION OF DARK PIXELS in each detected `video_thumb_N` region.
 * Mean/stddev are unreliable here: a blank thumbnail still carries a white
 * duration badge ("55:27") whose pure-white pixels spike stddev to ~30 and lift
 * the mean, masking the black (cap#768: mean=19.8 sd=29.6 but min=6). A blank
 * thumbnail is ~95% dark pixels with a sliver of badge/title text; a loaded one
 * is mostly mid-tones. So: resize each thumb to 40x40 greyscale, count pixels
 * below DARK_CUT, flag when that fraction exceeds FRAC_T.
 *
 * Usage: npx tsx --tsconfig ./tsconfig.json scripts/local/qa-thumbnails.mts [hoursBack=12]
 */
import { readFileSync } from 'fs';
import pg from 'pg';
import sharp from 'sharp';

const env = readFileSync(new URL('../../.env.local', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const i = l.indexOf('='); if (i < 0) continue; const k = l.slice(0, i).trim(); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (k && process.env[k] === undefined) process.env[k] = v; }

const hoursBack = Number(process.argv[2] || 12);
const DARK_CUT = 45;     // pixel luminance below this counts as "dark"
const FRAC_T = 0.80;     // > this fraction of dark pixels = blank/unloaded thumbnail
const MIN_PX = 24;       // ignore tiny boxes

const local = new pg.Pool({ connectionString: 'postgresql://localhost:5432/hbgen_local', ssl: false });

const caps = (await local.query(
  `SELECT s.id, s.channel_id, s.kind, s.local_path, s.bboxes_jsonb, s.page_width, c.channel_name
     FROM content_gen_yt_screens s
     LEFT JOIN niche_spy_channels c ON c.channel_id = s.channel_id
    WHERE s.created_at > now() - ($1 || ' hours')::interval
      AND s.local_path IS NOT NULL AND s.bboxes_jsonb IS NOT NULL
    ORDER BY s.id DESC`, [String(hoursBack)])).rows;

console.log(`scanning ${caps.length} captures from the last ${hoursBack}h (>${Math.round(FRAC_T * 100)}% pixels < ${DARK_CUT} lum = BLACK)\n`);

const flagged: Array<{ id: number; channel: string; name: string; kind: string; black: number; total: number; worstFrac: number }> = [];
const buckets = [0, 0, 0, 0, 0]; // [<.2, .2-.5, .5-.8, .8-.95, >.95]

for (const c of caps) {
  let meta; try { meta = await sharp(c.local_path).metadata(); } catch { continue; }
  const imgW = meta.width || 0, imgH = meta.height || 0; if (!imgW) continue;
  const scale = imgW / (c.page_width || imgW);
  const bb = c.bboxes_jsonb as Record<string, any>;
  const thumbKeys = Object.keys(bb).filter(k => /^video_thumb_\d+$/.test(k));
  if (!thumbKeys.length) continue;
  let black = 0, total = 0, worstFrac = 0;
  for (const k of thumbKeys) {
    const box = bb[k]; if (!box) continue;
    const w = (box.w ?? box.width ?? 0) * scale, h = (box.h ?? box.height ?? 0) * scale;
    if (w < MIN_PX || h < MIN_PX) continue;
    const left = Math.max(0, Math.min(Math.round((box.x ?? box.left ?? 0) * scale), imgW - 2));
    const top = Math.max(0, Math.min(Math.round((box.y ?? box.top ?? 0) * scale), imgH - 2));
    const ww = Math.max(4, Math.min(Math.round(w), imgW - left)), hh = Math.max(4, Math.min(Math.round(h), imgH - top));
    let buf; try { buf = await sharp(c.local_path).extract({ left, top, width: ww, height: hh }).greyscale().resize(40, 40, { fit: 'fill' }).raw().toBuffer(); } catch { continue; }
    let dark = 0; for (let i = 0; i < buf.length; i++) if (buf[i] < DARK_CUT) dark++;
    const frac = dark / buf.length;
    total++;
    buckets[frac < 0.2 ? 0 : frac < 0.5 ? 1 : frac < 0.8 ? 2 : frac < 0.95 ? 3 : 4]++;
    if (frac > FRAC_T) { black++; worstFrac = Math.max(worstFrac, frac); }
  }
  if (black > 0) flagged.push({ id: c.id, channel: c.channel_id, name: c.channel_name || '?', kind: c.kind, black, total, worstFrac });
}

console.log(`thumb dark-fraction distribution:  <20%:${buckets[0]}  20-50%:${buckets[1]}  50-80%:${buckets[2]}  80-95%:${buckets[3]}  >95%:${buckets[4]}\n`);

if (!flagged.length) { console.log('✅ no black thumbnails detected.'); }
else {
  console.log(`⚠️  ${flagged.length} captures with BLACK thumbnails:\n`);
  for (const f of flagged.sort((a, b) => (b.black / b.total) - (a.black / a.total)))
    console.log(`  cap#${f.id} ${f.name} [${f.kind}] — ${f.black}/${f.total} thumbs black (worst ${Math.round(f.worstFrac * 100)}% dark)`);
  const fully = flagged.filter(f => f.black === f.total).length;
  console.log(`\n=> ${flagged.length} affected captures (${fully} fully black) across ${[...new Set(flagged.map(f => f.channel))].length} channels.`);
}
process.exit(0);
