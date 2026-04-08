import { NextResponse } from 'next/server';
import { getProxy, getProxies } from '@/lib/xgodo-proxy';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * GET /api/niche-spy/test-proxy
 * Debug: test curl with proxy from Railway.
 * Tests both xgodo.com:3008 and 54.36.178.74:1082 hosts.
 */
export async function GET() {
  const results: Record<string, unknown> = {};

  try {
    // 1. Check proxies
    const proxies = await getProxies();
    results.proxiesAvailable = proxies.length;
    const proxy = await getProxy();
    results.proxyUrl = proxy ? proxy.url.substring(0, 40) + '...' : 'none';
    results.proxyDevice = proxy?.deviceId;

    // 2. Test curl without proxy (direct)
    try {
      const { stdout: directOut, stderr: directErr } = await execFileAsync('curl', [
        '-s', '-w', '\\n%{http_code}', '--max-time', '10',
        'https://generativelanguage.googleapis.com/v1beta/models'
      ], { timeout: 15000 });
      const lines = directOut.trim().split('\n');
      results.directStatus = lines[lines.length - 1];
      results.directBody = lines.slice(0, -1).join('\n').substring(0, 100);
      results.directStderr = directErr?.substring(0, 100);
    } catch (e) {
      results.directError = (e as { message?: string; stderr?: string }).stderr?.substring(0, 200) || (e as Error).message?.substring(0, 200);
    }

    // 3. Test curl with proxy
    if (proxy) {
      try {
        const { stdout: proxyOut, stderr: proxyErr } = await execFileAsync('curl', [
          '-s', '-w', '\\n%{http_code}', '--max-time', '15',
          '--proxy', proxy.url,
          'https://httpbin.org/ip'
        ], { timeout: 20000 });
        const lines = proxyOut.trim().split('\n');
        results.proxyHttpbinStatus = lines[lines.length - 1];
        results.proxyHttpbinBody = lines.slice(0, -1).join('\n').substring(0, 200);
        results.proxyStderr = proxyErr?.substring(0, 100);
      } catch (e) {
        results.proxyHttpbinError = (e as { message?: string; stderr?: string }).stderr?.substring(0, 200) || (e as Error).message?.substring(0, 200);
      }

      // 4. Test curl with proxy to Google API
      try {
        const { stdout: gOut, stderr: gErr } = await execFileAsync('curl', [
          '-s', '-w', '\\n%{http_code}', '--max-time', '15',
          '--proxy', proxy.url,
          'https://generativelanguage.googleapis.com/v1beta/models'
        ], { timeout: 20000 });
        const lines = gOut.trim().split('\n');
        results.proxyGoogleStatus = lines[lines.length - 1];
        results.proxyGoogleBody = lines.slice(0, -1).join('\n').substring(0, 200);
        results.proxyGoogleStderr = gErr?.substring(0, 100);
      } catch (e) {
        results.proxyGoogleError = (e as { message?: string; stderr?: string }).stderr?.substring(0, 200) || (e as Error).message?.substring(0, 200);
      }
    }

    // 5. curl version
    try {
      const { stdout: ver } = await execFileAsync('curl', ['--version'], { timeout: 5000 });
      results.curlVersion = ver.split('\n')[0];
    } catch { results.curlVersion = 'unknown'; }

  } catch (e) {
    results.error = (e as Error).message;
  }

  return NextResponse.json(results);
}
