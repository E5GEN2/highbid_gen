import { composeAboutPanelMG } from './lib/content-gen/yt-compose-mg';
import sharpLib from 'sharp';
const sharp = sharpLib;

const basePath = '/Users/rofe/Desktop/lab/hbgen/highbid_gen/clips/yt_screens/UCM-XPFv_VoHHxx-77Ux_a_w_about_page_2026-06-27.png';
const anchorBbox = { x: 504, y: 571, w: 127, h: 16 }; // joined_date for Domain Films

const { path: composed, map: panelMap } = await composeAboutPanelMG(basePath, anchorBbox);
console.log('panelMap:', JSON.stringify(panelMap));

const { data, info } = await sharp(composed).raw().toBuffer({ resolveWithObject: true });
const rows: Array<{ top: number; h: number }> = [];
let inRow = false, startY = 0;
for (let y = 200; y < 900; y++) {
  let bright = 0;
  for (let x = 650; x < 760; x++) {
    const off = (y * info.width + x) * info.channels;
    bright += (data[off] + data[off + 1] + data[off + 2]) / 3;
  }
  bright /= 110;
  if (bright > 50 && !inRow) { startY = y; inRow = true; }
  else if (bright <= 50 && inRow) { const h = y - startY; if (h >= 8 && h < 30) rows.push({ top: startY, h }); inRow = false; }
}
const joinedCanvasY = panelMap.offY + (anchorBbox.y - panelMap.cropY) * panelMap.scale;
const joinedCenter = joinedCanvasY + (anchorBbox.h * panelMap.scale) / 2;
const jIdx = rows.findIndex(rr => joinedCenter >= rr.top - 4 && joinedCenter <= rr.top + rr.h + 6);
const below = jIdx >= 0 ? rows.slice(jIdx + 1) : rows.filter(rr => rr.top > joinedCenter);
console.log('scanned rows (x=650-760):');
rows.forEach((r, i) => console.log(`  #${i} top=${r.top} h=${r.h}${i === jIdx ? '  <-- jIdx (Joined)' : ''}${r === below[0] ? '  <-- below[0] (subscribers target)' : ''}`));
console.log(`joinedCanvasY=${joinedCanvasY.toFixed(1)} joinedCenter=${joinedCenter.toFixed(1)} jIdx=${jIdx}`);
console.log('below[0] =', JSON.stringify(below[0]));

let svg = `<svg width="${info.width}" height="${info.height}">`;
rows.forEach((r, i) => {
  const c = i === jIdx ? 'red' : (r === below[0] ? 'lime' : 'deepskyblue');
  svg += `<rect x="580" y="${r.top}" width="760" height="${r.h}" fill="none" stroke="${c}" stroke-width="3"/>`;
  svg += `<text x="1350" y="${r.top + r.h}" fill="${c}" font-size="22" font-family="sans-serif">#${i}</text>`;
});
svg += `<line x1="0" y1="${joinedCenter}" x2="1920" y2="${joinedCenter}" stroke="yellow" stroke-width="2"/></svg>`;
await sharp(composed).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile('/tmp/v/h5_debug.png');
console.log('saved /tmp/v/h5_debug.png');
process.exit(0);
