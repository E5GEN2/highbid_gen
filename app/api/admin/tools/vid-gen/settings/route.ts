import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

/**
 * Vid Gen settings — single-row config for the global prompt suffix
 * that gets appended at serve time.
 *
 * GET  /api/admin/tools/vid-gen/settings
 *   → { ok, suffix, suffixEnabled, updatedAt }
 *
 * PUT  /api/admin/tools/vid-gen/settings
 *   body: { suffix?: string; suffixEnabled?: boolean }
 *   → { ok, suffix, suffixEnabled, updatedAt }
 *
 * The suffix is appended verbatim to each served prompt with a single
 * space between, so a comma-led suffix like ", photoreal, cinematic"
 * gives natural results. We don't try to be clever about separators
 * — what the user types is what gets appended.
 *
 * Auth: admin Bearer token.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_SUFFIX_LEN = 500;

interface SettingsRow {
  suffix: string;
  suffix_enabled: boolean;
  updated_at: string;
}

async function readSettings(): Promise<SettingsRow> {
  const pool = await getPool();
  // Upsert-fetch: if the row got nuked somehow, recreate it on read so
  // GET never 500s on a missing config row.
  const r = await pool.query<SettingsRow>(
    `INSERT INTO vid_gen_settings (id) VALUES (1)
       ON CONFLICT (id) DO UPDATE SET id = 1
       RETURNING suffix, suffix_enabled, updated_at`,
  );
  return r.rows[0];
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const s = await readSettings();
  return NextResponse.json({
    ok: true,
    suffix: s.suffix,
    suffixEnabled: s.suffix_enabled,
    updatedAt: s.updated_at,
  });
}

export async function PUT(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as {
    suffix?: string;
    suffixEnabled?: boolean;
  };

  const sets: string[] = [];
  const params: (string | boolean)[] = [];
  if (typeof body.suffix === 'string') {
    if (body.suffix.length > MAX_SUFFIX_LEN) {
      return NextResponse.json({ error: `suffix exceeds ${MAX_SUFFIX_LEN} chars` }, { status: 400 });
    }
    params.push(body.suffix);
    sets.push(`suffix = $${params.length}`);
  }
  if (typeof body.suffixEnabled === 'boolean') {
    params.push(body.suffixEnabled);
    sets.push(`suffix_enabled = $${params.length}`);
  }
  if (sets.length === 0) {
    return NextResponse.json({ error: 'suffix or suffixEnabled required' }, { status: 400 });
  }
  sets.push(`updated_at = NOW()`);

  const pool = await getPool();
  // Ensure the row exists, then update. Cheaper than a write-time
  // upsert because we only ever have one row.
  await pool.query(`INSERT INTO vid_gen_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
  const r = await pool.query<SettingsRow>(
    `UPDATE vid_gen_settings SET ${sets.join(', ')} WHERE id = 1
       RETURNING suffix, suffix_enabled, updated_at`,
    params,
  );
  const s = r.rows[0];
  return NextResponse.json({
    ok: true,
    suffix: s.suffix,
    suffixEnabled: s.suffix_enabled,
    updatedAt: s.updated_at,
  });
}
