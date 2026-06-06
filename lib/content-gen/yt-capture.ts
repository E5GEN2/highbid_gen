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
    { name: 'channel_name',     regex: '^[\\w\\s\\d\\-\\.&\'!?]{2,60}$', not_regex: '(subscribers?|videos?|views?|Joined)\\b',
      tag: 'h1', strict_hint: true,
      hint: 'tp-yt-paper-dialog, ytd-engagement-panel-section-list-renderer, ytd-about-channel-renderer, [role="dialog"]',
      min_w: 80, max_w: 600, min_h: 18, max_h: 60 },
    { name: 'subscriber_count', regex: '^\\s*[\\d.,]+\\s*[KMB]?\\s*subscribers?\\s*$',
      strict_hint: true,
      hint: 'tp-yt-paper-dialog, ytd-engagement-panel-section-list-renderer, ytd-about-channel-renderer, [role="dialog"], .about-stats',
      min_w: 60, max_w: 220, min_h: 14, max_h: 30 },
    // Total views in the About modal — typically a row with "N views" only.
    // YT shows either raw digits ("7,914,159 views") or compressed
    // ("7.9M views"); regex accepts both. Modal-only scope as above.
    { name: 'total_views',      regex: '^\\s*[\\d.,]+\\s*[KMB]?\\s*views?\\s*$',
      strict_hint: true,
      hint: 'tp-yt-paper-dialog, ytd-engagement-panel-section-list-renderer, ytd-about-channel-renderer, [role="dialog"], .about-stats',
      min_w: 40, max_w: 220, min_h: 14, max_h: 30 },
    { name: 'joined_date',      regex: '^\\s*Joined\\s+\\w+\\s+\\d{1,2},?\\s+\\d{4}\\s*$',
      strict_hint: true,
      hint: 'tp-yt-paper-dialog, ytd-engagement-panel-section-list-renderer, ytd-about-channel-renderer, [role="dialog"], .about-stats',
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

  // Retry on transient proxy/network errors. Each retry calls runCapture
  // fresh → fresh getRandomHealthyProxy() → likely different proxy from
  // the ~57-strong online pool. ~17% individual failure rate observed →
  // 3 attempts ≈ 99.5% effective success.
  const MAX_ATTEMPTS = 3;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await runCapture(rowId, channelId, handle, kind, url, opts.geo ?? null, dateBucket, mode);
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
    const bboxes: BBoxMap = await page.evaluate(([rules, vpW, vpH]) => {
      const VP_W = vpW as number; const VP_H = vpH as number;
      const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
      const ownText = (el: Element): string => {
        let s = '';
        for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) s += n.textContent ?? '';
        return s.trim();
      };
      const visible = (el: Element): boolean => {
        const cs = window.getComputedStyle(el as HTMLElement);
        if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity || '1') < 0.1) return false;
        return true;
      };
      const scopes = (hint: string | undefined, strict: boolean): Element[] | null => {
        if (!hint) return [document.documentElement];
        const found: Element[] = [];
        for (const sel of hint.split(',').map(s => s.trim()).filter(Boolean)) {
          try { found.push(...Array.from(document.querySelectorAll(sel))); } catch { /* invalid sel — skip */ }
        }
        if (found.length > 0) return found;
        // No hint match: strict_hint → return null (caller skips rule entirely);
        // non-strict → fall back to whole document.
        return strict ? null : [document.documentElement];
      };
      const ruleList = rules as Array<{ name: string; regex: string; not_regex?: string; hint?: string; strict_hint?: boolean; tag?: string;
        min_w?: number; max_w?: number; min_h?: number; max_h?: number; in_viewport?: boolean }>;
      for (const rule of ruleList) {
        const re = new RegExp(rule.regex, 'i');
        const notRe = rule.not_regex ? new RegExp(rule.not_regex, 'i') : null;
        const tagSel = rule.tag ? rule.tag.toLowerCase() : '*';
        const inViewport = rule.in_viewport !== false;
        const minW = rule.min_w ?? 2;
        const maxW = rule.max_w ?? Infinity;
        const minH = rule.min_h ?? 2;
        const maxH = rule.max_h ?? Infinity;
        let bestEl: Element | null = null;
        let bestArea = Infinity;
        const scopeList = scopes(rule.hint, rule.strict_hint === true);
        if (!scopeList) continue;   // strict_hint with no matches → skip rule
        for (const scope of scopeList) {
          let nodes: Element[];
          try { nodes = Array.from(scope.querySelectorAll(tagSel)); } catch { continue; }
          for (const el of nodes) {
            if (!visible(el)) continue;
            const r = (el as HTMLElement).getBoundingClientRect();
            // Size constraints — catches oversized parent containers.
            if (r.width < minW || r.width > maxW) continue;
            if (r.height < minH || r.height > maxH) continue;
            // Viewport check — bbox must be inside the captured PNG bounds.
            // Tolerate a small overhang (4px) so antialiased borders don't fail.
            if (inViewport) {
              if (r.left < -4 || r.top < -4) continue;
              if (r.right > VP_W + 4 || r.bottom > VP_H + 4) continue;
            }
            // For images the textContent is empty — match by attribute.
            const probe = tagSel === 'img' ? ((el as HTMLImageElement).alt || (el as HTMLImageElement).src || '') : ownText(el);
            if (!re.test(probe)) continue;
            if (notRe && notRe.test(probe)) continue;
            const area = r.width * r.height;
            if (area < bestArea) { bestArea = area; bestEl = el; }
          }
        }
        if (bestEl) {
          const r = (bestEl as HTMLElement).getBoundingClientRect();
          out[rule.name] = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        }
      }
      return out;
    }, [rulesForKind, VIEWPORT.width, VIEWPORT.height]).catch(() => ({} as BBoxMap));

    // Branch: static screenshot OR scroll-record video.
    let buf: Buffer;
    let assetKind: AssetKind = 'image';
    let videoLocalPath = localPath;
    let durationS: number | null = null;
    let videoSrcPath: string | null = null;

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
