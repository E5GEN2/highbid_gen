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
}

function todayBucket(): string {
  return new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
}

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
export async function captureYtScreen(channelId: string, opts: { kind?: ScreenKind; geo?: string; force?: boolean; watchVideoId?: string | null } = {}): Promise<CaptureResult> {
  const kind = opts.kind ?? 'channel_page';
  const pool = await getPool();

  // Look up handle (saves a YT redirect roundtrip and gives clean URL).
  const ch = (await pool.query<{ channel_handle: string | null }>(
    `SELECT channel_handle FROM niche_spy_channels WHERE channel_id = $1`, [channelId],
  )).rows[0];
  const handle = ch?.channel_handle ?? null;
  const dateBucket = todayBucket();
  const url = urlFor(kind, handle, channelId, opts.watchVideoId);

  // Cache check.
  if (!opts.force) {
    const hit = (await pool.query<{ id: number; local_path: string | null; bytes: number | null; geo: string | null; proxy_country: string | null }>(
      `SELECT id, local_path, bytes, geo, proxy_country FROM content_gen_yt_screens
        WHERE channel_id = $1 AND kind = $2 AND date_bucket = $3 AND status = 'done'`,
      [channelId, kind, dateBucket],
    )).rows[0];
    if (hit && hit.local_path) {
      try {
        const st = await fs.stat(hit.local_path);
        if (st.size > 0) {
          return { id: hit.id, channel_id: channelId, handle, kind, url, local_path: hit.local_path, bytes: hit.bytes ?? st.size, date_bucket: dateBucket, geo: hit.geo, proxy_country: hit.proxy_country, cached: true };
        }
      } catch { /* file gone — recapture */ }
    }
  }

  // Reserve a row so concurrent calls don't double-capture.
  const ins = await pool.query<{ id: number }>(
    `INSERT INTO content_gen_yt_screens (channel_id, handle, kind, url, geo, date_bucket, status, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,'capturing',NOW())
     ON CONFLICT (channel_id, kind, date_bucket) DO UPDATE SET status='capturing', started_at=NOW(), error=NULL, updated_at=NOW()
     RETURNING id`,
    [channelId, handle, kind, url, opts.geo ?? null, dateBucket],
  );
  const rowId = ins.rows[0].id;

  try {
    const result = await runCapture(rowId, channelId, handle, kind, url, opts.geo ?? null, dateBucket);
    return result;
  } catch (err) {
    await pool.query(
      `UPDATE content_gen_yt_screens SET status='failed', error=$1, finished_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [(err as Error).message.slice(0, 600), rowId],
    ).catch(() => {});
    throw err;
  }
}

async function runCapture(rowId: number, channelId: string, handle: string | null, kind: ScreenKind, url: string, geo: string | null, dateBucket: string): Promise<CaptureResult> {
  // Lazy-load Playwright (Next.js avoids bundling it client-side).
  const { chromium } = await import('playwright');
  const proxyChain = await import('proxy-chain');

  const proxy = await getRandomHealthyProxy().catch(() => null);
  if (!proxy) throw new Error('no healthy xgodo proxy available');

  const geoCfg = GEO_LANG[(geo ?? '').toLowerCase()] ?? GEO_LANG[proxy.country.toLowerCase()] ?? GEO_LANG.us;

  await fs.mkdir(SCREENS_DIR, { recursive: true });
  const localPath = path.join(SCREENS_DIR, `${channelId}_${kind}_${dateBucket}.png`);

  // Our xgodo proxies are dual-protocol (HTTP forward + SOCKS5 on the same
  // host:port with the same Basic-auth creds). Chromium has a long-standing
  // Linux bug where Proxy-Authorization isn't sent on CONNECT, so the
  // upstream proxy RSTs every request. The documented workaround is to wrap
  // the authenticated upstream proxy with a LOCAL anonymous proxy
  // (proxy-chain) — Chromium connects to localhost without auth, proxy-chain
  // forwards everything to xgodo with the Basic-auth header injected.
  // Speak HTTP to the gateway since Chromium can't do SOCKS5+auth anyway.
  const upstreamUrl = (() => {
    const u = new URL(proxy.url);
    const user = encodeURIComponent(decodeURIComponent(u.username));
    const pass = encodeURIComponent(decodeURIComponent(u.password));
    return `http://${user}:${pass}@${u.host}`;
  })();
  const localProxyUrl = await proxyChain.anonymizeProxy(upstreamUrl);

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
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      locale: geoCfg.lang.split(',')[0],
      timezoneId: 'UTC',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Accept-Language': geoCfg.lang },
    });
    const page = await context.newPage();
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
    // (background polls), so we use a bounded race.
    await Promise.race([
      page.waitForLoadState('networkidle', { timeout: NETIDLE_MS }),
      page.waitForTimeout(NETIDLE_MS),
    ]);
    // A second small settle in case the consent click reflowed.
    await page.waitForTimeout(800);

    const buf = await page.screenshot({ fullPage: false, type: 'png', timeout: SCREENSHOT_TIMEOUT_MS });
    await fs.writeFile(localPath, buf);

    const pool = await getPool();
    await pool.query(
      `UPDATE content_gen_yt_screens SET status='done', local_path=$1, page_width=$2, page_height=$3,
         bytes=$4, proxy_country=$5, proxy_device=$6, error=NULL, finished_at=NOW(), updated_at=NOW()
        WHERE id=$7`,
      [localPath, VIEWPORT.width, VIEWPORT.height, buf.length, proxy.country, proxy.deviceId, rowId],
    );

    return { id: rowId, channel_id: channelId, handle, kind, url, local_path: localPath, bytes: buf.length, date_bucket: dateBucket, geo, proxy_country: proxy.country, cached: false };
  } finally {
    await browser.close().catch(() => {});
    // Free the proxy-chain port — leaving them open eventually exhausts the
    // ephemeral port range under load.
    await proxyChain.closeAnonymizedProxy(localProxyUrl, true).catch(() => {});
  }
}

/** Read a captured screen off the volume (for the serve endpoint). */
export async function readYtScreenFile(id: number): Promise<{ buf: Buffer; contentType: string } | null> {
  const pool = await getPool();
  const r = await pool.query<{ local_path: string | null }>(
    `SELECT local_path FROM content_gen_yt_screens WHERE id = $1`, [id],
  );
  const p = r.rows[0]?.local_path;
  if (!p) return null;
  try {
    const buf = await fs.readFile(p);
    return { buf, contentType: 'image/png' };
  } catch { return null; }
}

/** Capture a batch of channels' channel_page screens with bounded concurrency.
 *  Each capture costs ~5-10s on the proxy path. */
export async function captureBatch(channelIds: string[], opts: { kind?: ScreenKind; geo?: string; force?: boolean; concurrency?: number } = {}): Promise<{ ok: number; failed: number; results: Array<CaptureResult | { channel_id: string; error: string }> }> {
  const conc = Math.max(1, Math.min(4, opts.concurrency ?? 2));
  const results: Array<CaptureResult | { channel_id: string; error: string }> = new Array(channelIds.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= channelIds.length) return;
      try { results[i] = await captureYtScreen(channelIds[i], { kind: opts.kind, geo: opts.geo, force: opts.force }); }
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
