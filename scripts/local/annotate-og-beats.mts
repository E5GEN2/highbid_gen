process.env.DATABASE_URL = 'postgresql://localhost:5432/hbgen_local';
process.env.PGSSLMODE = 'disable';
const { getPool } = await import('/Users/rofe/Desktop/lab/hbgen/highbid_gen/lib/db');
import { writeFileSync } from 'fs';
const pool = await getPool();
const r = await pool.query(`SELECT timeline_jsonb FROM video_analysis_jobs WHERE id=1`);
const segs = r.rows[0].timeline_jsonb.segments as Array<{start:number; end:number; speech_transcription?:string; visual_description?:string}>;
const condensed = segs.map(s =>
  `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] SAY: ${(s.speech_transcription??'').trim()} | SEE: ${(s.visual_description??'').slice(0,110)}`
).join('\n');

const key = (await pool.query(`SELECT key FROM xgodo_api_keys WHERE service='google_ai_studio' AND status='active' AND (banned_until IS NULL OR banned_until < NOW()) ORDER BY RANDOM() LIMIT 1`)).rows[0]?.key;
const prompt = `You are mapping a YouTube listicle video onto a beat taxonomy. Below is its full second-by-second transcript (speech + visuals). Segment the ENTIRE video [0..844s] into contiguous beat spans.

BEAT TAXONOMY (use EXACTLY these ids):
- intro_card — "Number N" announcement card
- niche_name_card — the niche name card
- mascot_mosaic — grid/mosaic of many figures/images (abundance visual)
- channel_intro — channel banner/chip first reveal
- channel_page_full — full channel page or videos-grid view
- channel_proof_1 — subscriber-count stat callout (About panel/highlight)
- channel_proof_2 — total views / channel age stat callout
- top_views_rapid — rapid sequence of single video cards with view counts
- top_videos_pano — grid of many video thumbnails
- top_video_callout — single most-popular-video highlight
- money_math — RPM/earnings calculation cards ($ figures)
- recipe_demo — gameplay/content clips in mini-player while explaining how videos are made
- channel_b_proof — a SECOND channel shown in the same niche
- saturation_callout — "many channels doing this" montage
- concept_tag — chalkboard/concept word card
- appreciation — "thanks for watching this far"
- tool_plug — plugging a tool/resource channel (e.g. NoCopyrightSounds)
- personal_demo — creator's own demo/experiment
- tips — numbered tips/advice digression
- transition — connective beat between niches
- video_cta — end CTA (subscribe/next video)

Label per-niche beats as "niche_{N}_{beat_id}" (e.g. "niche_3_money_math"); video-level ones plain (e.g. "video_cta"). Spans should be beat-level (typically 2-20s each), contiguous, covering 0 to 844.

Output ONLY JSON: {"spans":[{"s":0.0,"e":1.4,"label":"niche_1_intro_card"},...]}

TRANSCRIPT:
${condensed}`;

const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.1, maxOutputTokens:16000, responseMimeType:'application/json', thinkingConfig:{thinkingBudget:0}} }),
  signal: AbortSignal.timeout(180000),
});
const data = await res.json();
const text = data?.candidates?.[0]?.content?.parts?.map((p:any)=>p.text).join('') ?? '';
writeFileSync('/tmp/mg-beat-spans.json', text);
const parsed = JSON.parse(text);
console.log('spans:', parsed.spans.length, 'coverage:', parsed.spans[0].s, '→', parsed.spans[parsed.spans.length-1].e);
process.exit(0);

// NOTE: after running this (writes /tmp/mg-beat-spans.json), build + burn:
//   python3 <ass-builder>  (see git history / docs/content-gen/mg-og-beat-spans.json)
//   ffmpeg -i clips/video_src/MG-OG.mp4 -vf "ass=/tmp/mg-beats.ass" \
//     -c:v libx264 -crf 20 -preset veryfast -c:a copy clips/MG-OG-beat-labeled.mp4
