/**
 * Cheap, deterministic English-only gate for the draft / hero candidate pool.
 *
 * DESIGN: we deliberately do NOT AI-analyze the ~60K-channel corpus — language
 * is only deep-analyzed (cga.language) for channels that actually reach the
 * prep/bake workflow (precisely-targeted, by design). That leaves the *draft*
 * pool showing not-yet-analyzed non-English channels. This gate closes that gap
 * with pure string heuristics over signals we already have on every candidate
 * (channel name + top video title + resolved niche label), applied only to the
 * ~topK candidates — zero AI cost, zero extra queries.
 *
 * It LAYERS ON TOP of the SQL cga.language filter in discovery (which stays
 * authoritative for analyzed channels). Conservative by intent: false negatives
 * are fine (cga catches them once the channel is prepped), but false positives
 * drop real English channels, so the token list only includes unambiguous
 * non-English markers. The niche label is included so an English-*named* but
 * foreign-*content* channel (e.g. a Spanish recap channel called "Cinema Flow"
 * sitting in a "película completa" niche) is still caught — while an English
 * recap channel in a "movie thriller english" niche is kept.
 */

// Non-Latin scripts → definitively not English.
const NON_LATIN =
  /[Ѐ-ӿ؀-ۿ܀-ݏऀ-ॿঀ-৿஀-௿฀-๿ᄀ-ᇿ぀-ヿ㐀-鿿가-힯֐-׿]/u;

// Vietnamese-specific Latin letters (đ + tone-marked vowels) — English never
// uses these. Also catch the Spanish ñ.
const VIETNAMESE =
  /[đĐăâêôơưĂÂÊÔƠƯ]|[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/iu;
const SPANISH_ENYE = /ñ/iu;

// Unambiguous non-English whole-word markers. Kept intentionally conservative
// (each word should essentially never appear in an English channel name/title/
// niche). Grouped by language for maintenance.
const FOREIGN_TOKENS = new Set<string>([
  // Spanish
  'película', 'pelicula', 'completa', 'completo', 'español', 'espanol',
  'capítulo', 'capitulo', 'subtitulado', 'doblada', 'doblaje', 'temporada',
  'viuda', 'esposa', 'muerte', 'niños', 'gratis',
  // Portuguese
  'dublado', 'legendado', 'português', 'portugues', 'brasil', 'dublagem',
  // Indonesian / Malay / Javanese
  'bahasa', 'indonesia', 'terbaru', 'kartun', 'anak', 'dengan', 'kisah',
  'cerita', 'sunda', 'jawa', 'musim', 'filem',
  // Vietnamese (romanized fallback if diacritics stripped)
  'tiếng', 'việt', 'tieng', 'viet', 'phim', 'tập', 'thuyết', 'truyện',
  // French
  'épisode', 'complet', 'français', 'saison', 'gratuit',
  // German
  'folge', 'ganzer', 'deutsch', 'staffel', 'kinderfilme',
  // Turkish
  'bölüm', 'türkçe', 'çizgi',
  // Hindi (romanized)
  'kahani',
]);

interface CandidateLike {
  channel_name?: string | null;
  top_video_title?: string | null;
  showcase_clusters?: {
    l1?: { cluster_label?: string | null } | null;
    l2?: { cluster_label?: string | null } | null;
  } | null;
}

function textOf(c: CandidateLike): string {
  const niche =
    c?.showcase_clusters?.l2?.cluster_label ??
    c?.showcase_clusters?.l1?.cluster_label ??
    '';
  return [c?.channel_name ?? '', c?.top_video_title ?? '', niche].join(' ');
}

/** Returns {drop:true, reason} for a candidate that is clearly non-English. */
export function isNonEnglishCandidate(c: CandidateLike): { drop: boolean; reason?: string } {
  const text = textOf(c);
  if (NON_LATIN.test(text)) return { drop: true, reason: 'non-latin-script' };
  if (VIETNAMESE.test(text)) return { drop: true, reason: 'vietnamese' };
  if (SPANISH_ENYE.test(text)) return { drop: true, reason: 'spanish-ñ' };
  const words = text.toLowerCase().normalize('NFC').split(/[^\p{L}]+/u).filter(Boolean);
  for (const w of words) {
    if (FOREIGN_TOKENS.has(w)) return { drop: true, reason: `foreign-token:${w}` };
  }
  return { drop: false };
}

/** Partition candidates into English-kept vs non-English-excluded. */
export function filterEnglishCandidates<T extends CandidateLike>(
  cands: T[],
): { kept: T[]; excluded: T[] } {
  const kept: T[] = [];
  const excluded: T[] = [];
  for (const c of cands) {
    if (isNonEnglishCandidate(c).drop) excluded.push(c);
    else kept.push(c);
  }
  return { kept, excluded };
}
