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
socks5://kfv44z4hhf.cn.fxdx.in:14614:highbid25043536:DgEATiiHYC04
socks5://ksx6sg52fb.cn.fxdx.in:18598:xGdo026244438:hhC5Z6vxJz76
socks5://lojreyxn4b.cn.fxdx.in:21031:highbid25194309:MCo0ko44f8SD
socks5://v5lfppzimf.cn.fxdx.in:14844:highbid25100028:7EJorcAmgb43
socks5://f5omruqytf.cn.fxdx.in:17964:highbid25041810:N4LQHXlyY0zg
socks5://5bl77zdq6z.cn.fxdx.in:14415:xGdo026242245:TYajMYvuT9zt
socks5://6r5ghmeuyf.cn.fxdx.in:16119:highbid25044627:vsgKke7Dr5F5
socks5://ixbnf74df5.cn.fxdx.in:21652:highbid25193830:9NndtocPShDy
socks5://ixbnf74df5.cn.fxdx.in:21460:highbid25063421:4GsXKEFV4dJD
socks5://jxzzyna4gz.cn.fxdx.in:20304:highbid25105240:Z9eQYm0L9lDo
socks5://cidmoeziqr.cn.fxdx.in:18392:highbid25100338:TXdTh8AN1aqO
socks5://wgeohyvvnr.cn.fxdx.in:20702:highbid25223744:7oVj9982AhTN
socks5://ei2v66ymy5.cn.fxdx.in:13440:highbid25193726:J1u3uLWzbNZo
socks5://7spitm6dwj.cn.fxdx.in:17153:highbid25192444:mhltTi8HEJhU
socks5://kbzyuoeetv.cn.fxdx.in:18564:highbid25101527:LHx52Sj7BoTk
http://kbzyuoeetv.cn.fxdx.in:16928:highbid25102618:2rQRlk6JQnVd
socks5://lbw7ak3s2j.cn.fxdx.in:14849:highbid25043945:flO3xmeMmotC
socks5://afo23nalwb.cn.fxdx.in:13385:xGdo026244804:J2f6GuotoD7b
socks5://qcpxdnxbtv.cn.fxdx.in:14295:xGdo026243524:PaEFzeCJV979
socks5://axcntovllb.cn.fxdx.in:14566:highbid25151615:43Ct9n0y7Ewb
socks5://axcntovllb.cn.fxdx.in:18761:xGdo026225226:afVxUHgP8XEn
socks5://qm4wacidkz.cn.fxdx.in:20907:xGdo026232552:5Dw1pYGSREPk
socks5://b2cb5hhryz.cn.fxdx.in:18180:xGdo026015144:fPQ5NfAxq2DM
socks5://b2cb5hhryz.cn.fxdx.in:13102:xGdo026123120:T5NygzvDY7y9
socks5://2wx7rgrw4n.cn.fxdx.in:13620:highbid25191600:N0jLcq9eDSrj
socks5://qsev5zhfpz.cn.fxdx.in:21486:highbid25192025:nB0I4oqFwzVx
socks5://oikttpajkn.cn.fxdx.in:14294:xGdo026240433:YyjKIS6lG19J
socks5://mgljc4kkan.cn.fxdx.in:17406:xGdo026052014:dwkznjxe9Ddl
socks5://ospfxypvc5.cn.fxdx.in:18577:xGdo026244107:R5KvqQTqtMKf
socks5://g2jbsl4yrv.cn.fxdx.in:21220:highbid25280452:Iwt3Yuk5asAI
socks5://xakozatuiv.cn.fxdx.in:15945:xGdo026264019:4NBRIlPm8AP8
socks5://6br3dh2pib.cn.fxdx.in:21326:highbid25021238:6TRVkm7Ca26M
socks5://xosl5aaoen.cn.fxdx.in:21402:highbid25022229:39abKAWRKSnn
socks5://ca4fkbgrgf.cn.fxdx.in:17590:xGdo026015419:8UgYQ6yemZPQ
socks5://7slegaqkzj.cn.fxdx.in:20131:highbid25031138:XC4vn1KtQCif
socks5://t6rm7umnqb.cn.fxdx.in:22076:highbid25030600:ov4PFfTsbtc9
socks5://ohiljyoq2v.cn.fxdx.in:19819:xGdo026250803:0PNPhS0dqCJx
socks5://5ignk6hlqr.cn.fxdx.in:19207:xGdo026265359:jJWdkFpjBJ0f
socks5://mcmw677wdf.cn.fxdx.in:23154:highbid25154633:V5C7ICwwb3bv
http://mcmw677wdf.cn.fxdx.in:16223:highbid25165940:sOhFTSAA6LHq
socks5://wwh2mpndov.cn.fxdx.in:16877:xGdo026265219:ZDGw1hf20IH7
socks5://6qcx7c5sdr.cn.fxdx.in:13559:highbid25194406:TEbNwi43l7i8
socks5://jib3iq4zez.cn.fxdx.in:17152:xGdo026224113:G3arjU8B251N
socks5://pwqggkrgkr.cn.fxdx.in:20542:xGdo026015250:SdYicjm9mjn6
socks5://7nzisy65en.cn.fxdx.in:18591:xGdo026015055:2CpyLQx716Ke
socks5://qyuyajrkzz.cn.fxdx.in:16355:xGdo026014709:hfxkJtEyX7DD
socks5://ewcoxp5ocn.cn.fxdx.in:16659:xGdo026243121:OBlS4FbmrgHQ
socks5://m5bryhxpyr.cn.fxdx.in:19727:xGdo026094816:CGFhcaos1BGD
socks5://mrtcyyrpxf.cn.fxdx.in:15363:xGdo026243917:7PePaPqvlGh2
socks5://mkg25fk3e5.cn.fxdx.in:16829:xGdo026250511:1TYDym9RGgg7
socks5://27eemxyiej.cn.fxdx.in:16529:xGdo026163348:0wg6gvoT4fWl
socks5://ny6cdwtxfr.cn.fxdx.in:16876:xGdo026204651:WyP65hzx78dy
socks5://5teghhagcn.cn.fxdx.in:20451:xGdo026225624:X7V99NRUtXlr
socks5://3utl3nb3mf.cn.fxdx.in:16027:xGdo026234859:z0ApwdjQmoSV
http://3utl3nb3mf.cn.fxdx.in:19464:xGdo026234904:jTQX8xp54mn2
socks5://fjkssuvdrv.cn.fxdx.in:17221:xGdo026243723:nF7440lDgKyW
socks5://fjcgo7tyyz.cn.fxdx.in:22629:xGdo026251517:7gZ0N1Tls7i1
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
