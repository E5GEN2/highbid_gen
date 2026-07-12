import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { hashPassword } from '@/lib/password';

/**
 * Admin-gated: set (or reset) a password on an EXISTING user account.
 * The browser counterpart of scripts/local/set-password.mts — lets an admin
 * recover a Google-orphaned account (which has no password) from any browser.
 * Requires admin auth (admin_token cookie / hba_ token). Only UPDATEs an
 * existing account; never creates one.
 */
export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { email?: unknown; password?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!email) return NextResponse.json({ error: 'Email is required.' }, { status: 400 });
  if (password.length < 8) return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
  if (password.length > 200) return NextResponse.json({ error: 'Password is too long.' }, { status: 400 });

  const password_hash = await hashPassword(password);
  const res = await pool.query(
    `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE LOWER(email) = $2`,
    [password_hash, email],
  );
  if (res.rowCount === 0) {
    return NextResponse.json({ error: `No account with email "${email}".` }, { status: 404 });
  }
  return NextResponse.json({ ok: true, email });
}
