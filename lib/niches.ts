const NICHE_KEYWORDS: Record<string, string[]> = {
  Fitness: ['workout', 'gym', 'exercise', 'fitness', 'muscle', 'gains', 'bodybuilding', 'training', 'cardio', 'abs', 'weight loss', 'crossfit', 'yoga', 'stretching', 'calisthenics'],
  Comedy: ['funny', 'comedy', 'meme', 'joke', 'laugh', 'humor', 'prank', 'skit', 'parody', 'roast', 'stand up', 'hilarious', 'lol', 'fail'],
  Gaming: ['gaming', 'game', 'gamer', 'fortnite', 'minecraft', 'roblox', 'valorant', 'apex', 'cod', 'league', 'elden ring', 'playstation', 'xbox', 'nintendo', 'twitch', 'esport'],
  Beauty: ['makeup', 'beauty', 'skincare', 'cosmetic', 'foundation', 'lipstick', 'tutorial', 'glow', 'skin', 'acne', 'hair', 'nails', 'lashes', 'contour'],
  'Music/Dance': ['music', 'dance', 'song', 'sing', 'rapper', 'beat', 'remix', 'cover', 'lyrics', 'hip hop', 'choreography', 'dancing', 'dj', 'edm', 'guitar', 'piano', 'viral dance'],
  Food: ['food', 'cook', 'recipe', 'kitchen', 'chef', 'baking', 'meal', 'eat', 'restaurant', 'mukbang', 'asmr food', 'delicious', 'taste', 'cuisine'],
  Education: ['learn', 'education', 'science', 'math', 'history', 'fact', 'explain', 'study', 'teacher', 'school', 'university', 'tutorial', 'how to', 'did you know', 'psychology'],
  Lifestyle: ['lifestyle', 'vlog', 'day in', 'routine', 'morning', 'apartment', 'minimalist', 'aesthetic', 'productive', 'self care', 'cleaning', 'organize', 'life hack', 'diy'],
  Pets: ['pet', 'dog', 'cat', 'puppy', 'kitten', 'animal', 'cute', 'adorable', 'rescue', 'bird', 'hamster', 'fish', 'wildlife', 'zoo'],
  Sports: ['sport', 'basketball', 'football', 'soccer', 'baseball', 'nba', 'nfl', 'goal', 'highlight', 'athlete', 'boxing', 'mma', 'ufc', 'tennis', 'cricket'],
  Fashion: ['fashion', 'outfit', 'style', 'clothing', 'streetwear', 'dress', 'designer', 'thrift', 'haul', 'ootd', 'fit check', 'sneaker', 'drip'],
  Motivation: ['motivation', 'motivational', 'inspire', 'grind', 'hustle', 'success', 'mindset', 'discipline', 'sigma', 'alpha', 'stoic', 'quote', 'affirmation', 'self improvement'],
};

export function classifyNiche(titles: string[], channelName: string): string {
  const text = [...titles, channelName].join(' ').toLowerCase();
  let bestNiche = 'General';
  let bestScore = 0;

  for (const [niche, keywords] of Object.entries(NICHE_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestNiche = niche;
    }
  }

  return bestNiche;
}

export const NICHE_COLORS: Record<string, string> = {
  Fitness: 'bg-green-600',
  Comedy: 'bg-yellow-600',
  Gaming: 'bg-purple-600',
  Beauty: 'bg-pink-600',
  'Music/Dance': 'bg-indigo-600',
  Food: 'bg-orange-600',
  Education: 'bg-blue-600',
  Lifestyle: 'bg-teal-600',
  Pets: 'bg-amber-600',
  Sports: 'bg-red-600',
  Fashion: 'bg-fuchsia-600',
  Motivation: 'bg-cyan-600',
  General: 'bg-gray-600',
  Tech: 'bg-sky-600',
  Finance: 'bg-emerald-600',
  'True Crime': 'bg-rose-700',
  Horror: 'bg-slate-700',
  Satisfying: 'bg-violet-600',
  ASMR: 'bg-lime-600',
  Travel: 'bg-blue-500',
  DIY: 'bg-orange-700',
  Art: 'bg-pink-500',
};

export function getNicheColor(niche: string): string {
  return NICHE_COLORS[niche] || 'bg-gray-600';
}
