/**
 * YouTube screen capture via Playwright through xgodo proxies.
 *
 * The visual grammar wants AUTHENTIC YouTube screens — the yellow_highlight
 * on "160K subscribers" beat lands because the viewer's brain recognizes a
 * real YT channel page, not a mockup. We capture them through our proven
 * proxy egress (same one yt-dlp / niche-spy use) so:
 *   - YT serves the localized count for the right geo (matches rpm.geo)
 *   - we don't burn our datacenter IP into YT's bot list
 *   - we avoid the consent wall variants tied to suspicious IPs
 *
 * Cached per (channel_id, kind, date_bucket) — same day = free disk hit.
 * Roll the bucket to refresh; old PNG stays around until the new one lands.
 */

import path from 'path';
import fs from 'fs/promises';
import { getPool } from '../db';
import { CLIPS_DIR } from '../clips-dir';
import { getRandomHealthyProxy, type ProxyInfo } from '../xgodo-proxy';

const SCREENS_DIR = path.join(CLIPS_DIR, 'yt_screens');
const VIEWPORT = { width: 1440, height: 900 };  // generous card framing; YT looks correct
const NAV_TIMEOUT_MS = 45_000;
const NETIDLE_MS = 3_000;
const SCREENSHOT_TIMEOUT_MS = 15_000;

export type ScreenKind = 'channel_page' | 'about_page' | 'videos_tab' | 'watch_page';
export type CaptureMode = 'static' | 'scroll_record';
export type AssetKind = 'image' | 'video';

/** Element bounding boxes for the render-stage annotations (yellow ring on
 *  subscribers, yellow box on total views, etc). Coordinates are viewport
 *  pixels (devicePixelRatio = 1) anchored to the captured PNG/MP4 frame. */
export interface BBox { x: number; y: number; w: number; h: number; }
export type BBoxMap = Record<string, BBox>;

/** Common element-name vocabulary the renderer reads from bboxes_jsonb. */
export const ANNOTATABLE = {
  subscribers:  'subscriber_count',
  videos:       'video_count',
  total_views:  'total_views',
  joined_date:  'joined_date',
  channel_name: 'channel_name',
  channel_avatar: 'channel_avatar',
} as const;

const GEO_LANG: Record<string, { country: string; lang: string }> = {
  us: { country: 'US', lang: 'en-US,en;q=0.9' },
  uk: { country: 'GB', lang: 'en-GB,en;q=0.9' },
  gb: { country: 'GB', lang: 'en-GB,en;q=0.9' },
  ca: { country: 'CA', lang: 'en-CA,en;q=0.9' },
  au: { country: 'AU', lang: 'en-AU,en;q=0.9' },
  in: { country: 'IN', lang: 'en-IN,en;q=0.9' },
};

export interface CaptureResult {
  id: number;
  channel_id: string;
  handle: string | null;
  kind: ScreenKind;
  url: string;
  local_path: string;
  bytes: number;
  date_bucket: string;
  geo: string | null;
  proxy_country: string | null;
  cached: boolean;
  asset_kind: AssetKind;          // image | video
  capture_mode: CaptureMode;      // static | scroll_record
  duration_s: number | null;      // video duration if asset_kind='video'
  bboxes: BBoxMap;                // element-name → {x,y,w,h} for annotations
}

function todayBucket(): string {
  return new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
}

/**
 * Per-ScreenKind selector vocabulary. Used inside the browser context (so
 * the names get inlined) by the extractBBoxes helper. YT's class names rotate
 * every few months; we keep the rules tolerant (multiple selectors per slot,
 * first match wins) so a single redesign doesn't break the whole capture.
 *
 * The semantic names here MUST match the keys in ANNOTATABLE so the renderer
 * can address them by a stable id.
 */
const BBOX_SELECTORS: Record<ScreenKind, Record<string, string[]>> = {
  channel_page: {
    channel_name:    ['yt-dynamic-text-view-model h1', 'ytd-channel-name h1', 'h1.ytd-c4-tabbed-header-renderer'],
    channel_avatar:  ['yt-decorated-avatar-view-model img', 'yt-img-shadow img.yt-img-shadow', '#channel-header img.yt-img-shadow'],
    subscriber_count:[
      'span.yt-content-metadata-view-model-wiz__metadata-text:has-text("subscribers")',
      'yt-formatted-string#subscriber-count',
      '#channel-header #subscriber-count',
    ],
    video_count: [
      'span.yt-content-metadata-view-model-wiz__metadata-text:has-text("videos")',
    ],
  },
  about_page: {
    channel_name:    ['yt-dynamic-text-view-model h1', 'ytd-channel-name h1'],
    subscriber_count:[
      'table.about-stats yt-formatted-string:has-text("subscribers")',
      'span:has-text("subscribers")',
    ],
    total_views: [
      'table.about-stats yt-formatted-string:has-text("views")',
      'span:has-text("views")',
    ],
    joined_date: [
      'table.about-stats yt-formatted-string:has-text("Joined")',
      'span:has-text("Joined")',
    ],
  },
  videos_tab: {
    channel_name:    ['yt-dynamic-text-view-model h1', 'ytd-channel-name h1'],
  },
  watch_page: {
    channel_name:    ['ytd-video-owner-renderer ytd-channel-name a'],
    subscriber_count:['#subscriber-count', 'ytd-video-owner-renderer #owner-sub-count'],
  },
};

function urlFor(kind: ScreenKind, handle: string | null, channelId: string, watchVideoId?: string | null): string {
  const h = handle ? (handle.startsWith('@') ? handle : `@${handle}`) : null;
  switch (kind) {
    case 'channel_page': return h ? `https://www.youtube.com/${h}` : `https://www.youtube.com/channel/${channelId}`;
    case 'about_page':   return h ? `https://www.youtube.com/${h}/about` : `https://www.youtube.com/channel/${channelId}/about`;
    case 'videos_tab':   return h ? `https://www.youtube.com/${h}/videos` : `https://www.youtube.com/channel/${channelId}/videos`;
    case 'watch_page':   if (!watchVideoId) throw new Error('watch_page needs watchVideoId'); return `https://www.youtube.com/watch?v=${watchVideoId}`;
  }
}

/**
 * Capture one YT screen, cached. If the row already exists at status=done
 * for today's bucket, returns it without touching Playwright/proxies.
 */
export async function captureYtScreen(channelId: string, opts: { kind?: ScreenKind; mode?: CaptureMode; geo?: string; force?: boolean; watchVideoId?: string | null } = {}): Promise<CaptureResult> {
  const kind = opts.kind ?? 'channel_page';
  const mode: CaptureMode = opts.mode ?? (kind === 'videos_tab' ? 'scroll_record' : 'static');
  const pool = await getPool();

  // Look up handle (saves a YT redirect roundtrip and gives clean URL).
  const ch = (await pool.query<{ channel_handle: string | null }>(
    `SELECT channel_handle FROM niche_spy_channels WHERE channel_id = $1`, [channelId],
  )).rows[0];
  const handle = ch?.channel_handle ?? null;
  const dateBucket = todayBucket();
  const url = urlFor(kind, handle, channelId, opts.watchVideoId);

  // Cache check — must also match capture_mode + asset_kind so a stored
  // image isn't returned for a scroll_record request and vice versa.
  if (!opts.force) {
    const hit = (await pool.query<{ id: number; local_path: string | null; bytes: number | null; geo: string | null; proxy_country: string | null; asset_kind: AssetKind | null; capture_mode: CaptureMode | null; duration_s: number | null; bboxes_jsonb: BBoxMap | null }>(
      `SELECT id, local_path, bytes, geo, proxy_country, asset_kind, capture_mode, duration_s, bboxes_jsonb
         FROM content_gen_yt_screens
        WHERE channel_id = $1 AND kind = $2 AND date_bucket = $3 AND status = 'done'
          AND COALESCE(capture_mode, 'static') = $4`,
      [channelId, kind, dateBucket, mode],
    )).rows[0];
    if (hit && hit.local_path) {
      try {
        const st = await fs.stat(hit.local_path);
        if (st.size > 0) {
          return {
            id: hit.id, channel_id: channelId, handle, kind, url,
            local_path: hit.local_path, bytes: hit.bytes ?? st.size,
            date_bucket: dateBucket, geo: hit.geo, proxy_country: hit.proxy_country, cached: true,
            asset_kind: hit.asset_kind ?? 'image', capture_mode: hit.capture_mode ?? 'static',
            duration_s: hit.duration_s, bboxes: hit.bboxes_jsonb ?? {},
          };
        }
      } catch { /* file gone — recapture */ }
    }
  }

  // Reserve a row so concurrent calls don't double-capture.
  const ins = await pool.query<{ id: number }>(
    `INSERT INTO content_gen_yt_screens (channel_id, handle, kind, url, geo, date_bucket, capture_mode, status, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'capturing',NOW())
     ON CONFLICT (channel_id, kind, date_bucket) DO UPDATE SET capture_mode = EXCLUDED.capture_mode, status='capturing', started_at=NOW(), error=NULL, updated_at=NOW()
     RETURNING id`,
    [channelId, handle, kind, url, opts.geo ?? null, dateBucket, mode],
  );
  const rowId = ins.rows[0].id;

  try {
    const result = await runCapture(rowId, channelId, handle, kind, url, opts.geo ?? null, dateBucket, mode);
    return result;
  } catch (err) {
    await pool.query(
      `UPDATE content_gen_yt_screens SET status='failed', error=$1, finished_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [(err as Error).message.slice(0, 600), rowId],
    ).catch(() => {});
    throw err;
  }
}

async function runCapture(rowId: number, channelId: string, handle: string | null, kind: ScreenKind, url: string, geo: string | null, dateBucket: string, captureMode: CaptureMode): Promise<CaptureResult> {
  // Lazy-load Playwright (Next.js avoids bundling it client-side).
  const { chromium } = await import('playwright');

  const proxy = await getRandomHealthyProxy().catch(() => null);
  if (!proxy) throw new Error('no healthy xgodo proxy available');

  const geoCfg = GEO_LANG[(geo ?? '').toLowerCase()] ?? GEO_LANG[proxy.country.toLowerCase()] ?? GEO_LANG.us;

  await fs.mkdir(SCREENS_DIR, { recursive: true });
  const localPath = path.join(SCREENS_DIR, `${channelId}_${kind}_${dateBucket}.png`);

  // Our prod pool is SOCKS5+auth (the static list in lib/static-proxies.ts).
  // Chromium has two long-standing limitations:
  //   1. Can't auth to SOCKS5 at all ("Browser does not support socks5 proxy
  //      authentication")
  //   2. Linux Proxy-Authorization isn't sent on CONNECT → upstream RSTs
  // proxy-chain only handles HTTP upstreams so it doesn't help here.
  // We use our own in-process bridge: tiny anonymous HTTP CONNECT listener on
  // localhost; each tunnel opens a SOCKS5+auth connection via the `socks`
  // package and pipes bytes both ways. Chromium sees a no-auth local proxy
  // (bypasses both bugs); TLS terminates between Chromium and the origin.
  const { createSocksHttpBridge } = await import('./socks-http-bridge');
  const isSocks = /^socks/i.test(proxy.url);
  const bridge = isSocks ? await createSocksHttpBridge(proxy.url) : null;
  const localProxyUrl = bridge ? bridge.url : proxy.url;

  // On Railway we use the system /usr/bin/chromium (no 130MB Playwright
  // browser bundle). Locally Playwright falls back to its own bundled
  // chromium-headless-shell when the env var is unset.
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_PATH || undefined;
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
    proxy: { server: localProxyUrl },   // anonymous local — no creds needed in Chromium
    ...(executablePath ? { executablePath } : {}),
  });
  // Scroll-record mode: ask Playwright to capture a webm of the session.
  // Playwright writes to a random path inside videosDir; we move it into
  // place once the context closes. Webm is the only format playwright
  // outputs — the renderer can transcode to mp4 with ffmpeg downstream.
  const videosDir = path.join(SCREENS_DIR, '_video_tmp');
  let recorderVideoPathPromise: Promise<string> | null = null;
  if (captureMode === 'scroll_record') {
    await fs.mkdir(videosDir, { recursive: true });
  }
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      locale: geoCfg.lang.split(',')[0],
      timezoneId: 'UTC',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Accept-Language': geoCfg.lang },
      ...(captureMode === 'scroll_record' ? { recordVideo: { dir: videosDir, size: VIEWPORT } } : {}),
    });
    const page = await context.newPage();
    if (captureMode === 'scroll_record') {
      // Reach into the active page's video object — its path() resolves to
      // the final on-disk path once the context closes.
      const v = page.video();
      recorderVideoPathPromise = v ? v.path() : null;
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // YouTube/Google consent wall — appears for EU egress + sometimes US.
    // Try "Accept all" / "Reject all" / "I agree" buttons in any locale.
    await page.evaluate(() => {
      const tap = (sel: string) => { const el = document.querySelector(sel) as HTMLElement | null; if (el) el.click(); };
      const labels = ['Accept all', 'Reject all', 'I agree', 'Akzeptieren', 'Ich stimme zu', 'Tout accepter', 'Aceptar todo'];
      for (const t of labels) {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
        const hit = btns.find(b => (b.textContent ?? '').trim().toLowerCase() === t.toLowerCase());
        if (hit) { hit.click(); break; }
      }
      tap('button[aria-label*="Accept"]');
      tap('button[aria-label*="Reject"]');
    }).catch(() => {});

    // Wait for the page to settle. networkidle can hang forever on YT
    // (background polls), so cap it at NETIDLE_MS and swallow the timeout
    // rejection — a not-quite-idle page is fine for our screenshot.
    await page.waitForLoadState('networkidle', { timeout: NETIDLE_MS }).catch(() => {});
    await page.waitForTimeout(800);

    // Extract element bboxes for the renderer's annotation overlays. Done
    // BEFORE the screenshot so the layout we measure matches the captured
    // pixels exactly. Each selector is tried in order; first match wins.
    // Per-selector failure is swallowed so partial bboxes still come back.
    const selectorsForKind = BBOX_SELECTORS[kind] ?? {};
    const bboxes: BBoxMap = await page.evaluate(([sels]) => {
      const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
      const matchByText = (root: Document, sel: string): Element | null => {
        // ":has-text(...)" isn't a CSS pseudo; emulate it.
        const m = sel.match(/^(.*?):has-text\("([^"]+)"\)$/);
        if (!m) { try { return root.querySelector(sel); } catch { return null; } }
        const [, base, needle] = m;
        const n = needle.toLowerCase();
        try {
          const list = Array.from(root.querySelectorAll(base));
          return list.find(el => (el.textContent ?? '').toLowerCase().includes(n)) ?? null;
        } catch { return null; }
      };
      for (const [name, list] of Object.entries(sels as Record<string, string[]>)) {
        for (const sel of list) {
          const el = matchByText(document, sel);
          if (!el) continue;
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          out[name] = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
          break;
        }
      }
      return out;
    }, [selectorsForKind]).catch(() => ({} as BBoxMap));

    // Branch: static screenshot OR scroll-record video.
    let buf: Buffer;
    let assetKind: AssetKind = 'image';
    let videoLocalPath = localPath;
    let durationS: number | null = null;
    let videoSrcPath: string | null = null;

    if (captureMode === 'scroll_record' && recorderVideoPathPromise) {
      // Pan through the page by scrolling at a steady rate. Hold at top
      // and bottom briefly so the cut points land on still frames.
      const scrollPxPerStep = 80;
      const stepIntervalMs = 60;
      const maxSteps = 90;     // ~5.4s of scroll at default settings
      assetKind = 'video';
      await page.waitForTimeout(600);
      for (let i = 0; i < maxSteps; i++) {
        const stop = await page.evaluate((d) => {
          const before = window.scrollY;
          window.scrollBy({ top: d, behavior: 'auto' });
          return Math.abs(window.scrollY - before) < d / 4;
        }, scrollPxPerStep);
        if (stop) break;
        await page.waitForTimeout(stepIntervalMs);
      }
      await page.waitForTimeout(500);
      // Single still as a fallback preview (also helps the GUI thumbnail).
      const stillBuf = await page.screenshot({ fullPage: false, type: 'png', timeout: SCREENSHOT_TIMEOUT_MS });
      await fs.writeFile(localPath.replace(/\.png$/, '_poster.png'), stillBuf);

      // Close context to flush the recording, then move the .webm into place.
      await context.close();
      videoSrcPath = await recorderVideoPathPromise;
      videoLocalPath = localPath.replace(/\.png$/, '.webm');
      try { await fs.rename(videoSrcPath, videoLocalPath); } catch { await fs.copyFile(videoSrcPath, videoLocalPath); }
      buf = await fs.readFile(videoLocalPath);
      // We don't bundle ffprobe in the lib; estimate duration from the
      // scroll loop budget. Real probe happens client-side via media element.
      durationS = Math.min(maxSteps * stepIntervalMs / 1000, 6);
    } else {
      buf = await page.screenshot({ fullPage: false, type: 'png', timeout: SCREENSHOT_TIMEOUT_MS });
      await fs.writeFile(localPath, buf);
      videoLocalPath = localPath;
    }

    const finalPath = assetKind === 'video' ? videoLocalPath : localPath;

    const pool = await getPool();
    await pool.query(
      `UPDATE content_gen_yt_screens SET status='done', local_path=$1, page_width=$2, page_height=$3,
         bytes=$4, proxy_country=$5, proxy_device=$6, asset_kind=$7, capture_mode=$8,
         duration_s=$9, bboxes_jsonb=$10, error=NULL, finished_at=NOW(), updated_at=NOW()
        WHERE id=$11`,
      [finalPath, VIEWPORT.width, VIEWPORT.height, buf.length, proxy.country, proxy.deviceId,
       assetKind, captureMode, durationS, JSON.stringify(bboxes), rowId],
    );

    return {
      id: rowId, channel_id: channelId, handle, kind, url,
      local_path: finalPath, bytes: buf.length,
      date_bucket: dateBucket, geo, proxy_country: proxy.country, cached: false,
      asset_kind: assetKind, capture_mode: captureMode, duration_s: durationS, bboxes,
    };
  } finally {
    await browser.close().catch(() => {});
    if (bridge) await bridge.close().catch(() => {});
  }
}

/** Read a captured screen off the volume (for the serve endpoint).
 *  Picks the content-type from the file extension so the same handler
 *  serves both PNG (static) and WebM (scroll_record). */
export async function readYtScreenFile(id: number): Promise<{ buf: Buffer; contentType: string } | null> {
  const pool = await getPool();
  const r = await pool.query<{ local_path: string | null }>(
    `SELECT local_path FROM content_gen_yt_screens WHERE id = $1`, [id],
  );
  const p = r.rows[0]?.local_path;
  if (!p) return null;
  try {
    const buf = await fs.readFile(p);
    const ext = path.extname(p).toLowerCase();
    const contentType =
      ext === '.webm' ? 'video/webm' :
      ext === '.mp4'  ? 'video/mp4' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      'image/png';
    return { buf, contentType };
  } catch { return null; }
}

/** Capture a batch of channels' channel_page screens with bounded concurrency.
 *  Each capture costs ~5-10s on the proxy path. */
export async function captureBatch(channelIds: string[], opts: { kind?: ScreenKind; mode?: CaptureMode; geo?: string; force?: boolean; concurrency?: number } = {}): Promise<{ ok: number; failed: number; results: Array<CaptureResult | { channel_id: string; error: string }> }> {
  const conc = Math.max(1, Math.min(4, opts.concurrency ?? 2));
  const results: Array<CaptureResult | { channel_id: string; error: string }> = new Array(channelIds.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= channelIds.length) return;
      try { results[i] = await captureYtScreen(channelIds[i], { kind: opts.kind, mode: opts.mode, geo: opts.geo, force: opts.force }); }
      catch (e) { results[i] = { channel_id: channelIds[i], error: (e as Error).message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, channelIds.length) }, () => worker()));
  return {
    ok: results.filter(r => !('error' in r)).length,
    failed: results.filter(r => 'error' in r).length,
    results,
  };
}
