/**
 * English-only gate for the draft / hero candidate pool.
 *
 * DESIGN: we deliberately do NOT AI-analyze the ~60K-channel corpus — language
 * is only deep-analyzed (cga.language) for channels that reach the prep/bake
 * workflow. That leaves the *draft* pool showing not-yet-analyzed non-English
 * channels. This gate closes the gap with two cheap, no-AI passes over the
 * ~topK candidates:
 *
 *   1. Heuristic (fast, precise, NAME-based): non-Latin scripts, Vietnamese
 *      diacritics, Spanish ñ, and an unambiguous foreign-token list. Catches
 *      channels whose NAME betrays the language even when their titles read as
 *      English (e.g. "Drama Deewana Hindi", "Leyendas Del Ring").
 *
 *   2. franc statistical detection (CONTENT-based): franc over the channel's
 *      top ~12 video titles. One title is too short/noisy for franc (it
 *      mislabels English as Scots/etc.), but ~12 concatenated titles are
 *      reliable. We treat 'sco' (Scots) as English — it's franc's most common
 *      false label for English — and 'und' (undetermined → too short) as keep.
 *      Drop only when franc confidently reports some other language.
 *
 * Layers on top of the SQL cga.language filter (authoritative once a channel is
 * prepped). Calibrated on a live batch: 0 English false-drops, catches Spanish/
 * Hindi/German/Bosnian/etc. content channels the token list alone misses.
 */
import { getPool } from '@/lib/db';

// Non-Latin scripts → definitively not English.
const NON_LATIN =
  /[Ѐ-ӿ؀-ۿ܀-ݏऀ-ॿঀ-৿஀-௿฀-๿ᄀ-ᇿ぀-ヿ㐀-鿿가-힯֐-׿]/u;

// Vietnamese-specific Latin letters (đ + tone-marked vowels); plus Spanish ñ.
const VIETNAMESE =
  /[đĐăâêôơưĂÂÊÔƠƯ]|[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/iu;
const SPANISH_ENYE = /ñ/iu;

// Unambiguous non-English whole-word markers, incl. name-based ones franc can
// miss when a channel posts English-ish titles for non-English content.
const FOREIGN_TOKENS = new Set<string>([
  // Spanish
  'película', 'pelicula', 'completa', 'completo', 'español', 'espanol',
  'capítulo', 'capitulo', 'subtitulado', 'doblada', 'doblaje', 'temporada',
  'viuda', 'esposa', 'muerte', 'niños', 'gratis', 'leyendas', 'pantalla', 'desierto',
  // Portuguese
  'dublado', 'legendado', 'português', 'portugues', 'brasil', 'dublagem',
  // Indonesian / Malay / Javanese
  'bahasa', 'indonesia', 'terbaru', 'kartun', 'anak', 'dengan', 'kisah',
  'cerita', 'sunda', 'jawa', 'musim', 'filem',
  // Vietnamese (romanized fallback)
  'tiếng', 'việt', 'tieng', 'viet', 'phim', 'tập', 'thuyết', 'truyện',
  // French
  'épisode', 'complet', 'français', 'saison', 'gratuit',
  // German
  'folge', 'ganzer', 'deutsch', 'staffel', 'kinderfilme',
  // Turkish
  'bölüm', 'türkçe', 'çizgi',
  // Hindi / South Asian (romanized)
  'hindi', 'deewana', 'bolta', 'bhabhi', 'kahani', 'bollywood', 'desi',
  // Bosnian / Croatian / Serbian
  'bosanskom', 'hrvatski', 'srpski', 'crtani',
]);

// franc ISO 639-3 codes we treat as English: 'eng', plus 'sco' (Scots — franc's
// most frequent false label for English text) and 'und' (undetermined = too
// short to judge → keep and let the heuristic / cga decide).
const ENGLISH_ISO = new Set(['eng', 'sco', 'und']);

interface CandidateLike {
  channel_id?: string | null;
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

/** Fast, precise heuristic pass — returns {drop:true} for clearly non-English. */
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

// Lazily load franc (ESM-only). Cached across calls.
let _franc: ((text: string, opts?: { minLength?: number }) => string) | null = null;
async function getFranc(): Promise<typeof _franc> {
  if (!_franc) {
    try { _franc = (await import('franc')).franc; } catch { _franc = null; }
  }
  return _franc;
}

/** Pull up to 12 top-by-views titles per candidate channel (one query). */
async function fetchTitlesByChannel(channelIds: string[]): Promise<Map<string, string>> {
  if (!channelIds.length) return new Map();
  const pool = await getPool();
  const r = await pool.query<{ channel_id: string; titles: string }>(
    `SELECT channel_id, string_agg(title, ' | ') AS titles
       FROM (
         SELECT channel_id, title,
                ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY view_count DESC NULLS LAST) rn
           FROM niche_spy_videos
          WHERE channel_id = ANY($1::text[]) AND title IS NOT NULL
       ) x
      WHERE rn <= 12
      GROUP BY channel_id`,
    [channelIds],
  );
  return new Map(r.rows.map(row => [row.channel_id, row.titles]));
}

/**
 * Partition candidates into English-kept vs non-English-excluded, using the
 * heuristic pass then franc over ~12 titles. Async (queries titles + loads
 * franc). Falls back to heuristic-only if franc/titles are unavailable.
 */
export async function filterEnglishCandidates<T extends CandidateLike>(
  cands: T[],
): Promise<{ kept: T[]; excluded: T[]; reasons: Record<string, string> }> {
  const kept: T[] = [];
  const excluded: T[] = [];
  const reasons: Record<string, string> = {};

  const titles = await fetchTitlesByChannel(
    cands.map(c => c.channel_id).filter((x): x is string => !!x),
  ).catch(() => new Map<string, string>());
  const franc = await getFranc();

  for (const c of cands) {
    const key = c.channel_id || c.channel_name || '?';
    const h = isNonEnglishCandidate(c);
    if (h.drop) {
      excluded.push(c);
      reasons[key] = h.reason!;
      continue;
    }
    if (franc) {
      const text =
        (c.channel_id ? titles.get(c.channel_id) : '') ||
        [c.channel_name, c.top_video_title].filter(Boolean).join(' ');
      if (text && text.length >= 12) {
        const lang = franc(text, { minLength: 12 });
        if (!ENGLISH_ISO.has(lang)) {
          excluded.push(c);
          reasons[key] = `franc:${lang}`;
          continue;
        }
      }
    }
    kept.push(c);
  }
  return { kept, excluded, reasons };
}
