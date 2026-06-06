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
import { spawn } from 'child_process';
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

/** Highlight styles the renderer requests (mirrors slot-rendering-class-b). */
export type HighlightStyle = 'yellow_ring' | 'yellow_box' | 'yellow_highlight' | 'yellow_circle';
export type AnnotateElement =
  'subscriber_count' | 'video_count' | 'total_views' | 'joined_date' | 'view_count';
export interface AnnotateSpec { element: AnnotateElement; style: HighlightStyle; }

/** Regex finders for each annotatable element, used by the locator engine
 *  which pierces both open AND closed shadow DOM (closed yt-attributed-string
 *  roots are the reason in-page DOM walks miss the modal text). The regex
 *  is matched against the element's visible text. */
const ANNOTATE_REGEX: Record<AnnotateElement, string> = {
  subscriber_count: '^\\s*[\\d.,]+\\s*[KMB]?\\s*subscribers?\\s*$',
  video_count:      '^\\s*[\\d.,]+\\s*[KMB]?\\s*videos?\\s*$',
  total_views:      '^\\s*[\\d.,]+\\s*[KMB]?\\s*views?\\s*$',
  joined_date:      '^\\s*Joined\\s+\\w+\\s+\\d{1,2},?\\s+\\d{4}\\s*$',
  view_count:       '^\\s*[\\d.,]+\\s*[KMB]?\\s*views?\\s*$',
};

/** Size bounds for the annotation candidate. Generous enough to allow row-
 *  wrappers (icon + text) that YT's locator engine may match, since text=
 *  matches against innerText which collects all descendants — picking the
 *  smallest-area within these bounds still lands on a sensible target. */
const ANNOTATE_SIZE: Record<AnnotateElement, { minW: number; maxW: number; minH: number; maxH: number }> = {
  subscriber_count: { minW: 40, maxW: 500, minH: 12, maxH: 60 },
  video_count:      { minW: 30, maxW: 500, minH: 12, maxH: 60 },
  total_views:      { minW: 30, maxW: 500, minH: 12, maxH: 60 },
  joined_date:      { minW: 60, maxW: 500, minH: 12, maxH: 60 },
  view_count:       { minW: 30, maxW: 500, minH: 12, maxH: 60 },
};

/** Ancestor scope tag selectors (lowercase). When set, the candidate element
 *  must have an ancestor (or itself) whose tagName matches one of these. This
 *  prevents picking sidebar/recommended-row "X views" entries when we want
 *  the about modal's view count, etc.
 *  Walk the ancestor chain across shadow DOM boundaries (parentElement OR
 *  shadow-root host) to handle Polymer custom elements. */
const ANNOTATE_SCOPE: Partial<Record<AnnotateElement, string[]>> = {
  // about modal / engagement panel containers — strict scope for the modal-
  // shown stats. We include several variants because YT's panel naming has
  // changed historically (channel-about-metadata, engagement-panel,
  // tp-yt-paper-dialog for older modal style).
  total_views:  ['ytd-channel-about-metadata-renderer', 'ytd-engagement-panel-section-list-renderer', 'tp-yt-paper-dialog', 'ytd-about-channel-renderer'],
  joined_date:  ['ytd-channel-about-metadata-renderer', 'ytd-engagement-panel-section-list-renderer', 'tp-yt-paper-dialog', 'ytd-about-channel-renderer'],
  // channel header area — for the subscriber + video counts shown in the
  // page-level header (NOT the modal duplicate).
  subscriber_count: ['ytd-c4-tabbed-header-renderer', 'yt-page-header-renderer', 'ytd-channel-header-renderer'],
  video_count:      ['ytd-c4-tabbed-header-renderer', 'yt-page-header-renderer', 'ytd-channel-header-renderer'],
  // view counts on grid cards (videos_tab) OR on watch_page header info row.
  // The scope walker checks ancestors via parentElement + shadow-root host,
  // so any of these tags being an ancestor of the matched text element is OK.
  view_count: [
    // videos_tab grid card renderers
    'ytd-rich-item-renderer', 'ytd-grid-video-renderer', 'ytd-video-renderer', 'ytd-rich-grid-media',
    // watch_page info containers
    'ytd-watch-metadata', 'ytd-video-primary-info-renderer',
  ],
};

/** Inline CSS for each highlight style. Applied via el.style on the
 *  located element BEFORE screenshot — the highlight is baked into the
 *  captured PNG, no compositing needed on the renderer side.
 *  !important overrides YT's stylesheet (which has high specificity from
 *  classes layered with web component styles). */
const HIGHLIGHT_CSS: Record<HighlightStyle, string> = {
  yellow_ring:      `outline: 6px solid #FACC15 !important; outline-offset: 8px !important; border-radius: 12px !important; box-shadow: 0 0 0 14px rgba(250,204,21,0.35), 0 0 24px rgba(250,204,21,0.5) !important;`,
  yellow_box:       `outline: 6px solid #FACC15 !important; outline-offset: 4px !important; box-shadow: 0 0 0 10px rgba(250,204,21,0.35), 0 0 18px rgba(250,204,21,0.45) !important;`,
  yellow_highlight: `background-color: rgba(250, 204, 21, 0.65) !important; padding: 2px 6px !important; border-radius: 4px !important; box-shadow: 0 0 12px rgba(250,204,21,0.6) !important;`,
  yellow_circle:    `outline: 7px solid #FACC15 !important; outline-offset: 14px !important; border-radius: 50% !important; box-shadow: 0 0 0 20px rgba(250,204,21,0.3), 0 0 32px rgba(250,204,21,0.55) !important;`,
};

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
  /** Per-rule diagnostic dump (when present): regex_matches / rejected_*  /
   *  accepted / sample_texts / sample_covered. Temporary scaffolding to debug
   *  selector misses. */
  bbox_debug?: Record<string, unknown>;
  /** Diagnostic for the annotation pass (when annotate was set): how many
   *  text= locator matches were found, their dimensions + visibility, which
   *  was picked, whether the CSS got applied. */
  annotation_debug?: Record<string, unknown>;
}

function todayBucket(): string {
  return new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
}

/** Spawn ffmpeg with the given args and resolve when it exits 0. */
function runFfmpeg(args: string[], timeoutMs = 90_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`ffmpeg timeout`)); }, timeoutMs);
    p.on('close', c => { clearTimeout(t); c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}: ${err.slice(0, 300)}`)); });
    p.on('error', e => { clearTimeout(t); reject(e); });
  });
}

/**
 * Per-ScreenKind bbox rules. Resilient strategy: regex over the page's
 * VISIBLE text. We walk the rendered DOM, look at each element's textContent,
 * find the tightest element whose own text matches the regex, return its
 * bounding rect. This survives YT class-name churn entirely.
 *
 *   name:   semantic id (key in ANNOTATABLE — what the renderer addresses)
 *   regex:  must match the element's own text (no children) — keeps it tight
 *   hint:   optional CSS scope to limit search (header, banner, owner row…)
 *   tag:    optional tag-name filter (e.g. only consider <h1>, <img>)
 *
 * All regexes are evaluated CASE-INSENSITIVELY.
 */
interface BBoxRule {
  name: string;
  regex: string;
  /** Optional anti-match: element text must NOT match this (catches false
   *  positives like "1.85K subscribers" matching a permissive name pattern). */
  not_regex?: string;
  /** Comma-list of CSS selectors limiting WHERE we search. Defaults to the
   *  full document. Useful for ruling out the recommended-videos sidebar etc. */
  hint?: string;
  /** If true, return no bbox when the hint matches nothing — instead of
   *  falling back to the whole document. Use for cases where falling back
   *  would pick the wrong element (e.g. about_page modal: the channel header
   *  underneath has the same text, and the visibility check can't tell them
   *  apart through the modal backdrop). */
  strict_hint?: boolean;
  /** Tag-name filter; defaults to '*'. 'img' switches the match probe from
   *  ownText() to alt+src. */
  tag?: string;
  /** Sanity bounds — reject matches outside these ranges. Catches the failure
   *  modes we saw in cross-channel testing: oversized parent containers
   *  matching as "tightest", or off-viewport elements with valid text. */
  min_w?: number;
  max_w?: number;
  min_h?: number;
  max_h?: number;
  /** If true (default), reject bboxes that fall outside the captured viewport
   *  bounds. The PNG only shows VIEWPORT.width × VIEWPORT.height pixels, so
   *  any bbox below/right of that is meaningless to the renderer. */
  in_viewport?: boolean;
}
const BBOX_RULES: Record<ScreenKind, BBoxRule[]> = {
  channel_page: [
    // Channel name in the header H1. Header sits in the top ~340px of the
    // viewport (banner + header row).
    { name: 'channel_name',     regex: '^[\\w\\s\\d\\-\\.&\'!?]{2,60}$', not_regex: '(subscribers?|videos?|views?)\\b',
      tag: 'h1',
      hint: 'ytd-c4-tabbed-header-renderer, yt-page-header-renderer, #channel-header, #header',
      min_w: 80, max_w: 600, min_h: 18, max_h: 60 },
    // Channel avatar — large round image (96-176px square) in the header.
    { name: 'channel_avatar',   regex: '.*', tag: 'img',
      hint: 'yt-decorated-avatar-view-model, #avatar, ytd-c4-tabbed-header-renderer #avatar, yt-page-header-renderer #avatar',
      min_w: 64, max_w: 220, min_h: 64, max_h: 220 },
    // Subscriber count: short pill like "24K subscribers" — typically
    // 80-200px wide, 16-26px tall, in the channel header metadata row.
    { name: 'subscriber_count', regex: '^\\s*[\\d.,]+\\s*[KMB]?\\s*subscribers?\\s*$',
      hint: 'ytd-c4-tabbed-header-renderer, yt-page-header-renderer, #meta, #channel-header-container',
      min_w: 60, max_w: 220, min_h: 14, max_h: 30 },
    { name: 'video_count',      regex: '^\\s*[\\d.,]+\\s*[KMB]?\\s*videos?\\s*$',
      hint: 'ytd-c4-tabbed-header-renderer, yt-page-header-renderer, #meta, #channel-header-container',
      min_w: 30, max_w: 200, min_h: 14, max_h: 30 },
  ],
  about_page: [
    // about_page: the channel header is visible BEHIND the about modal/dialog,
    // and its "N subscribers" text is in the DOM and "visible". To avoid the
    // extractor picking up header elements through the dimmed backdrop, we
    // scope all about-modal rules to MODAL containers only. Verified via
    // overlay inspection 2026-06-06.
    // About modal (current YT layout, late 2026): the modal opens on top of
    // the channel page; channel header subscriber/video text remains in the
    // DOM behind the modal and is "visible" per CSS. We use a broad hint
    // (whole document fallback) but rely on the size constraints + the
    // tightest-area picker to land on the actual modal text. The strict_hint
    // path didn't work because the modal's outer container in current YT
    // doesn't expose a stable selector — by the time we reach the actual
    // <yt-formatted-string> containing the text, we've descended through
    // many anonymous shadow roots that the hint can't traverse.
    { name: 'channel_name',     regex: '^[\\w\\s\\d\\-\\.&\'!?]{2,60}$', not_regex: '(subscribers?|videos?|views?|Joined|Description)\\b',
      tag: 'h1',
      min_w: 80, max_w: 600, min_h: 18, max_h: 60 },
    { name: 'subscriber_count', regex: '^\\s*[\\d.,]+\\s*[KMB]?\\s*subscribers?\\s*$',
      min_w: 60, max_w: 220, min_h: 14, max_h: 30 },
    { name: 'total_views',      regex: '^\\s*[\\d.,]+\\s*[KMB]?\\s*views?\\s*$',
      min_w: 40, max_w: 220, min_h: 14, max_h: 30 },
    { name: 'joined_date',      regex: '^\\s*Joined\\s+\\w+\\s+\\d{1,2},?\\s+\\d{4}\\s*$',
      min_w: 60, max_w: 260, min_h: 14, max_h: 30 },
  ],
  videos_tab: [
    { name: 'channel_name',     regex: '^[\\w\\s\\d\\-\\.&\'!?]{2,60}$', not_regex: '(subscribers?|videos?|views?)\\b',
      tag: 'h1',
      hint: 'ytd-c4-tabbed-header-renderer, yt-page-header-renderer, #channel-header',
      min_w: 80, max_w: 600, min_h: 18, max_h: 60 },
  ],
  // Watch page: must AVOID the right-rail recommended sidebar (every card
  // has its own "N views" text + channel names). Owner row sits below the
  // player at y≈650-820.
  watch_page: [
    { name: 'view_count',
      regex: '[\\d.,]+\\s*[KMB]?\\s*views?\\b',
      hint: '#below, ytd-watch-metadata, ytd-video-primary-info-renderer, #info, #info-container, #info-text',
      min_w: 40, max_w: 220, min_h: 14, max_h: 30 },
    { name: 'channel_name',
      regex: '^[\\w\\s\\d\\-\\.&\'!?]{2,60}$',
      not_regex: '(subscribers?|videos?|views?|Subscribe|Joined)\\b',
      hint: 'ytd-video-owner-renderer ytd-channel-name, #owner #channel-name, #upload-info ytd-channel-name',
      min_w: 30, max_w: 360, min_h: 16, max_h: 30 },
    { name: 'subscriber_count',
      regex: '^\\s*[\\d.,]+\\s*[KMB]?\\s*subscribers?\\s*$',
      hint: 'ytd-video-owner-renderer, #owner, #owner-sub-count',
      min_w: 60, max_w: 220, min_h: 14, max_h: 30 },
  ],
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
export async function captureYtScreen(channelId: string, opts: { kind?: ScreenKind; mode?: CaptureMode; geo?: string; force?: boolean; watchVideoId?: string | null; annotate?: AnnotateSpec } = {}): Promise<CaptureResult> {
  const kind = opts.kind ?? 'channel_page';
  // Annotation injects CSS BEFORE the screenshot — only meaningful for a
  // single still frame. If the caller asked for an annotation but also a
  // scroll_record video, downgrade to static so the highlight actually shows
  // up in the captured asset.
  const mode: CaptureMode = opts.annotate ? 'static' : (opts.mode ?? (kind === 'videos_tab' ? 'scroll_record' : 'static'));
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
  // Annotated captures (highlight baked into the PNG) bypass the cache so
  // we always render the fresh annotation. The base un-annotated PNG stays
  // cached separately.
  if (!opts.force && !opts.annotate) {
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

  // Retry on transient proxy/network errors. Each retry calls runCapture
  // fresh → fresh getRandomHealthyProxy() → likely different proxy from
  // the ~57-strong online pool. ~17% individual failure rate observed →
  // 3 attempts ≈ 99.5% effective success.
  const MAX_ATTEMPTS = 3;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await runCapture(rowId, channelId, handle, kind, url, opts.geo ?? null, dateBucket, mode, opts.annotate);
      return result;
    } catch (err) {
      lastErr = err as Error;
      const msg = lastErr.message ?? '';
      const transient =
        /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ECONNRESET|ETIMEDOUT|ENOTFOUND|ERR_TIMED_OUT|ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|EAI_AGAIN/i
          .test(msg);
      if (!transient || attempt === MAX_ATTEMPTS) break;
      // Backoff briefly so we don't hammer a slow proxy pool.
      await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }
  await pool.query(
    `UPDATE content_gen_yt_screens SET status='failed', error=$1, finished_at=NOW(), updated_at=NOW() WHERE id=$2`,
    [(lastErr?.message ?? 'unknown').slice(0, 600), rowId],
  ).catch(() => {});
  throw lastErr ?? new Error('capture failed');
}

async function runCapture(rowId: number, channelId: string, handle: string | null, kind: ScreenKind, url: string, geo: string | null, dateBucket: string, captureMode: CaptureMode, annotate?: AnnotateSpec): Promise<CaptureResult> {
  // Lazy-load Playwright (Next.js avoids bundling it client-side).
  const { chromium } = await import('playwright');

  const proxy = await getRandomHealthyProxy().catch(() => null);
  if (!proxy) throw new Error('no healthy xgodo proxy available');

  const geoCfg = GEO_LANG[(geo ?? '').toLowerCase()] ?? GEO_LANG[proxy.country.toLowerCase()] ?? GEO_LANG.us;

  await fs.mkdir(SCREENS_DIR, { recursive: true });
  // Annotation variant: filename embeds the highlight spec so we don't
  // clobber the un-annotated base capture in the cache directory.
  const annSlug = annotate ? `_ann-${annotate.element}-${annotate.style}` : '';
  const localPath = path.join(SCREENS_DIR, `${channelId}_${kind}_${dateBucket}${annSlug}.png`);

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
    // Recording starts the moment the context is created. We track this so
    // we can trim the loading-phase prefix from the final WebM later.
    const contextCreatedAt = Date.now();
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

    // For about_page, /about redirects to the channel page and pops a modal.
    // Wait for the modal to actually appear (contains a "Joined" text line)
    // before bbox extraction — without this race-prone wait, the modal may
    // still be fading in when we grab coordinates.
    if (kind === 'about_page') {
      await page.waitForFunction(() => {
        const dialogs = Array.from(document.querySelectorAll(
          'tp-yt-paper-dialog, ytd-engagement-panel-section-list-renderer, ytd-about-channel-renderer, [role="dialog"]'
        ));
        return dialogs.some(d => /Joined\s+\w+\s+\d/.test((d as HTMLElement).innerText || ''));
      }, undefined, { timeout: 10_000 }).catch(() => { /* try extraction anyway */ });
      await page.waitForTimeout(700);  // small post-open settle for layout
    }

    // Extract element bboxes for the renderer's annotation overlays. Done
    // BEFORE the screenshot so the layout we measure matches the captured
    // pixels exactly. Strategy: walk the rendered DOM, match each rule's
    // regex against each element's OWN text (children stripped), keep the
    // tightest visible match. Survives YT class-name churn entirely.
    const rulesForKind = BBOX_RULES[kind] ?? [];
    const extracted = await page.evaluate(([rules, vpW, vpH]) => {
      const VP_W = vpW as number; const VP_H = vpH as number;
      const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
      const ownText = (el: Element): string => {
        let s = '';
        for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) s += n.textContent ?? '';
        return s.trim();
      };
      /** Walk the full DOM tree INCLUDING shadow roots. YT's about modal
       *  renders its text inside Polymer custom elements whose actual text
       *  lives in shadow DOM (e.g. yt-attributed-string). Plain
       *  querySelectorAll('*') stops at shadow boundaries → modal text is
       *  invisible to the extractor. Collecting via this walker fixes it. */
      const collectAll = (): Element[] => {
        const all: Element[] = [];
        const stack: Array<Element | DocumentFragment | ShadowRoot> = [document.documentElement];
        while (stack.length) {
          const node = stack.pop();
          if (!node) continue;
          const children = (node as Element).children;
          if (!children) continue;
          for (const child of Array.from(children)) {
            all.push(child);
            stack.push(child);
            const sr = (child as Element).shadowRoot;
            if (sr) stack.push(sr);
          }
        }
        return all;
      };
      const ALL_ELEMENTS = collectAll();
      /** Topmost element check that ALSO walks shadow boundaries via
       *  getRootNode/host. The standard `el.contains()` returns false across
       *  shadow boundaries; this fixes the "rejected_covered: top is
       *  yt-attributed-string" case from the diagnostic. */
      const sameOrAncestor = (a: Element, b: Element | null): boolean => {
        if (!b) return false;
        let cur: Node | null = b;
        while (cur) {
          if (cur === a) return true;
          // climb out of shadow root via host
          if (cur instanceof ShadowRoot) cur = (cur as ShadowRoot).host;
          else cur = (cur as Node).parentNode;
        }
        // also check reverse: a inside b
        cur = a;
        while (cur) {
          if (cur === b) return true;
          if (cur instanceof ShadowRoot) cur = (cur as ShadowRoot).host;
          else cur = (cur as Node).parentNode;
        }
        return false;
      };
      const visible = (el: Element, r: DOMRect): boolean => {
        const cs = window.getComputedStyle(el as HTMLElement);
        if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity || '1') < 0.1) return false;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return true; // can't test offscreen
        const top = document.elementFromPoint(cx, cy);
        if (!top || top === el) return true;
        if (sameOrAncestor(el, top)) return true;
        // Also accept if top sits inside el via shadow boundaries (host chain).
        // Reject only if there's a separate stacking context above.
        return false;
      };
      const scopes = (hint: string | undefined, strict: boolean): Element[] | null => {
        if (!hint) return [document.documentElement];
        const found: Element[] = [];
        for (const sel of hint.split(',').map(s => s.trim()).filter(Boolean)) {
          try { found.push(...Array.from(document.querySelectorAll(sel))); } catch { /* invalid sel — skip */ }
        }
        if (found.length > 0) return found;
        return strict ? null : [document.documentElement];
      };
      const ruleList = rules as Array<{ name: string; regex: string; not_regex?: string; hint?: string; strict_hint?: boolean; tag?: string;
        min_w?: number; max_w?: number; min_h?: number; max_h?: number; in_viewport?: boolean }>;
      const debugOut: Record<string, { regex_matches: number; rejected_size: number; rejected_offview: number; rejected_covered: number; accepted: number; sample_texts: string[]; sample_covered: Array<{ text: string; top_tag: string }>; sample_sizes: Array<{ text: string; w: number; h: number; reason: string }> }> = {};
      for (const rule of ruleList) {
        const re = new RegExp(rule.regex, 'i');
        const notRe = rule.not_regex ? new RegExp(rule.not_regex, 'i') : null;
        const tagSel = rule.tag ? rule.tag.toLowerCase() : '*';
        const inViewport = rule.in_viewport !== false;
        const minW = rule.min_w ?? 2, maxW = rule.max_w ?? Infinity;
        const minH = rule.min_h ?? 2, maxH = rule.max_h ?? Infinity;
        let bestEl: Element | null = null;
        let bestArea = Infinity;
        let regex_matches = 0, rejected_size = 0, rejected_offview = 0, rejected_covered = 0, accepted = 0;
        const sample_texts: string[] = [];
        const sample_covered: Array<{ text: string; top_tag: string }> = [];
        const sample_sizes: Array<{ text: string; w: number; h: number; reason: string }> = [];
        const scopeList = scopes(rule.hint, rule.strict_hint === true);
        if (!scopeList) {
          debugOut[rule.name] = { regex_matches: 0, rejected_size: 0, rejected_offview: 0, rejected_covered: 0, accepted: 0, sample_texts: [], sample_covered: [], sample_sizes: [] };
          continue;
        }
        // When hint is set, filter ALL_ELEMENTS to those inside a scope.
        // When no hint, use ALL_ELEMENTS directly.
        const inScope = rule.hint
          ? ALL_ELEMENTS.filter(el => scopeList.some(s => s === el || s.contains(el) || sameOrAncestor(s, el)))
          : ALL_ELEMENTS;
        // Tag filter
        const candidates = tagSel === '*' ? inScope : inScope.filter(el => el.tagName.toLowerCase() === tagSel);
        for (const el of candidates) {
          const probe = tagSel === 'img' ? ((el as HTMLImageElement).alt || (el as HTMLImageElement).src || '') : ownText(el);
          if (!re.test(probe)) continue;
          if (notRe && notRe.test(probe)) continue;
          regex_matches++;
          if (sample_texts.length < 5) sample_texts.push(probe.slice(0, 60));
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width < minW || r.width > maxW || r.height < minH || r.height > maxH) {
            rejected_size++;
            if (sample_sizes.length < 4) sample_sizes.push({ text: probe.slice(0, 50), w: Math.round(r.width), h: Math.round(r.height), reason: `size:${r.width < minW ? 'w<' : r.width > maxW ? 'w>' : r.height < minH ? 'h<' : 'h>'}` });
            continue;
          }
          if (inViewport && (r.left < -4 || r.top < -4 || r.right > VP_W + 4 || r.bottom > VP_H + 4)) { rejected_offview++; continue; }
          if (!visible(el, r)) {
            rejected_covered++;
            if (sample_covered.length < 3) {
              const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
              const top = document.elementFromPoint(cx, cy);
              sample_covered.push({ text: probe.slice(0, 50), top_tag: (top?.tagName || '?').toLowerCase() + ((top as HTMLElement | null)?.className ? '.' + (top as HTMLElement).className.toString().split(/\s+/)[0] : '') });
            }
            continue;
          }
          accepted++;
          const area = r.width * r.height;
          if (area < bestArea) { bestArea = area; bestEl = el; }
        }
        debugOut[rule.name] = { regex_matches, rejected_size, rejected_offview, rejected_covered, accepted, sample_texts, sample_covered, sample_sizes };
        if (bestEl) {
          const r = (bestEl as HTMLElement).getBoundingClientRect();
          out[rule.name] = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        }
      }
      return { bboxes: out, debug: debugOut };
    }, [rulesForKind, VIEWPORT.width, VIEWPORT.height]).catch(() => ({ bboxes: {} as BBoxMap, debug: {} as Record<string, unknown> }));
    const bboxes: BBoxMap = (extracted as { bboxes: BBoxMap }).bboxes ?? {};
    const bboxDebug = (extracted as { debug: Record<string, Record<string, unknown>> }).debug ?? {};

    // ── Playwright locator-based fallback ─────────────────────────────
    // For rules where the in-page evaluator returned NO bbox, retry with
    // page.locator('text=/regex/'). The Playwright locator engine pierces
    // BOTH open AND closed shadow DOM (which closed-root yt-attributed-
    // string elements live behind) — page.evaluate can't. About modal text
    // is frequently in closed shadow roots in current YT, so the JS walker
    // misses it and the locator path catches it.
    for (const rule of rulesForKind) {
      if (bboxes[rule.name]) continue;        // already found by JS walker
      if (rule.tag === 'img') continue;       // locator text= doesn't fit
      try {
        // Strip ^ and $ anchors and trim whitespace — Playwright's text=
        // matches against innerText with surrounding whitespace, so anchors
        // confuse it. The regex still filters out non-matching elements.
        const reBody = rule.regex.replace(/^\^\\s\*/, '').replace(/\\s\*\$$/, '');
        const loc = page.locator(`text=/${reBody}/i`);
        const count = await loc.count();
        const minW = rule.min_w ?? 2, maxW = rule.max_w ?? Infinity;
        const minH = rule.min_h ?? 2, maxH = rule.max_h ?? Infinity;
        let bestBox: { x: number; y: number; w: number; h: number } | null = null;
        let bestArea = Infinity;
        const dbgList: Array<{ w: number; h: number; visible: boolean }> = [];
        for (let i = 0; i < Math.min(count, 30); i++) {
          const item = loc.nth(i);
          let box: { x: number; y: number; width: number; height: number } | null = null;
          try { box = await item.boundingBox({ timeout: 1000 }); } catch { box = null; }
          if (!box) continue;
          const vis = await item.isVisible({ timeout: 500 }).catch(() => false);
          dbgList.push({ w: Math.round(box.width), h: Math.round(box.height), visible: vis });
          if (!vis) continue;
          if (box.width < minW || box.width > maxW || box.height < minH || box.height > maxH) continue;
          if (box.x < -4 || box.y < -4 || box.x + box.width > VIEWPORT.width + 4 || box.y + box.height > VIEWPORT.height + 4) continue;
          const area = box.width * box.height;
          if (area < bestArea) {
            bestArea = area;
            bestBox = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
          }
        }
        if (bestBox) {
          bboxes[rule.name] = bestBox;
          if (bboxDebug[rule.name]) {
            (bboxDebug[rule.name] as Record<string, unknown>).via_locator = true;
            (bboxDebug[rule.name] as Record<string, unknown>).locator_candidates = count;
          }
        } else if (bboxDebug[rule.name]) {
          (bboxDebug[rule.name] as Record<string, unknown>).locator_candidates = count;
          (bboxDebug[rule.name] as Record<string, unknown>).locator_sizes = dbgList.slice(0, 5);
        }
      } catch { /* locator path failed — skip */ }
    }

    // ── Per-video-card bbox extraction (videos_tab + channel_page) ─────
    // The visual grammar's `thumbnail_card`, `thumbnail_card_rapid_fire` and
    // `most_popular_callout_card` compositions need to crop INDIVIDUAL video
    // cards from a videos_tab screenshot. Extract per-card bboxes here so
    // the renderer can crop without re-running Playwright.
    //
    // Encoded as flat keys in BBoxMap so the storage layer stays uniform:
    //   video_card_0, video_card_1, ...    — outer card rect (thumb + title + meta)
    //   video_thumb_0, video_thumb_1, ...  — just the thumbnail image rect
    //   video_views_0, video_views_1, ...  — view-count text rect (when present)
    //   video_title_0, video_title_1, ...  — title text rect
    //
    // The renderer reads these to build per-card crops + per-card annotations.
    if (kind === 'videos_tab' || kind === 'channel_page') {
      try {
        const cards = await page.evaluate((vpW: number) => {
          // The video card renderers used by YT. Order matters: prefer the
          // more specific renderer first (rich-item in modern grid layout).
          const sel = 'ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-rich-grid-media, ytd-video-renderer';
          const els = Array.from(document.querySelectorAll(sel));
          const out: Array<{ card: { x: number; y: number; w: number; h: number }; thumb?: { x: number; y: number; w: number; h: number }; views?: { x: number; y: number; w: number; h: number }; title?: { x: number; y: number; w: number; h: number } }> = [];
          for (const el of els) {
            const r = (el as HTMLElement).getBoundingClientRect();
            // Skip off-viewport-right and very-small (collapsed/loading) cards.
            // Cards below the viewport are useful for scroll_record renders so
            // we keep them — the renderer can decide per-frame what to crop.
            if (r.width < 160 || r.height < 120) continue;
            if (r.left + r.width < 0 || r.left > vpW + 8) continue;
            const card = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
            // Find the thumbnail <img> inside the card.
            let thumb: { x: number; y: number; w: number; h: number } | undefined;
            const img = el.querySelector('img[src*="ytimg"], img[src*="googleusercontent"], #thumbnail img, ytd-thumbnail img') as HTMLImageElement | null;
            if (img) {
              const ir = img.getBoundingClientRect();
              if (ir.width > 100) thumb = { x: Math.round(ir.left), y: Math.round(ir.top), w: Math.round(ir.width), h: Math.round(ir.height) };
            }
            // Find view count: span/yt-formatted-string whose own text matches.
            let views: { x: number; y: number; w: number; h: number } | undefined;
            const viewRe = /^\s*[\d.,]+\s*[KMB]?\s*views?\s*$/i;
            const all = Array.from(el.querySelectorAll('span, yt-formatted-string'));
            for (const sub of all) {
              const own = Array.from(sub.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent ?? '').join('').trim();
              if (!viewRe.test(own)) continue;
              const sr = (sub as HTMLElement).getBoundingClientRect();
              if (sr.width < 20 || sr.width > 240) continue;
              views = { x: Math.round(sr.left), y: Math.round(sr.top), w: Math.round(sr.width), h: Math.round(sr.height) };
              break;
            }
            // Find title: prefer #video-title, then h3 a (modern), then h3.
            let title: { x: number; y: number; w: number; h: number } | undefined;
            const titleEl = (el.querySelector('#video-title, a#video-title, h3 a, h3') as HTMLElement | null);
            if (titleEl) {
              const tr = titleEl.getBoundingClientRect();
              if (tr.width > 60 && tr.height > 12) title = { x: Math.round(tr.left), y: Math.round(tr.top), w: Math.round(tr.width), h: Math.round(tr.height) };
            }
            out.push({ card, thumb, views, title });
            if (out.length >= 24) break;  // sane cap; 4-col grid x 6 rows is plenty
          }
          return out;
        }, VIEWPORT.width);
        cards.forEach((c, i) => {
          bboxes[`video_card_${i}`] = c.card;
          if (c.thumb) bboxes[`video_thumb_${i}`] = c.thumb;
          if (c.views) bboxes[`video_views_${i}`] = c.views;
          if (c.title) bboxes[`video_title_${i}`] = c.title;
        });
        (bboxDebug as Record<string, unknown>).video_cards_count = cards.length;
      } catch { /* card extraction is best-effort — main bboxes already set */ }
    }

    // Branch: static screenshot OR scroll-record video.
    let buf: Buffer;
    let assetKind: AssetKind = 'image';
    let videoLocalPath = localPath;
    let durationS: number | null = null;
    let videoSrcPath: string | null = null;
    // Diagnostic for the annotation pass (if any) — surfaces back in the result.
    let annotationDebug: Record<string, unknown> | null = null;

    if (captureMode === 'scroll_record' && recorderVideoPathPromise) {
      assetKind = 'video';

      // 1) WAIT FOR CONTENT — networkidle isn't enough; YT lazy-loads
      //    thumbnail <img> tags after the grid scaffolding renders. Wait for
      //    actual non-empty <img> sources to confirm the video grid is real.
      await page.waitForFunction(() => {
        const imgs = Array.from(document.querySelectorAll(
          'ytd-rich-item-renderer img, ytd-grid-video-renderer img, ytd-rich-grid-renderer img'
        )) as HTMLImageElement[];
        const loaded = imgs.filter(i => i.src && i.naturalWidth > 50);
        return loaded.length >= 4;
      }, undefined, { timeout: 15_000 }).catch(() => { /* fall through — at least some grid is there */ });
      await page.waitForTimeout(1_500);  // extra settle for layout + lazy-loads

      // Mark scroll start RELATIVE to the recording start (which was when
      // the context was created, i.e. ~contextCreatedAt). We trim the WebM
      // to start at this offset so the final video skips the loading phase.
      const scrollStartRelMs = Math.max(0, Date.now() - contextCreatedAt - 300); // 300ms lead-in

      // 2) SMOOTH SCROLL via rAF + ease-in-out. 1800px over 6.5s ≈ 277px/s —
      //    MG-pace, gentle reveal. Hold briefly at the bottom.
      const SCROLL_DURATION_MS = 6_500;
      const HOLD_AT_BOTTOM_MS = 700;
      const SCROLL_DISTANCE_PX = 1_800;
      await page.evaluate((opts) => {
        return new Promise<void>(resolve => {
          const startY = window.scrollY;
          const maxScrollable = Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
          ) - window.innerHeight - startY;
          const distance = Math.max(0, Math.min(opts.distancePx, maxScrollable));
          if (distance < 100) { setTimeout(resolve, opts.holdMs); return; }
          const start = performance.now();
          function step(now: number) {
            const t = Math.min(1, (now - start) / opts.durationMs);
            // ease-in-out cubic
            const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
            window.scrollTo(0, startY + distance * eased);
            if (t < 1) requestAnimationFrame(step);
            else setTimeout(resolve, opts.holdMs);
          }
          requestAnimationFrame(step);
        });
      }, { distancePx: SCROLL_DISTANCE_PX, durationMs: SCROLL_DURATION_MS, holdMs: HOLD_AT_BOTTOM_MS });

      // Poster PNG: final frame for GUI thumbnails / fallback rendering.
      const stillBuf = await page.screenshot({ fullPage: false, type: 'png', timeout: SCREENSHOT_TIMEOUT_MS });
      await fs.writeFile(localPath.replace(/\.png$/, '_poster.png'), stillBuf);

      // Close context to flush the recording.
      await context.close();
      videoSrcPath = await recorderVideoPathPromise;
      videoLocalPath = localPath.replace(/\.png$/, '.webm');

      // 3) TRIM the loading-phase prefix. VP8 has sparse keyframes so
      //    -c copy seek is unreliable; re-encode the few seconds we want.
      //    libvpx 1.5Mbps + cpu-used 5 = fast preset, looks fine for screen
      //    content. Falls back to the untrimmed file if ffmpeg fails.
      const trimStartSec = Math.max(0, scrollStartRelMs / 1000);
      try {
        await runFfmpeg([
          '-y', '-ss', trimStartSec.toFixed(2), '-i', videoSrcPath,
          '-c:v', 'libvpx', '-b:v', '1500k', '-cpu-used', '5',
          '-an', videoLocalPath,
        ]);
        await fs.unlink(videoSrcPath).catch(() => {});
      } catch {
        // Trim failed → keep the raw recording.
        try { await fs.rename(videoSrcPath, videoLocalPath); } catch { await fs.copyFile(videoSrcPath, videoLocalPath); }
      }

      buf = await fs.readFile(videoLocalPath);
      durationS = Math.round(((SCROLL_DURATION_MS + HOLD_AT_BOTTOM_MS + 300) / 1000) * 10) / 10;
    } else {
      // OPTIONAL: inject the highlight DOM-side BEFORE screenshot. The
      // Playwright locator engine pierces both open AND closed shadow DOM
      // (which the previous in-page DOM walker couldn't reach for closed-
      // root yt-attributed-string elements). We find the candidate by
      // regex match against innerText, pick the tightest-area visible
      // candidate that fits the expected size bounds, apply inline CSS
      // for the highlight style, and small settle. The highlight is then
      // baked into the captured PNG — no compositing needed downstream.
      if (annotate) {
        try {
          const reSource = ANNOTATE_REGEX[annotate.element];
          const bounds = ANNOTATE_SIZE[annotate.element];
          const css = HIGHLIGHT_CSS[annotate.style];
          const scopeTags = ANNOTATE_SCOPE[annotate.element] ?? [];
          // Run the search entirely inside the page: walk light DOM AND shadow
          // roots, regex-match each element's own text, filter by size + in-
          // viewport + ancestor-scope, then inject the highlight CSS on the
          // chosen element. Closed-shadow Polymer roots (yt-attributed-string)
          // are reachable by walking via shadowRoot — Playwright's text=
          // locator does NOT reach them and was picking sidebar text instead.
          annotationDebug = await page.evaluate((args) => {
            const { reSource, bounds, css, vpW, vpH, scopeTags } = args;
            const re = new RegExp(reSource, 'i');
            // Walker — collect every element in document AND any open/closed
            // shadow roots reachable from there.
            const all: Element[] = [];
            const stack: Array<Element | ShadowRoot | Document> = [document];
            while (stack.length) {
              const node = stack.pop()!;
              const kids = (node as Element).children || (node as Document).children;
              if (!kids) continue;
              for (const child of Array.from(kids)) {
                all.push(child);
                stack.push(child);
                const sr = (child as Element).shadowRoot;
                if (sr) stack.push(sr);
              }
            }
            const ownText = (el: Element): string => {
              let s = ''; for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) s += n.textContent ?? '';
              return s.trim();
            };
            // Walk parentElement AND shadow-root host chain — so descendants
            // of a Polymer custom element correctly see the custom element as
            // an ancestor.
            const hasAncestor = (el: Element, tags: string[]): boolean => {
              if (tags.length === 0) return true;  // no scope = pass
              const lower = tags.map(t => t.toLowerCase());
              let cur: Element | null = el;
              let hops = 0;
              while (cur && hops++ < 80) {
                if (lower.includes(cur.tagName.toLowerCase())) return true;
                const parent: Element | null = cur.parentElement;
                if (parent) { cur = parent; continue; }
                // crossed a shadow boundary?
                const root = cur.getRootNode();
                if (root instanceof ShadowRoot) { cur = root.host as Element; continue; }
                break;
              }
              return false;
            };
            // Walk the ancestor chain (parent + shadow host) collecting tag
            // names. Used both for scope check AND for diagnostic output so we
            // know what tags the matched element sits under — invaluable when
            // YT renames a container and the scope list needs updating.
            const ancestorTags = (el: Element, maxHops = 30): string[] => {
              const out: string[] = [];
              let cur: Element | null = el;
              let hops = 0;
              while (cur && hops++ < maxHops) {
                out.push(cur.tagName.toLowerCase());
                const p: Element | null = cur.parentElement;
                if (p) { cur = p; continue; }
                const root = cur.getRootNode();
                if (root instanceof ShadowRoot) { cur = root.host as Element; continue; }
                break;
              }
              return out;
            };
            const candidatesDbg: Array<Record<string, unknown>> = [];
            let bestEl: Element | null = null;
            let bestArea = Infinity;
            // Fallback: track innerText matches in case ownText fails (text
            // split across multiple children: <span>527,506</span> <span>views</span>).
            // We only use the innerText fallback if NO ownText match landed.
            let fallbackEl: Element | null = null;
            let fallbackArea = Infinity;
            // Track all elements with matching text — even if scope rejects
            // them — so the diagnostic can show what the regex found in scope
            // vs. out of scope.
            let inScope = 0, outOfScope = 0;
            // First pass: ownText matches (the precise leaf-level signal).
            for (const el of all) {
              const txt = ownText(el);
              if (!re.test(txt)) continue;
              const r = (el as HTMLElement).getBoundingClientRect();
              const w = Math.round(r.width), h = Math.round(r.height);
              const cs = window.getComputedStyle(el as HTMLElement);
              const hidden = cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity || '1') < 0.1;
              const inScopeNow = hasAncestor(el, scopeTags);
              const sizeOK = w >= bounds.minW && w <= bounds.maxW && h >= bounds.minH && h <= bounds.maxH;
              const viewOK = r.left >= -4 && r.top >= -4 && r.right <= vpW + 4 && r.bottom <= vpH + 4;
              const reason = hidden ? 'hidden' : !inScopeNow ? 'out-of-scope' : !sizeOK ? 'size' : !viewOK ? 'off-view' : 'OK';
              if (inScopeNow) inScope++; else outOfScope++;
              if (candidatesDbg.length < 20) {
                const row: Record<string, unknown> = { x: Math.round(r.left), y: Math.round(r.top), w, h, tag: el.tagName.toLowerCase(), text: txt.slice(0, 60), reason, via: 'ownText' };
                if (reason === 'out-of-scope') row.ancestors = ancestorTags(el, 12);
                candidatesDbg.push(row);
              }
              if (reason !== 'OK') continue;
              const area = r.width * r.height;
              if (area < bestArea) { bestArea = area; bestEl = el; }
            }
            // Second pass — innerText fallback. Only collect; we don't apply
            // unless first pass produced no candidate. We still want the
            // diagnostic to surface these so we know which wrapper was the
            // closest miss. Skip very deep textContent ('the page' wrappers)
            // by enforcing a smaller bounds.
            if (!bestEl) {
              for (const el of all) {
                // skip if ownText already matched (would have been picked
                // above)
                if (re.test(ownText(el))) continue;
                const itext = ((el as HTMLElement).innerText || '').trim();
                if (!re.test(itext)) continue;
                const r = (el as HTMLElement).getBoundingClientRect();
                const w = Math.round(r.width), h = Math.round(r.height);
                const cs = window.getComputedStyle(el as HTMLElement);
                const hidden = cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity || '1') < 0.1;
                const inScopeNow = hasAncestor(el, scopeTags);
                const sizeOK = w >= bounds.minW && w <= bounds.maxW && h >= bounds.minH && h <= bounds.maxH;
                const viewOK = r.left >= -4 && r.top >= -4 && r.right <= vpW + 4 && r.bottom <= vpH + 4;
                const reason = hidden ? 'hidden' : !inScopeNow ? 'out-of-scope' : !sizeOK ? 'size' : !viewOK ? 'off-view' : 'OK';
                if (candidatesDbg.length < 24) {
                  const row: Record<string, unknown> = { x: Math.round(r.left), y: Math.round(r.top), w, h, tag: el.tagName.toLowerCase(), text: itext.slice(0, 60), reason, via: 'innerText' };
                  if (reason === 'out-of-scope') row.ancestors = ancestorTags(el, 12);
                  candidatesDbg.push(row);
                }
                if (reason !== 'OK') continue;
                const area = r.width * r.height;
                if (area < fallbackArea) { fallbackArea = area; fallbackEl = el; }
              }
              if (fallbackEl) { bestEl = fallbackEl; bestArea = fallbackArea; }
            }
            if (bestEl) {
              try { (bestEl as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* */ }
              const el = bestEl as HTMLElement;
              const existing = el.getAttribute('style') || '';
              el.setAttribute('style', `${existing}; ${css}`);
              const r = el.getBoundingClientRect();
              return { applied: true, in_scope: inScope, out_of_scope: outOfScope, picked: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), tag: el.tagName.toLowerCase(), text: ownText(el).slice(0, 80) }, candidates: candidatesDbg };
            }
            return { applied: false, in_scope: inScope, out_of_scope: outOfScope, picked: null, candidates: candidatesDbg };
          }, { reSource, bounds, css, vpW: VIEWPORT.width, vpH: VIEWPORT.height, scopeTags }) as Record<string, unknown>;
          await page.waitForTimeout(300);
        } catch (e) {
          annotationDebug = { error: (e as Error).message.slice(0, 200) };
        }
      }
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
      bbox_debug: bboxDebug as Record<string, unknown>,
      annotation_debug: annotationDebug ?? undefined,
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
export async function captureBatch(channelIds: string[], opts: { kind?: ScreenKind; mode?: CaptureMode; geo?: string; force?: boolean; concurrency?: number; watchVideoId?: string | null; annotate?: AnnotateSpec } = {}): Promise<{ ok: number; failed: number; results: Array<CaptureResult | { channel_id: string; error: string }> }> {
  const conc = Math.max(1, Math.min(4, opts.concurrency ?? 2));
  const results: Array<CaptureResult | { channel_id: string; error: string }> = new Array(channelIds.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= channelIds.length) return;
      try { results[i] = await captureYtScreen(channelIds[i], { kind: opts.kind, mode: opts.mode, geo: opts.geo, force: opts.force, watchVideoId: opts.watchVideoId, annotate: opts.annotate }); }
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
