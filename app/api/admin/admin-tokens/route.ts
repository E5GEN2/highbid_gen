import { NextRequest, NextResponse } from 'next/server';
import { isAdmin, createAdminToken, listAdminTokens, deleteAdminToken } from '@/lib/admin-auth';

/**
 * GET /api/admin/admin-tokens — list admin tokens (requires admin auth)
 * POST /api/admin/admin-tokens — create new admin token (requires admin auth)
 * DELETE /api/admin/admin-tokens?id=xxx — delete admin token (requires admin auth)
 */

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const tokens = await listAdminTokens();
  return NextResponse.json({ tokens });
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const { name } = await req.json().catch(() => ({ name: 'admin' }));
  const result = await createAdminToken(name || 'admin');
  return NextResponse.json({ id: result.id, token: result.token });
}

export async function DELETE(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const ok = await deleteAdminToken(id);
  return NextResponse.json({ ok });
}
