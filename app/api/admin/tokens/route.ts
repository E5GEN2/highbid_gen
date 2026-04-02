import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { createApiToken, listApiTokens, deleteApiToken } from '@/lib/api-auth';

/**
 * GET /api/admin/tokens
 * List all API tokens. No auth required (admin debug).
 */
export async function GET() {
  const tokens = await listApiTokens();
  return NextResponse.json({ tokens });
}

/**
 * POST /api/admin/tokens
 * Create a new API token. Auto-links to logged-in user's session.
 * Body: { userId?, name? }
 * Returns the full token (only shown once).
 */
export async function POST(req: NextRequest) {
  const { userId, name } = await req.json();

  // Use session user_id if not explicitly provided
  let resolvedUserId = userId || null;
  if (!resolvedUserId) {
    const session = await auth();
    resolvedUserId = session?.user?.id || null;
  }

  const result = await createApiToken(resolvedUserId, name || 'cli');
  return NextResponse.json({ id: result.id, token: result.token });
}

/**
 * DELETE /api/admin/tokens?id=xxx
 * Delete an API token.
 */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const ok = await deleteApiToken(id);
  return NextResponse.json({ ok });
}
