import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { hashPassword } from '@/lib/password';

// Naive per-IP rate limit (best-effort; resets on redeploy / per-instance).
// Enough to blunt scripted abuse of open registration.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 10;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const cur = hits.get(ip);
  if (!cur || now > cur.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  cur.count += 1;
  return cur.count > MAX_PER_WINDOW;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (rateLimited(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 });
  }

  let body: { email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');

  if (!EMAIL_RE.test(email) || email.length > 255) {
    return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
  }
  if (password.length > 200) {
    return NextResponse.json({ error: 'Password is too long.' }, { status: 400 });
  }

  const password_hash = await hashPassword(password);

  try {
    await pool.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)`,
      [email, password_hash],
    );
  } catch (err) {
    // 23505 = unique_violation (email already registered)
    if ((err as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'An account with that email already exists.' }, { status: 409 });
    }
    console.error('[register] insert failed:', err);
    return NextResponse.json({ error: 'Could not create account.' }, { status: 500 });
  }

  // Client follows up with signIn('credentials', ...) to establish the session.
  return NextResponse.json({ ok: true });
}
