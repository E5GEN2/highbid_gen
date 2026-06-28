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
socks5://108.61.144.196:13822:highbid25044250:kN0YqTfpUI8e
socks5://108.61.144.196:15945:xGdo026264019:lNG98EJOmkzw
socks5://108.61.144.196:19304:xGdo026090229:e3PpgkJQb53Q
socks5://108.61.144.196:20131:highbid25031138:XaIHP3BbuWKi
socks5://108.61.144.196:22076:highbid25030600:ov4PFfTsbtc9
socks5://138.197.13.180:14555:xGdo026095632:o9TDgW76dfmW
socks5://138.197.13.180:18591:xGdo026015055:0o4MQiO9q1J6
socks5://138.197.13.180:20853:xGdo026224256:OMBLC0Fg6Kqn
socks5://138.197.13.180:21444:highbid25112137:floQQz2mqyA3
socks5://138.197.13.180:21905:xGdo026090528:CrbJS5XiJW53
socks5://157.230.227.47:13559:highbid25194406:TEbNwi43l7i8
socks5://157.230.227.47:14294:xGdo026240433:YyjKIS6lG19J
socks5://157.230.227.47:17152:xGdo026224113:G3arjU8B251N
socks5://157.230.227.47:21402:highbid25022229:Xfo5jaBTfrRS
socks5://157.230.227.47:22144:highbid25201537:nhW5LGnn5q7j
socks5://192.241.168.18:14291:xGdo026095202:Tyb3ANkSHr9C
socks5://192.241.168.18:14503:xGdo026223840:7mxcXav9gcU4
socks5://192.241.168.18:17964:highbid25041810:N4LQHXlyY0zg
socks5://192.241.168.18:21031:highbid25194309:zAUBn4pcF78m
socks5://192.241.168.18:21326:highbid25021238:mHFy654nSAwO
socks5://192.241.168.18:21461:highbid25200038:oaXs71SYBWG7
socks5://207.246.85.39:13620:highbid25191600:N0jLcq9eDSrj
socks5://207.246.85.39:18124:highbid25171530:tLlxkBbCK48W
socks5://207.246.85.39:18564:highbid25101527:LHx52Sj7BoTk
socks5://207.246.90.229:13194:highbid25195719:RFcl8C0NQbR8
socks5://207.246.90.229:14614:highbid25043536:DgEATiiHYC04
socks5://207.246.90.229:20025:highbid25142908:udCjR0ZZCafs
socks5://207.246.90.229:20611:highbid25241812:8TtkcN34Wm09
socks5://207.246.90.229:20679:highbid25190804:TwIA1cXw6VxB
socks5://207.246.90.229:21486:highbid25192025:x8gGUC1qwV2A
socks5://208.167.255.14:17151:highbid25192726:ylDFEfSA20vk
socks5://208.167.255.14:20702:highbid25223744:0LkFmzLqXDn9
socks5://45.63.17.144:13170:xGdo026090003:wqQOZKXuBh6E
socks5://45.63.17.144:15649:xGdo026090819:Buq1Wmq4G318
socks5://45.63.17.144:18392:highbid25100338:QiTKLN3Xz68p
socks5://45.63.17.144:20907:xGdo026232552:5Dw1pYGSREPk
socks5://45.63.17.144:23154:highbid25154633:V5C7ICwwb3bv
socks5://45.63.5.159:14533:xGdo026200730:dbZpx1kun9Ro
socks5://45.63.5.159:16119:highbid25044627:vsgKke7Dr5F5
socks5://45.63.5.159:16877:xGdo026265219:ZDGw1hf20IH7
socks5://45.63.5.159:19510:highbid25173124:NP87AoO26DOv
socks5://45.76.233.138:15590:xGdo026195146:1XCbtRLZiUin
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
      // socks5h:// (DNS resolved by the proxy). The provider's nodes
      // reject host-side DNS with NetworkUnreachable — verified via
      // local probe — so plain socks5:// would fail every call.
      url: `socks5h://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`,
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
