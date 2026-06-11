# MG Anchor Render — job 142 (2026-06-11)

Our pipeline re-rendering MG's "11 Hidden Faceless YouTube Niches
Explained" (videoId 14563 / youtu.be/qLeWyKufd8M) — same 11 niches, same
hero channels, MG's spoken niche names, TODAY's live data, every beat
labeled (--labels). 547s, 603/603 gems, zero failures.

Local file: clips/producer_renders/job-142-1781190214236.mp4

| t (ours) | niche | hero channel | MG original t≈ |
|---|---|---|---|
| 0:01 | Funny Stickman Fails | VES STICK (498K subs, was 437K in MG) | 0:00 |
| 0:51 | Roblox Lore Explained | Callon | 1:57 |
| 1:42 | Absurd Ranking | Doodle Digest | 2:50 |
| 2:32 | Scene Analysis | TV Junkie | 4:04 |
| 3:15 | Meme Explained Channels | Lessons in Meme Culture | ~6:00 |
| 4:09 | Personality Quizzes | Quizetta | ~7:30 |
| 4:54 | Horror Explained | I'm Not a Robot | ~8:40 |
| 5:42 | AI Game Development | Minimunch | ~9:50 |
| 6:29 | True Horror Stories | Mr. Nightmare | ~10:50 |
| 7:14 | Data Map Visuals | Horizon Analytics | ~11:50 |
| 8:05 | Strange Animal Facts | Mr. Science | ~12:50 |
| 8:57 | CTA ("So, these are the eleven faceless niches.") | — | 13:44 |

How it was built: MG's own transcript (video_analysis_jobs id=1, 454
segments) → Gemini extraction of niches+handles → YT API (key-proxy
pairs) seeded the 11 channels + top-8 videos each → MG's niche names
seeded as content_gen_channel_analysis.niche_label → from-channels
render with --labels.

Known degradations in this pass: no recipe_demo b-roll (the 11 channels
have no transcripts yet — enqueue video-analysis for them to unlock),
recipe intro line falls back to the generic ("Take a look at this
channel."), no music bed (audio-floor work pending).
