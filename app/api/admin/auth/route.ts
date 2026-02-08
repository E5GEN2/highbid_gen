import { NextRequest, NextResponse } from 'next/server';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'vitriol42';

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json();

    if (username === ADMIN_USER && password === ADMIN_PASS) {
      // Simple token - hash of credentials + secret
      const token = Buffer.from(`${ADMIN_USER}:${Date.now()}:rofe_admin_secret`).toString('base64');

      const response = NextResponse.json({ success: true, token });
      response.cookies.set('admin_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 60 * 60 * 24, // 24 hours
        path: '/',
      });

      return response;
    }

    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
}

// Check if admin is authenticated
export async function GET(req: NextRequest) {
  const token = req.cookies.get('admin_token')?.value;

  if (token) {
    try {
      const decoded = Buffer.from(token, 'base64').toString();
      if (decoded.startsWith(`${ADMIN_USER}:`) && decoded.endsWith(':rofe_admin_secret')) {
        return NextResponse.json({ authenticated: true });
      }
    } catch {
      // invalid token
    }
  }

  return NextResponse.json({ authenticated: false }, { status: 401 });
}
