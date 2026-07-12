/**
 * Temporary hardcoded SOCKS5 proxy list — bypass for the xgodo broker
 * while its TCP-dead rate (~78% per last sweep) makes its "online"
 * proxies useless for embedding traffic.
 *
 * Input format the operator supplies: `socks5://HOST:PORT:USER:PASS` or
 * `http://HOST:PORT:USER:PASS` (one per line). BOTH schemes work end-to-end:
 * video-seed routes SOCKS via SocksProxyAgent and HTTP via undici ProxyAgent
 * (proxy-dispatcher.ts fetchViaProxy), and the key-checker's `curl -x` accepts
 * both (embed-batch.py). We parse into a proxy URL with embedded auth on load:
 * socks5 → `socks5h://USER:PASS@HOST:PORT` (proxy-side DNS, required by the
 * provider — host-side DNS gets NetworkUnreachable), http → `http://USER:PASS@HOST:PORT`.
 *
 * Drop the list back to empty (or remove this file) once xgodo is
 * healthy again.
 *
 * Last refreshed 2026-07-10 (operator-supplied): 66 nodes (63 socks5 + 3 http).
 */

const RAW = `
socks5://207.246.90.229:14614:highbid25043536:DgEATiiHYC04
socks5://108.61.144.196:13822:highbid25044250:kN0YqTfpUI8e
socks5://192.241.168.18:21031:highbid25194309:pGjC83CJ2zfc
socks5://192.241.168.18:14844:highbid25100028:7EJorcAmgb43
socks5://108.61.144.196:20291:highbid25194217:zS14UUYYmTzE
socks5://192.241.168.18:17964:highbid25041810:N4LQHXlyY0zg
socks5://207.246.90.229:17219:xGdo026283407:t9Spmt1K2pgF
socks5://207.246.90.229:14327:xGdo026271908:BebCr3EHh9IV
socks5://108.61.144.196:14415:highbid25190114:upGrOuinW1ce
socks5://45.63.5.159:16119:highbid25044627:vsgKke7Dr5F5
socks5://207.246.90.229:20611:highbid25241812:8TtkcN34Wm09
socks5://192.241.168.18:21652:highbid25193830:9NndtocPShDy
socks5://192.241.168.18:21460:highbid25063421:4GsXKEFV4dJD
socks5://207.246.90.229:20025:highbid25142908:sDZm7LH2aCBu
socks5://157.230.227.47:20304:highbid25105240:x3WkrUc0AH4G
socks5://45.63.17.144:18392:highbid25100338:TXdTh8AN1aqO
socks5://208.167.255.14:20702:highbid25223744:0LkFmzLqXDn9
socks5://207.246.90.229:13440:highbid25193726:Boefmhe9j7aM
socks5://207.246.90.229:20679:highbid25190804:y164PZaDOe5g
socks5://108.61.144.196:17153:highbid25192444:mhltTi8HEJhU
socks5://207.246.85.39:18564:highbid25101527:LHx52Sj7BoTk
socks5://207.246.85.39:14849:highbid25043945:snKGXJ9W4V2y
socks5://138.197.13.180:21444:highbid25112137:floQQz2mqyA3
socks5://207.246.90.229:13194:highbid25195719:RFcl8C0NQbR8
socks5://138.197.13.180:14439:highbid25210946:fYw5I8P8Xifs
socks5://138.197.13.180:14566:highbid25151615:EFtdGQ1TrX9n
socks5://45.63.17.144:20907:xGdo026232552:5Dw1pYGSREPk
socks5://208.167.255.14:18180:xGdo026015144:fPQ5NfAxq2DM
socks5://207.246.85.39:13620:highbid25191600:N0jLcq9eDSrj
socks5://207.246.90.229:21486:highbid25192025:nB0I4oqFwzVx
socks5://157.230.227.47:14294:xGdo026240433:YyjKIS6lG19J
socks5://45.63.17.144:17406:xGdo026052014:FSKW6qWnIpq1
socks5://192.241.168.18:14503:xGdo026223840:7mxcXav9gcU4
socks5://192.241.168.18:21461:highbid25200038:oaXs71SYBWG7
socks5://45.63.17.144:21220:highbid25280452:Iwt3Yuk5asAI
socks5://45.63.17.144:14070:xGdo026262350:2LFNSLrfdC2I
socks5://108.61.144.196:15945:xGdo026264019:4NBRIlPm8AP8
socks5://192.241.168.18:21326:highbid25021238:6TRVkm7Ca26M
socks5://157.230.227.47:21402:highbid25022229:Xfo5jaBTfrRS
socks5://208.167.255.14:17590:xGdo026015419:viCEgktve20q
socks5://108.61.144.196:20131:highbid25031138:XaIHP3BbuWKi
socks5://108.61.144.196:22076:highbid25030600:ov4PFfTsbtc9
socks5://45.76.233.138:15590:xGdo026195146:1XCbtRLZiUin
socks5://157.230.227.47:19207:xGdo026265359:jJWdkFpjBJ0f
socks5://45.63.17.144:23154:highbid25154633:V5C7ICwwb3bv
socks5://45.63.5.159:16877:xGdo026265219:ZDGw1hf20IH7
socks5://138.197.13.180:19391:xGdo026084714:SWZl1v02zk2f
socks5://157.230.227.47:13559:highbid25194406:TEbNwi43l7i8
socks5://45.63.5.159:16027:xGdo026081340:MkkKpcFe0e3Z
socks5://157.230.227.47:17152:xGdo026224113:G3arjU8B251N
socks5://208.167.255.14:20542:xGdo026015250:SdYicjm9mjn6
socks5://138.197.13.180:18591:xGdo026015055:2CpyLQx716Ke
socks5://45.63.5.159:16355:xGdo026014709:q2kLX9aFHc3W
socks5://192.241.168.18:17588:xGdo026094524:Jj49Md2wpH4q
socks5://138.197.13.180:14555:xGdo026095632:o9TDgW76dfmW
socks5://45.63.17.144:19727:xGdo026094816:CGFhcaos1BGD
socks5://108.61.144.196:19304:xGdo026090229:e3PpgkJQb53Q
socks5://138.197.13.180:21905:xGdo026090528:CrbJS5XiJW53
socks5://45.63.17.144:15649:xGdo026090819:Buq1Wmq4G318
socks5://108.61.224.176:15875:xGdo026034156:7KJgO6nGI1Vy
socks5://108.61.224.176:17127:xGdo026034559:cAoWMy5qEMc6
socks5://157.230.227.47:16679:xGdo026052634:bD1zG9c85NMY
socks5://66.135.17.126:17404:xGdo026081627:yA0gmM4wsKLs
http://207.246.85.39:16928:highbid25102618:2rQRlk6JQnVd
http://45.63.17.144:16223:highbid25165940:sOhFTSAA6LHq
http://45.63.5.159:19464:xGdo026081351:V9A4pjx1Wldl
`;

export interface StaticProxy {
  /** Standard SOCKS5 URL with embedded auth: socks5://user:pass@host:port */
  url: string;
  host: string;
  port: number;
  /** Stable id for logging / health tracking, derived from host:port. */
  id: string;
}

/** Parse the colon-formatted lines into useable proxy entries. */
function parse(): StaticProxy[] {
  const out: StaticProxy[] = [];
  for (const raw of RAW.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Format: <socks5|http>://HOST:PORT:USER:PASS
    const m = line.match(/^(socks5|http):\/\/([^:]+):(\d+):([^:]+):(.+)$/);
    if (!m) {
      console.warn('[static-proxies] unparseable line:', line);
      continue;
    }
    const [, scheme, host, port, user, pass] = m;
    // socks5 → socks5h:// (DNS resolved by the proxy; the provider's nodes
    // reject host-side DNS with NetworkUnreachable — verified via local
    // probe — so plain socks5:// would fail every call). http proxies
    // tunnel via CONNECT, so DNS is proxy-side already.
    const outScheme = scheme === 'socks5' ? 'socks5h' : 'http';
    out.push({
      url: `${outScheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`,
      host,
      port: parseInt(port, 10),
      id: `${host}:${port}`,
    });
  }
  return out;
}

const PROXIES = parse();

// ── In-process rotation health (user 2026-07-07: "you should have just
// rotate") ── uniform-random over the raw list re-draws dead exits forever:
// runs 49-51 burned 3 studio attempts re-picking the same failing nodes while
// good ones existed. Track consecutive failures per exit; an exit with ≥2
// strikes is benched for 10 min (re-enters automatically — no permanent
// blacklist, the pool is small and nodes recover). Callers report outcomes
// via reportStaticProxyResult().
const STRIKE_BENCH_MS = 10 * 60_000;
const STRIKES_TO_BENCH = 2;
const strikes = new Map<string, { n: number; benchedUntil: number }>();

export function reportStaticProxyResult(idOrUrl: string, ok: boolean): void {
  const id = PROXIES.find(p => p.url === idOrUrl || p.id === idOrUrl)?.id ?? idOrUrl;
  const cur = strikes.get(id) ?? { n: 0, benchedUntil: 0 };
  if (ok) { strikes.delete(id); return; }
  cur.n += 1;
  if (cur.n >= STRIKES_TO_BENCH) {
    cur.benchedUntil = Date.now() + STRIKE_BENCH_MS;
    cur.n = 0;
    console.warn(`[static-proxies] benched ${id} for ${STRIKE_BENCH_MS / 60000}min (repeated failures); ${availableCount() - 1} of ${PROXIES.length} in rotation`);
  }
  strikes.set(id, cur);
}

function availableCount(): number {
  const now = Date.now();
  return PROXIES.filter(p => (strikes.get(p.id)?.benchedUntil ?? 0) <= now).length;
}

export function hasStaticProxies(): boolean {
  return PROXIES.length > 0;
}

export function getRandomStaticProxy(): StaticProxy | null {
  if (PROXIES.length === 0) return null;
  const now = Date.now();
  const avail = PROXIES.filter(p => (strikes.get(p.id)?.benchedUntil ?? 0) <= now);
  // Whole pool benched → fall back to the full list (never starve).
  const pool = avail.length > 0 ? avail : PROXIES;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function listStaticProxies(): StaticProxy[] {
  return PROXIES.slice();
}
