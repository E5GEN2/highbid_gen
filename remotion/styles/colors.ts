export const NICHE_COLORS_HEX: Record<string, string> = {
  Fitness: '#16a34a',
  Comedy: '#ca8a04',
  Gaming: '#9333ea',
  Beauty: '#db2777',
  'Music/Dance': '#4f46e5',
  Food: '#ea580c',
  Education: '#2563eb',
  Lifestyle: '#0d9488',
  Pets: '#d97706',
  Sports: '#dc2626',
  Fashion: '#c026d3',
  Motivation: '#0891b2',
  General: '#4b5563',
  Tech: '#0284c7',
  Finance: '#059669',
  'True Crime': '#be123c',
  Horror: '#334155',
  Satisfying: '#7c3aed',
  ASMR: '#65a30d',
  Travel: '#3b82f6',
  DIY: '#c2410c',
  Art: '#ec4899',
};

export function getNicheColorHex(niche: string): string {
  return NICHE_COLORS_HEX[niche] || '#4b5563';
}

export const GRADIENT_BG = {
  start: '#1a1a2e',
  mid: '#16213e',
  end: '#0f3460',
};

export const ACCENT = {
  purple: '#9333ea',
  pink: '#ec4899',
  blue: '#3b82f6',
  gold: '#f59e0b',
};

export const TEXT = {
  primary: '#ffffff',
  secondary: '#9ca3af',
  muted: '#6b7280',
  accent: '#a78bfa',
};
