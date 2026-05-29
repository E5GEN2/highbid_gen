/**
 * Temporary hardcoded SOCKS5 proxy list — bypass for the xgodo broker
 * while its TCP-dead rate (~78% per last sweep) makes its "online"
 * proxies useless for embedding traffic.
 *
 * Input format the operator supplies: `socks5://HOST:PORT:USER:PASS`
 * (one per line). We parse into a standard SOCKS5 URL
 * (`socks5://USER:PASS@HOST:PORT`) on load.
 *
 * Drop the list back to empty (or remove this file) once xgodo is
 * healthy again.
 */

const RAW = `
socks5://108.61.144.196:22076:highbid25030600:ov4PFfTsbtc9
socks5://207.246.90.229:21486:highbid25192025:0eJEkJ6cra5C
socks5://192.241.168.18:21652:highbid25193830:9NndtocPShDy
socks5://108.61.144.196:20131:highbid25031138:XaIHP3BbuWKi
socks5://207.246.85.39:13620:highbid25191600:MkGeBu37PRmX
socks5://207.246.90.229:20611:highbid25241812:8TtkcN34Wm09
socks5://157.230.227.47:21402:highbid25022229:4J7hlQw2oKgf
socks5://208.167.255.14:17897:highbid25195821:Bmfdwvn3Zfn2
socks5://108.61.144.196:14415:highbid25190114:RvRyD103YWS1
socks5://192.241.168.18:21326:highbid25021238:mHFy654nSAwO
socks5://45.63.17.144:15885:highbid25104813:B1Ya59TNM7M9
socks5://192.241.168.18:17964:highbid25041810:N4LQHXlyY0zg
socks5://208.167.255.14:15824:highbid25274718:Wktqes74ZlGl
socks5://207.246.90.229:13194:highbid25195719:RFcl8C0NQbR8
socks5://108.61.144.196:20291:highbid25194217:zS14UUYYmTzE
socks5://192.241.168.18:15019:highbid25274311:0gNC9YU9YeEA
socks5://138.197.13.180:21444:highbid25112137:3Maqco61LUip
socks5://192.241.168.18:14844:highbid25100028:7EJorcAmgb43
socks5://192.241.168.18:19250:highbid25273527:36pN4ghRUUT6
socks5://207.246.85.39:14849:highbid25043945:zloSRX97qGGP
socks5://192.241.168.18:21031:highbid25194309:zAUBn4pcF78m
socks5://108.61.144.196:14400:highbid25215120:6mKPWPJx6qNW
socks5://108.61.144.196:17153:highbid25192444:OSL6xUgu3VXO
socks5://108.61.144.196:13822:highbid25044250:kN0YqTfpUI8e
socks5://192.241.168.18:21759:highbid25193747:Rh8w97HTGEgx
socks5://207.246.90.229:20679:highbid25190804:Qg6Z8x3UGXdC
socks5://207.246.90.229:14614:highbid25043536:qPzPNhXr2fcT
socks5://192.241.168.18:19480:highbid25193323:xc7WqcWMLfN9
socks5://66.42.107.11:13440:highbid25193726:Boefmhe9j7aM
socks5://208.167.255.14:17151:highbid25192726:04GGLRnOgq50
socks5://208.167.255.14:20702:highbid25223744:0LkFmzLqXDn9
socks5://157.230.227.47:20304:highbid25105240:7TFhm0UuHBTD
socks5://138.197.13.180:14566:highbid25151615:EFtdGQ1TrX9n
socks5://45.63.17.144:18392:highbid25100338:QiTKLN3Xz68p
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
    // Format: socks5://HOST:PORT:USER:PASS
    const m = line.match(/^socks5:\/\/([^:]+):(\d+):([^:]+):(.+)$/);
    if (!m) {
      console.warn('[static-proxies] unparseable line:', line);
      continue;
    }
    const [, host, port, user, pass] = m;
    out.push({
      url: `socks5://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`,
      host,
      port: parseInt(port, 10),
      id: `${host}:${port}`,
    });
  }
  return out;
}

const PROXIES = parse();

export function hasStaticProxies(): boolean {
  return PROXIES.length > 0;
}

export function getRandomStaticProxy(): StaticProxy | null {
  if (PROXIES.length === 0) return null;
  return PROXIES[Math.floor(Math.random() * PROXIES.length)];
}

export function listStaticProxies(): StaticProxy[] {
  return PROXIES.slice();
}
