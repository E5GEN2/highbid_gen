/**
 * In-process HTTP-to-SOCKS5 bridge.
 *
 * Chromium has two long-standing limitations that combine to make our
 * static SOCKS5 pool unusable directly:
 *   1. Chromium can't do SOCKS5 with username/password auth at all
 *      ("Browser does not support socks5 proxy authentication")
 *   2. Chromium's HTTP-proxy CONNECT auth handshake is broken on Linux —
 *      Proxy-Authorization isn't sent, upstream RSTs the tunnel
 *
 * proxy-chain solves (2) by wrapping an HTTP upstream in a local anonymous
 * proxy. But proxy-chain only supports HTTP/HTTPS upstreams, not SOCKS5.
 *
 * This bridge solves (1) — and (2) by extension. It:
 *   - Listens on 127.0.0.1:<random port> as a plain anonymous HTTP proxy
 *   - For each Chromium CONNECT request, opens a SOCKS5+auth tunnel to the
 *     upstream via the `socks` package (which DOES support SOCKS5+auth)
 *   - Pipes raw bytes both ways so TLS terminates between Chromium and
 *     the eventual origin (we never see plaintext)
 *
 * Per-capture lifecycle: `createBridge(socksUrl)` → use bridge.url as
 * Chromium's proxy, `await bridge.close()` in finally. The bridge picks
 * its own ephemeral port so concurrent captures can't collide.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SocksClient, type SocksProxy } from 'socks';

export interface BridgeHandle {
  /** http://127.0.0.1:<port> — pass directly to Playwright's proxy.server. */
  url: string;
  /** Close the listening server and free the port. Safe to await on success too. */
  close(): Promise<void>;
}

/**
 * Spin up a local HTTP CONNECT proxy that tunnels through the given
 * authenticated SOCKS5 upstream URL. Accepts `socks5://user:pass@host:port`
 * (with or without the trailing 'h' for proxy-side DNS — SOCKS5 always
 * resolves at the proxy by spec).
 */
export function createSocksHttpBridge(socksUpstreamUrl: string): Promise<BridgeHandle> {
  const u = new URL(socksUpstreamUrl);
  if (!/^socks(5h?|4a?)?:/i.test(u.protocol)) {
    return Promise.reject(new Error(`createSocksHttpBridge: unexpected scheme '${u.protocol}', want socks5://`));
  }
  const proxy: SocksProxy = {
    host: u.hostname,
    port: parseInt(u.port, 10),
    type: 5,
    userId: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      // We only care about CONNECT (HTTPS). Plain HTTP forward isn't used
      // for the YT-capture flow — return 405 so misuse fails loudly.
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('only CONNECT supported');
    });

    server.on('connect', (req, clientSocket, head) => {
      const target = req.url ?? '';
      const m = target.match(/^([^:]+):(\d+)$/);
      if (!m) {
        clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        clientSocket.end();
        return;
      }
      const host = m[1];
      const port = parseInt(m[2], 10);

      SocksClient.createConnection({
        proxy,
        command: 'connect',
        destination: { host, port },
        timeout: 15_000,
      }).then(({ socket }) => {
        // Chromium expects the 200 BEFORE TLS bytes start flowing.
        clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: socks-http-bridge\r\n\r\n');
        // Pre-buffer (any HEAD bytes the client sent with CONNECT) → forward.
        if (head && head.length > 0) socket.write(head);
        socket.pipe(clientSocket);
        clientSocket.pipe(socket);
        const teardown = (e?: Error) => {
          if (e) { /* swallow — both sockets get torn down below */ }
          try { socket.destroy(); } catch { /* */ }
          try { clientSocket.destroy(); } catch { /* */ }
        };
        socket.on('error', teardown);
        socket.on('close', () => teardown());
        clientSocket.on('error', teardown);
        clientSocket.on('close', () => teardown());
      }).catch((err: Error) => {
        // Surface the SOCKS5 reason in a way Playwright will show: status
        // body becomes part of the page.goto error.
        clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\nsocks5 tunnel failed: ${err.message}`);
        clientSocket.end();
      });
    });

    server.on('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
