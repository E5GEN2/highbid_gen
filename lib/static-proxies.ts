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
socks5://kfv44z4hhf.cn.fxdx.in:14614:highbid25043536:DgEATiiHYC04
socks5://heft45hssb.cn.fxdx.in:18386:xGdo026015749:o4qE8Rha57SW
socks5://ksx6sg52fb.cn.fxdx.in:13822:highbid25044250:kN0YqTfpUI8e
socks5://2uq573tu4j.cn.fxdx.in:16557:highbid25182841:htL9x9pxOgS5
socks5://lojreyxn4b.cn.fxdx.in:21031:highbid25194309:zAUBn4pcF78m
socks5://v5lfppzimf.cn.fxdx.in:14844:highbid25100028:7EJorcAmgb43
socks5://7rm464ytq5.cn.fxdx.in:20291:highbid25194217:zS14UUYYmTzE
socks5://f5omruqytf.cn.fxdx.in:17964:highbid25041810:N4LQHXlyY0zg
socks5://ca4h7lanw5.cn.fxdx.in:19534:highbid25163357:drWYnd02B11L
socks5://5bl77zdq6z.cn.fxdx.in:14415:highbid25190114:F1DmFqY0siAH
socks5://6r5ghmeuyf.cn.fxdx.in:16119:highbid25044627:vsgKke7Dr5F5
socks5://yz5lqryfpv.cn.fxdx.in:19510:highbid25173124:NP87AoO26DOv
socks5://tl73dbwmqn.cn.fxdx.in:20611:highbid25241812:8TtkcN34Wm09
socks5://ixbnf74df5.cn.fxdx.in:21652:highbid25193830:9NndtocPShDy
socks5://3xigyo7fd5.cn.fxdx.in:20025:highbid25142908:udCjR0ZZCafs
socks5://jxzzyna4gz.cn.fxdx.in:20304:highbid25105240:pBed3flP1ukW
socks5://cidmoeziqr.cn.fxdx.in:18392:highbid25100338:QiTKLN3Xz68p
socks5://wgeohyvvnr.cn.fxdx.in:20702:highbid25223744:0LkFmzLqXDn9
socks5://ei2v66ymy5.cn.fxdx.in:13440:highbid25193726:Boefmhe9j7aM
socks5://fmzryg3g3v.cn.fxdx.in:18371:highbid25064904:a5fky99uTuKf
socks5://4aoj77sbr5.cn.fxdx.in:20679:highbid25190804:TwIA1cXw6VxB
socks5://c3eqijjojf.cn.fxdx.in:13701:highbid25203718:89DOclIxgn1k
socks5://7spitm6dwj.cn.fxdx.in:17153:highbid25192444:mhltTi8HEJhU
socks5://kbzyuoeetv.cn.fxdx.in:18564:highbid25101527:LHx52Sj7BoTk
socks5://lbw7ak3s2j.cn.fxdx.in:14849:highbid25043945:zloSRX97qGGP
socks5://afo23nalwb.cn.fxdx.in:21444:highbid25112137:3Maqco61LUip
socks5://epilupozhv.cn.fxdx.in:22144:highbid25201537:nhW5LGnn5q7j
socks5://6asshruhw5.cn.fxdx.in:18124:highbid25171530:9ya01PoPwAMT
socks5://qcpxdnxbtv.cn.fxdx.in:21358:highbid25060312:SWu9wpri0JqT
socks5://axcntovllb.cn.fxdx.in:14439:highbid25210946:fYw5I8P8Xifs
socks5://b2cb5hhryz.cn.fxdx.in:17897:highbid25195821:mFbY4moispwG
socks5://2wx7rgrw4n.cn.fxdx.in:13620:highbid25191600:MkGeBu37PRmX
socks5://qsev5zhfpz.cn.fxdx.in:21486:highbid25192025:0eJEkJ6cra5C
socks5://oikttpajkn.cn.fxdx.in:22385:highbid25155845:1zuXl14ROA0f
socks5://mgljc4kkan.cn.fxdx.in:17151:highbid25192726:Zw0OXfZGRJJf
socks5://7kvwcx3mbj.cn.fxdx.in:14503:xGdo026223840:7mxcXav9gcU4
socks5://mnieiikadn.cn.fxdx.in:21759:highbid25193747:YuKZOA12U8Qj
socks5://ospfxypvc5.cn.fxdx.in:21461:highbid25200038:oaXs71SYBWG7
socks5://g2jbsl4yrv.cn.fxdx.in:21954:highbid25204506:JPdJHxhg6Og8
socks5://xakozatuiv.cn.fxdx.in:14400:highbid25215120:6mKPWPJx6qNW
socks5://wwumyijrdj.cn.fxdx.in:19250:highbid25273527:zguL6ax2bIkW
socks5://nw3fd262wv.cn.fxdx.in:15019:highbid25274311:0gNC9YU9YeEA
socks5://jft2b74qef.cn.fxdx.in:15824:highbid25274718:z0P0TPqrPlhR
socks5://6br3dh2pib.cn.fxdx.in:21326:highbid25021238:mHFy654nSAwO
socks5://xosl5aaoen.cn.fxdx.in:21402:highbid25022229:46ZwrhYY5Mqg
socks5://ca4fkbgrgf.cn.fxdx.in:17590:xGdo026015419:N7upZoUFWyVs
socks5://7slegaqkzj.cn.fxdx.in:20131:highbid25031138:XaIHP3BbuWKi
socks5://t6rm7umnqb.cn.fxdx.in:22076:highbid25030600:ov4PFfTsbtc9
socks5://ohiljyoq2v.cn.fxdx.in:15590:xGdo026195146:hi9AQJYxc9pe
socks5://uubjn6gyo5.cn.fxdx.in:14574:xGdo026195400:pDv60As0Lbk8
socks5://mcmw677wdf.cn.fxdx.in:23154:highbid25154633:V5C7ICwwb3bv
socks5://6qcx7c5sdr.cn.fxdx.in:13559:highbid25194406:TEbNwi43l7i8
socks5://jib3iq4zez.cn.fxdx.in:17152:xGdo026224113:G3arjU8B251N
socks5://pwqggkrgkr.cn.fxdx.in:20542:xGdo026015250:SdYicjm9mjn6
socks5://7nzisy65en.cn.fxdx.in:18591:xGdo026015055:ZyMU7Ah5sZbD
socks5://qyuyajrkzz.cn.fxdx.in:16355:xGdo026014709:sogMP8yTfCmW
socks5://ewcoxp5ocn.cn.fxdx.in:14291:xGdo026095202:Tyb3ANkSHr9C
socks5://g4bz4idpgr.cn.fxdx.in:14555:xGdo026095632:o9TDgW76dfmW
socks5://m5bryhxpyr.cn.fxdx.in:13170:xGdo026090003:c4hdKq7cTxXi
socks5://t5faqrrdv5.cn.fxdx.in:19304:xGdo026090229:fgbzt9zVHNmG
socks5://lobdpkljjf.cn.fxdx.in:21905:xGdo026090528:CrbJS5XiJW53
socks5://mrtcyyrpxf.cn.fxdx.in:15649:xGdo026090819:Buq1Wmq4G318
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
