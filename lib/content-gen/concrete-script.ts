/**
 * Concrete script — the producer-ready, tool-call-annotated form of a video.
 *
 * Shape:
 *   ConcreteScript
 *     ├─ context: { channelId, channel_name, niche_index, video_id }
 *     ├─ slots:   [Slot, Slot, ...]    // in playback order
 *     │      ├─ slot_id:   "channel.subscribers.hero"
 *     │      ├─ beat_id:   "channel_proof_1"        // ties back to skeleton
 *     │      ├─ narration: string                   // text being voiced (or "")
 *     │      ├─ gems:      [Gem, Gem, ...]         // tool calls
 *     │      │      ├─ id:    "narr"
 *     │      │      ├─ tool:  "tts" | "yt_capture" | ...
 *     │      │      └─ args:  { ... }
 *     │      └─ compose:   { bg, hold_s, layers }
 *     └─ final: { tool: "video_compose", args: {...} }
 *
 * Refs:
 *   compose fields can interpolate gem outputs with `{{gem_id.field}}`. The
 *   producer resolves those AFTER running the referenced gem. So
 *     hold_s: "{{narr.duration_s}}"
 *   means "hold this slot for as long as the TTS audio plays" — duration is
 *   only known after TTS runs.
 *
 * Refs can also reach across slots with `{{slot_id.gem_id.field}}` syntax
 *   — used by video_compose (`final`) to pull every gem URL.
 *
 * This file is PURE schema + validation — no execution. The producer
 * (separate module) consumes the validated script and runs it.
 */

import { TOOL_NAMES, TOOLS_BY_NAME } from './tools';

// ───────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────

/** One tool invocation within a slot. The result is referenced as
 *  `{{<id>.<field>}}` in compose blocks. */
export interface Gem {
  id: string;             // unique within the slot, e.g. "narr", "main", "sfx"
  tool: string;           // one of TOOL_NAMES
  args: Record<string, unknown>;
}

/** Compose spec — declarative description of how the slot's visual is built.
 *  Fields can hold `{{ref}}` placeholders that resolve after upstream gems run. */
export interface Compose {
  bg: 'white' | 'dark_gray';
  /** Number OR `"{{gem.duration_s}}"` template. */
  hold_s: number | string;
  layers: ComposeLayer[];
}

export interface ComposeLayer {
  /** "main" | "narr" | "sfx" — referencing a gem id in this slot OR a cross-
   *  slot ref like `other_slot.main`. */
  from: string;
  /** Where this layer goes — voice / fx / video / overlay. Compositor knows. */
  channel?: 'video' | 'voice' | 'fx' | 'overlay';
  /** Visual fit when channel=video */
  fit?: 'contain' | 'cover' | 'fill';
  /** Camera move applied during the hold */
  ken_burns?: 'none' | 'zoom_in_8pct' | 'zoom_out_8pct' | 'pan_left' | 'pan_right';
  /** When channel=overlay, position the layer over the main video */
  position?: { x: number | string; y: number | string; w: number | string; h: number | string };
}

export interface Slot {
  slot_id: string;
  /** Skeleton beat id (channel_proof_1, money_math, etc.) — variation tracking. */
  beat_id: string;
  /** Canonical data-point id from data-points.json (e.g. "channel.subscribers",
   *  "money.lump_sum"). The slot-rendering grammar is keyed on this — visual
   *  recipes look up `slot_renderings[data_point_id]` to drive bg_mode +
   *  primitive choice. Optional for purely structural beats (intro_card,
   *  transitions). */
  data_point_id?: string;
  /** When a beat expands to a sequence (money_math 4-6 cards, top_views_seq
   *  3-5 phrases, money.yearly 3 cards), this is the 0-based position within
   *  the sequence. Omit for single-card beats. */
  card_index?: number;
  narration?: string;       // empty for silent_visual beats
  gems: Gem[];
  compose: Compose;
}

export interface ConcreteScript {
  schema_version: '1';
  context: {
    channelId: string;
    channel_name?: string;
    niche_index?: number;
    video_id?: string;       // unique id of this generated video
  };
  /** Slots in playback order. */
  slots: Slot[];
  /** The final compose step — references all upstream slot gems via
   *  `{{slot_id.gem_id.field}}` interpolation. */
  final: {
    tool: 'video_compose';
    args: Record<string, unknown>;
  };
}

// ───────────────────────────────────────────────────────────────────
// Validation
// ───────────────────────────────────────────────────────────────────

export interface ValidationError {
  path: string;             // dotted path: slots[0].gems[1].args.kind
  message: string;
}

/** Validate a script against the schema + tool registry. Returns the list of
 *  errors (empty if valid). Does NOT execute or resolve refs — that's the
 *  producer's job. */
export function validateScript(s: ConcreteScript): ValidationError[] {
  const errs: ValidationError[] = [];
  if (s.schema_version !== '1') errs.push({ path: 'schema_version', message: 'expected "1"' });
  if (!s.context?.channelId) errs.push({ path: 'context.channelId', message: 'required' });
  if (!Array.isArray(s.slots) || s.slots.length === 0) {
    errs.push({ path: 'slots', message: 'must be a non-empty array' });
    return errs;
  }
  const slotIds = new Set<string>();
  s.slots.forEach((slot, i) => {
    const base = `slots[${i}]`;
    if (!slot.slot_id) errs.push({ path: `${base}.slot_id`, message: 'required' });
    else if (slot.slot_id.includes('.')) errs.push({ path: `${base}.slot_id`, message: `must NOT contain "." (use _ instead) — got "${slot.slot_id}"` });
    if (slotIds.has(slot.slot_id)) errs.push({ path: `${base}.slot_id`, message: `duplicate slot_id "${slot.slot_id}"` });
    slotIds.add(slot.slot_id);
    if (!slot.beat_id) errs.push({ path: `${base}.beat_id`, message: 'required' });
    if (!Array.isArray(slot.gems)) {
      errs.push({ path: `${base}.gems`, message: 'must be an array' });
      return;
    }
    const gemIds = new Set<string>();
    slot.gems.forEach((g, j) => {
      const gbase = `${base}.gems[${j}]`;
      if (!g.id) errs.push({ path: `${gbase}.id`, message: 'required' });
      if (gemIds.has(g.id)) errs.push({ path: `${gbase}.id`, message: `duplicate gem id "${g.id}" in slot` });
      gemIds.add(g.id);
      if (!TOOL_NAMES.includes(g.tool)) {
        errs.push({ path: `${gbase}.tool`, message: `unknown tool "${g.tool}" — valid: ${TOOL_NAMES.join(', ')}` });
        return;
      }
      const spec = TOOLS_BY_NAME[g.tool];
      // Walk required + check unknown fields. We don't fully validate types
      // here (Gemini's output should match the JSON schema we inlined in the
      // writer prompt); this is just the structural belt-and-suspenders.
      const reqs = (spec.args_schema as { required?: string[] }).required ?? [];
      const props = (spec.args_schema as { properties?: Record<string, unknown>; additionalProperties?: boolean }).properties ?? {};
      for (const r of reqs) {
        if (!(r in g.args)) errs.push({ path: `${gbase}.args.${r}`, message: `required for tool ${g.tool}` });
      }
      const additionalAllowed = (spec.args_schema as { additionalProperties?: boolean }).additionalProperties !== false;
      if (!additionalAllowed) {
        for (const k of Object.keys(g.args)) {
          if (!(k in props)) errs.push({ path: `${gbase}.args.${k}`, message: `unknown field for tool ${g.tool}` });
        }
      }
    });

    // Compose checks
    if (!slot.compose) {
      errs.push({ path: `${base}.compose`, message: 'required' });
      return;
    }
    if (!['white', 'dark_gray'].includes(slot.compose.bg)) {
      errs.push({ path: `${base}.compose.bg`, message: 'must be "white" or "dark_gray"' });
    }
    // hold_s: number OR a template
    const h = slot.compose.hold_s;
    if (typeof h !== 'number' && typeof h !== 'string') {
      errs.push({ path: `${base}.compose.hold_s`, message: 'must be number or "{{ref}}" template' });
    }
    if (typeof h === 'string' && !/^\{\{[^{}]+\}\}$/.test(h)) {
      errs.push({ path: `${base}.compose.hold_s`, message: 'string hold_s must be exactly "{{ref}}"' });
    }
    if (!Array.isArray(slot.compose.layers) || slot.compose.layers.length === 0) {
      errs.push({ path: `${base}.compose.layers`, message: 'must be a non-empty array' });
    } else {
      // Cross-check: every layer.from must reference a known gem id in THIS
      // slot, OR a cross-slot ref `other_slot.gem_id`.
      slot.compose.layers.forEach((layer, k) => {
        const lbase = `${base}.compose.layers[${k}]`;
        if (!layer.from) errs.push({ path: `${lbase}.from`, message: 'required' });
        else if (!layer.from.includes('.')) {
          if (!gemIds.has(layer.from)) errs.push({ path: `${lbase}.from`, message: `gem id "${layer.from}" not declared in this slot` });
        }
        // cross-slot refs aren't validated here (depends on order) — that's
        // a runtime concern in the producer.
      });
    }
  });

  // Final assembly check
  if (!s.final) errs.push({ path: 'final', message: 'required' });
  else if (s.final.tool !== 'video_compose') {
    errs.push({ path: 'final.tool', message: 'must be "video_compose"' });
  }

  return errs;
}

/** Throws on validation failure with a flat error message. Convenience wrapper. */
export function assertValidScript(s: ConcreteScript): void {
  const errs = validateScript(s);
  if (errs.length > 0) {
    const lines = errs.map(e => `  - ${e.path}: ${e.message}`).join('\n');
    throw new Error(`Concrete script invalid (${errs.length} error${errs.length === 1 ? '' : 's'}):\n${lines}`);
  }
}

// ───────────────────────────────────────────────────────────────────
// Ref interpolation (used by the producer at runtime)
// ───────────────────────────────────────────────────────────────────

/** Resolve a single `{{a.b.c}}` placeholder against a gem-output bag.
 *  bag is keyed by `slot_id.gem_id.field` — single dotted path lookup.
 *  When the ref is local (no slot prefix), the producer passes a `local` arg
 *  that lets `{{narr.duration_s}}` find `bag[currentSlotId].narr.duration_s`. */
export function resolveRef(template: string, bag: Record<string, unknown>, localSlotId?: string): unknown {
  const m = template.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
  if (!m) return template;
  let key = m[1];
  // Local ref expansion: "narr.duration_s" → "{slot}.narr.duration_s"
  if (localSlotId && key.split('.').length === 2) {
    key = `${localSlotId}.${key}`;
  }
  // Walk dotted path through the bag
  const parts = key.split('.');
  let cur: unknown = bag;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}
