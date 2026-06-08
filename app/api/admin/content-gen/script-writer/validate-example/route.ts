/**
 * Smoke endpoint: validates the hand-authored example concrete script and
 * dumps the validator output + a few interpolation tests. Hit via:
 *   curl -H "Authorization: Bearer hba_..." https://rofe.ai/api/admin/content-gen/script-writer/validate-example
 *
 * If this returns { ok: true, errors: [] } then the schema + tool registry
 * agree on the example shape — proves the foundation works before we let
 * Gemini author one.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { EXAMPLE_SLOT_CHANNEL_PROOF_1 } from '@/lib/content-gen/concrete-script.example';
import { validateScript, resolveRef } from '@/lib/content-gen/concrete-script';
import { TOOL_NAMES } from '@/lib/content-gen/tools';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const errors = validateScript(EXAMPLE_SLOT_CHANNEL_PROOF_1);

  // Demonstrate ref interpolation with a synthetic gem-output bag.
  const bag = {
    niche_1_channel_proof_1: {
      narr: { file_url: 'https://example/tts.mp3', duration_s: 2.34, voice: 'money_groot' },
      main: { file_url: 'https://example/capture.png' },
      sfx:  { file_url: 'https://example/sfx.mp3', duration_s: 1.8 },
    },
  };
  const resolved = {
    'hold_s template':           resolveRef('{{narr.duration_s}}', bag, 'niche_1_channel_proof_1'),
    'cross-slot ref':            resolveRef('{{niche_1_channel_proof_1.main.file_url}}', bag),
    'malformed (returns input)': resolveRef('not a template', bag),
    'missing field (undefined)': resolveRef('{{narr.duration_minutes}}', bag, 'niche_1_channel_proof_1'),
  };

  return NextResponse.json({
    ok: errors.length === 0,
    errors,
    tool_count: TOOL_NAMES.length,
    tool_names: TOOL_NAMES,
    example: EXAMPLE_SLOT_CHANNEL_PROOF_1,
    interpolation: resolved,
  });
}
