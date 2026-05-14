import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/admin/tools/yt-data-keys/export
 *
 * Dumps all YouTube Data API v3 keys from xgodo_api_keys as a browser
 * download. Mirrors the AI Studio export endpoint — same query params,
 * same format options, same dated attachment behavior.
 *
 * Query params:
 *   format  txt | csv | json     (default: txt — one key per line)
 *   status  active | invalid | banned | all  (default: active)
 *   source  optional substring filter on source (e.g. 'xgodo-import')
 *
 * Always Content-Disposition: attachment with a dated filename so a
 * <a download> link triggers a file save in the browser.
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const format = (sp.get('format') || 'txt').toLowerCase();
  const status = (sp.get('status') || 'active').toLowerCase();
  const source = sp.get('source');

  const conds: string[] = [`service = 'youtube_data'`];
  const args: (string)[] = [];
  let p = 1;
  if (status !== 'all') {
    conds.push(`status = $${p++}`);
    args.push(status);
  }
  if (source) {
    conds.push(`source = $${p++}`);
    args.push(source);
  }

  const pool = await getPool();
  const r = await pool.query<{
    key: string;
    source: string;
    status: string;
    added_at: Date;
    last_used_at: Date | null;
    banned_until: Date | null;
  }>(
    `SELECT key, source, status, added_at, last_used_at, banned_until
       FROM xgodo_api_keys
      WHERE ${conds.join(' AND ')}
      ORDER BY added_at ASC`,
    args,
  );

  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const base = `yt-data-keys_${status}${source ? '_' + source : ''}_${stamp}`;

  if (format === 'json') {
    return new NextResponse(JSON.stringify({
      service: 'youtube_data',
      count: r.rows.length,
      exported_at: new Date().toISOString(),
      keys: r.rows.map(row => ({
        key: row.key,
        source: row.source,
        status: row.status,
        added_at: row.added_at?.toISOString?.() ?? null,
        last_used_at: row.last_used_at?.toISOString?.() ?? null,
        banned_until: row.banned_until?.toISOString?.() ?? null,
      })),
    }, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${base}.json"`,
      },
    });
  }

  if (format === 'csv') {
    const lines = ['key,source,status,added_at,last_used_at,banned_until'];
    for (const row of r.rows) {
      lines.push([
        row.key,
        row.source,
        row.status,
        row.added_at?.toISOString?.() ?? '',
        row.last_used_at?.toISOString?.() ?? '',
        row.banned_until?.toISOString?.() ?? '',
      ].map(v => /[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(','));
    }
    return new NextResponse(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${base}.csv"`,
      },
    });
  }

  // txt — one key per line, simplest format. Trailing newline so cat
  // / wc -l / pipes behave correctly.
  const body = r.rows.map(row => row.key).join('\n') + (r.rows.length ? '\n' : '');
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${base}.txt"`,
    },
  });
}
