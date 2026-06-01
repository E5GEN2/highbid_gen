import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

/**
 * Vid Gen settings — single-row config for:
 *   - serve-time suffix          (suffix, suffix_enabled)
 *   - auto-refill of the queue   (auto_theme, auto_refill_enabled,
 *                                 auto_refill_threshold,
 *                                 auto_refill_target)
 *
 * GET  /api/admin/tools/vid-gen/settings
 * PUT  /api/admin/tools/vid-gen/settings   (any subset of fields)
 *
 * The auto-refill fields drive /api/video_prompt's lazy refill trigger:
 * each pop checks "if available < threshold, fire a background gen of
 * target prompts using auto_theme". One in-flight refill at a time.
 *
 * Auth: admin Bearer token.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_SUFFIX_LEN = 500;
const MAX_THEME_LEN  = 2000;
// Two-only allowlist for the target_model field. Keeps the public API
// surface predictable for clients consuming /api/video_prompt — they
// can switch-case on these two strings, no surprise values.
const TARGET_MODELS = ['veo-lite', 'veo-omni'] as const;
type TargetModel = typeof TARGET_MODELS[number];

interface SettingsRow {
  suffix: string;
  suffix_enabled: boolean;
  auto_theme: string;
  auto_refill_enabled: boolean;
  auto_refill_threshold: number;
  auto_refill_target: number;
  target_model: string;
  updated_at: string;
}

const FIELDS = `suffix, suffix_enabled, auto_theme, auto_refill_enabled, auto_refill_threshold, auto_refill_target, target_model, updated_at`;

function shape(s: SettingsRow) {
  return {
    suffix: s.suffix,
    suffixEnabled: s.suffix_enabled,
    autoTheme: s.auto_theme,
    autoRefillEnabled: s.auto_refill_enabled,
    autoRefillThreshold: s.auto_refill_threshold,
    autoRefillTarget: s.auto_refill_target,
    targetModel: s.target_model,
    updatedAt: s.updated_at,
  };
}

async function readSettings(): Promise<SettingsRow> {
  const pool = await getPool();
  const r = await pool.query<SettingsRow>(
    `INSERT INTO vid_gen_settings (id) VALUES (1)
       ON CONFLICT (id) DO UPDATE SET id = 1
       RETURNING ${FIELDS}`,
  );
  return r.rows[0];
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const s = await readSettings();
  return NextResponse.json({ ok: true, ...shape(s) });
}

export async function PUT(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as {
    suffix?: string; suffixEnabled?: boolean;
    autoTheme?: string; autoRefillEnabled?: boolean;
    autoRefillThreshold?: number; autoRefillTarget?: number;
    targetModel?: string;
  };

  const sets: string[] = [];
  const params: (string | boolean | number)[] = [];

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
  if (typeof body.autoTheme === 'string') {
    if (body.autoTheme.length > MAX_THEME_LEN) {
      return NextResponse.json({ error: `autoTheme exceeds ${MAX_THEME_LEN} chars` }, { status: 400 });
    }
    params.push(body.autoTheme);
    sets.push(`auto_theme = $${params.length}`);
  }
  if (typeof body.autoRefillEnabled === 'boolean') {
    params.push(body.autoRefillEnabled);
    sets.push(`auto_refill_enabled = $${params.length}`);
  }
  if (typeof body.autoRefillThreshold === 'number' && Number.isFinite(body.autoRefillThreshold)) {
    // Clamp to a sane range so a typo can't kill the system. 0 = never
    // refill (effectively disabled). 10_000 is a generous upper bound.
    const v = Math.max(0, Math.min(Math.floor(body.autoRefillThreshold), 10_000));
    params.push(v);
    sets.push(`auto_refill_threshold = $${params.length}`);
  }
  if (typeof body.autoRefillTarget === 'number' && Number.isFinite(body.autoRefillTarget)) {
    const v = Math.max(1, Math.min(Math.floor(body.autoRefillTarget), 1000));
    params.push(v);
    sets.push(`auto_refill_target = $${params.length}`);
  }
  if (typeof body.targetModel === 'string') {
    if (!(TARGET_MODELS as readonly string[]).includes(body.targetModel)) {
      return NextResponse.json({ error: `targetModel must be one of: ${TARGET_MODELS.join(', ')}` }, { status: 400 });
    }
    params.push(body.targetModel as TargetModel);
    sets.push(`target_model = $${params.length}`);
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: 'no recognised fields in body' }, { status: 400 });
  }
  sets.push(`updated_at = NOW()`);

  const pool = await getPool();
  await pool.query(`INSERT INTO vid_gen_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
  const r = await pool.query<SettingsRow>(
    `UPDATE vid_gen_settings SET ${sets.join(', ')} WHERE id = 1
       RETURNING ${FIELDS}`,
    params,
  );
  return NextResponse.json({ ok: true, ...shape(r.rows[0]) });
}
