/**
 * Canonical icon library for the icon_card composition.
 *
 * Per visual-packaging-class-b.json, the spec lists 9 icon ids:
 *   shrug_with_question_marks  — uncertainty / assumption ("$1 RPM" reveal)
 *   pointing_hand              — callout / direction
 *   checkmark_green_circle     — affirmation / confirmation
 *   dollar_sign_green_circle   — money tag / accent
 *   cat_thumbs_up              — appreciation / outro
 *   speaker_muted              — silence / "no sound"
 *   speaker_with_sound_waves   — voice / audio active
 *   shrug_emoji                — generic shrug (smaller than full body)
 *   cash_pile                  — windfall / stack of money
 *
 * Each icon returns an SVG <g> element designed to fit a 200×200 viewBox
 * centered around (100, 100). The caller scales + positions it via outer
 * <g transform="translate(...) scale(...)">.
 *
 * These are deliberate stick-figure / line-art approximations — fast to
 * read at a glance, not pixel-perfect renditions of any particular asset.
 */

export type IconId =
  | 'shrug_with_question_marks'
  | 'pointing_hand'
  | 'checkmark_green_circle'
  | 'dollar_sign_green_circle'
  | 'cat_thumbs_up'
  | 'speaker_muted'
  | 'speaker_with_sound_waves'
  | 'shrug_emoji'
  | 'cash_pile';

/** Build the inner SVG for an icon. `stroke` is the line color; `accent`
 *  is the secondary fill (green for money icons, gray for neutral). */
export function buildIconInnerSvg(
  id: IconId,
  stroke = '#111111',
  accent = '#22C55E',
): string {
  switch (id) {
    case 'shrug_with_question_marks':
      // Stick figure with both arms raised in a shrug + ? marks floating above
      return `
        <!-- head -->
        <circle cx="100" cy="55" r="22" fill="none" stroke="${stroke}" stroke-width="6"/>
        <!-- two dot eyes -->
        <circle cx="92" cy="53" r="2.5" fill="${stroke}"/>
        <circle cx="108" cy="53" r="2.5" fill="${stroke}"/>
        <!-- flat mouth -->
        <line x1="92" y1="65" x2="108" y2="65" stroke="${stroke}" stroke-width="3" stroke-linecap="round"/>
        <!-- torso -->
        <line x1="100" y1="78" x2="100" y2="140" stroke="${stroke}" stroke-width="6" stroke-linecap="round"/>
        <!-- shrugging arms (up) -->
        <path d="M 100 90 L 65 70 L 55 50" fill="none" stroke="${stroke}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M 100 90 L 135 70 L 145 50" fill="none" stroke="${stroke}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
        <!-- legs -->
        <line x1="100" y1="140" x2="80" y2="180" stroke="${stroke}" stroke-width="6" stroke-linecap="round"/>
        <line x1="100" y1="140" x2="120" y2="180" stroke="${stroke}" stroke-width="6" stroke-linecap="round"/>
        <!-- question marks floating above -->
        <text x="50" y="35" font-family="system-ui, sans-serif" font-size="38" font-weight="800" fill="${stroke}">?</text>
        <text x="148" y="30" font-family="system-ui, sans-serif" font-size="34" font-weight="800" fill="${stroke}">?</text>
      `;
    case 'pointing_hand':
      // Stylized index-finger pointing right (or left depending on caller)
      return `
        <!-- palm -->
        <path d="M 60 90 Q 60 70 80 70 L 110 70 L 110 50 Q 110 35 125 35 Q 140 35 140 50 L 140 100
                 L 155 100 Q 165 100 165 110 L 165 130 Q 165 150 145 150 L 80 150 Q 60 150 60 130 Z"
              fill="none" stroke="${stroke}" stroke-width="6" stroke-linejoin="round"/>
        <!-- thumb -->
        <path d="M 60 95 Q 45 95 45 110 Q 45 125 60 125" fill="none" stroke="${stroke}" stroke-width="6" stroke-linejoin="round"/>
      `;
    case 'checkmark_green_circle':
      return `
        <circle cx="100" cy="100" r="74" fill="${accent}"/>
        <path d="M 65 102 L 92 130 L 142 76" fill="none" stroke="#FFFFFF" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
      `;
    case 'dollar_sign_green_circle':
      return `
        <circle cx="100" cy="100" r="74" fill="${accent}"/>
        <text x="100" y="132" font-family="system-ui, -apple-system, sans-serif" font-size="106" font-weight="900" fill="#FFFFFF" text-anchor="middle">$</text>
      `;
    case 'cat_thumbs_up':
      // Cat head with paw-up thumb gesture (simplified)
      return `
        <!-- ears -->
        <polygon points="58,55 78,30 88,60" fill="${stroke}"/>
        <polygon points="142,55 122,30 112,60" fill="${stroke}"/>
        <!-- head -->
        <circle cx="100" cy="85" r="42" fill="none" stroke="${stroke}" stroke-width="6"/>
        <!-- eyes (closed/happy ^_^) -->
        <path d="M 84 80 Q 88 75 92 80" fill="none" stroke="${stroke}" stroke-width="4" stroke-linecap="round"/>
        <path d="M 108 80 Q 112 75 116 80" fill="none" stroke="${stroke}" stroke-width="4" stroke-linecap="round"/>
        <!-- nose -->
        <polygon points="98,90 102,90 100,94" fill="${stroke}"/>
        <!-- smile -->
        <path d="M 90 100 Q 100 108 110 100" fill="none" stroke="${stroke}" stroke-width="4" stroke-linecap="round"/>
        <!-- whiskers -->
        <line x1="55" y1="92" x2="80" y2="92" stroke="${stroke}" stroke-width="2"/>
        <line x1="55" y1="100" x2="80" y2="100" stroke="${stroke}" stroke-width="2"/>
        <line x1="120" y1="92" x2="145" y2="92" stroke="${stroke}" stroke-width="2"/>
        <line x1="120" y1="100" x2="145" y2="100" stroke="${stroke}" stroke-width="2"/>
        <!-- paw with thumb up -->
        <circle cx="155" cy="155" r="18" fill="none" stroke="${stroke}" stroke-width="6"/>
        <line x1="155" y1="135" x2="155" y2="118" stroke="${stroke}" stroke-width="6" stroke-linecap="round"/>
      `;
    case 'speaker_muted':
      return `
        <!-- speaker body -->
        <polygon points="40,80 75,80 110,55 110,145 75,120 40,120" fill="none" stroke="${stroke}" stroke-width="6" stroke-linejoin="round"/>
        <!-- X over speaker -->
        <line x1="135" y1="75" x2="170" y2="125" stroke="${stroke}" stroke-width="6" stroke-linecap="round"/>
        <line x1="170" y1="75" x2="135" y2="125" stroke="${stroke}" stroke-width="6" stroke-linecap="round"/>
      `;
    case 'speaker_with_sound_waves':
      return `
        <polygon points="40,80 75,80 110,55 110,145 75,120 40,120" fill="none" stroke="${stroke}" stroke-width="6" stroke-linejoin="round"/>
        <path d="M 125 75 Q 145 100 125 125" fill="none" stroke="${stroke}" stroke-width="6" stroke-linecap="round"/>
        <path d="M 145 60 Q 175 100 145 140" fill="none" stroke="${stroke}" stroke-width="6" stroke-linecap="round"/>
      `;
    case 'shrug_emoji':
      // Just the head + raised arms — compact version
      return `
        <circle cx="100" cy="80" r="32" fill="none" stroke="${stroke}" stroke-width="6"/>
        <circle cx="90" cy="78" r="3" fill="${stroke}"/>
        <circle cx="110" cy="78" r="3" fill="${stroke}"/>
        <path d="M 88 95 Q 100 102 112 95" fill="none" stroke="${stroke}" stroke-width="4" stroke-linecap="round"/>
        <path d="M 100 115 Q 60 110 50 70" fill="none" stroke="${stroke}" stroke-width="6" stroke-linecap="round"/>
        <path d="M 100 115 Q 140 110 150 70" fill="none" stroke="${stroke}" stroke-width="6" stroke-linecap="round"/>
      `;
    case 'cash_pile':
      // Stack of 3 bills with $ on top
      return `
        <!-- bottom bill -->
        <rect x="35" y="120" width="130" height="38" rx="4" fill="${accent}" stroke="${stroke}" stroke-width="4"/>
        <!-- middle bill (slight offset) -->
        <rect x="30" y="92" width="140" height="38" rx="4" fill="${accent}" stroke="${stroke}" stroke-width="4"/>
        <!-- top bill -->
        <rect x="40" y="62" width="120" height="38" rx="4" fill="${accent}" stroke="${stroke}" stroke-width="4"/>
        <!-- $ sign on top bill -->
        <text x="100" y="90" font-family="system-ui, sans-serif" font-size="28" font-weight="900" fill="#FFFFFF" text-anchor="middle">$</text>
        <!-- $ on middle (faded) -->
        <text x="100" y="118" font-family="system-ui, sans-serif" font-size="22" font-weight="800" fill="#FFFFFF" text-anchor="middle" opacity="0.7">$</text>
      `;
    default:
      return `
        <circle cx="100" cy="100" r="60" fill="none" stroke="${stroke}" stroke-width="6"/>
        <text x="100" y="115" font-family="system-ui, sans-serif" font-size="48" font-weight="700"
              fill="${stroke}" text-anchor="middle">?</text>
      `;
  }
}

/** Render a single SVG <g> for the icon at (cx, cy) with the given size
 *  (200 = native size). */
export function iconSvgAt(id: IconId, cx: number, cy: number, size = 240, stroke = '#111111', accent = '#22C55E'): string {
  const scale = size / 200;
  const tx = cx - size / 2;
  const ty = cy - size / 2;
  return `<g transform="translate(${tx}, ${ty}) scale(${scale})">${buildIconInnerSvg(id, stroke, accent)}</g>`;
}
