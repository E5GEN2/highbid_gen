# Single-channel beat plan — implementation blueprint (2026-06-11)

Goal: one channel's niche segment renders the FULL skeleton beat sequence with
template-faithful narration, so the 10-channel listicle is just N of these
plus framing. Ground rules: build + verify each step in the LOCAL loop
(`render.mts from-channels <UC..> niche_segment_3 --local`, ~2 min/iteration)
before anything ships to Railway.

## Canonical references (read these before changing narration)

| What | Where |
|---|---|
| Per-niche template (the product of the 300+ transcript job) | `docs/content-gen/worked-example-mg-reverse-engineered.md` — THE source of truth for narration lines, banks, variable shapes, fluff exclusions |
| Beat list + recipes + holds | `docs/content-gen/script-skeleton-class-b.{md,json}` (`beats_per_niche`, `pacing_constraints`, `meta_prompt_assembly`) |
| Visual treatment per beat | `docs/content-gen/slot-rendering-class-b.{md,json}` |
| Audio rules (music rotation, ducking, diegetic) | `docs/content-gen/audio-sfx-class-b.{md,json}` |
| Data points + multipliers | `docs/content-gen/data-points.{md,json}` |
| Decoded reference timeline (336 cuts) | `docs/content-gen/mg-decoded-visual-timeline.json` |
| Verified gap matrix | `docs/content-gen/realign-2026-06-11.md` + `audit-2026-06-11-*.md` |

## Data sources (ALL mirrored locally in hbgen_local as of 2026-06-11)

| Variable (worked-example table) | Source |
|---|---|
| `recipe_formula_simplified` | `content_gen_channel_analysis.recipe_formula` (verbose — needs one-clause simplification; fallback `content_gen_recipe_showcase.recipe_summary`) |
| `recipe_extras` / recipe_demo beats | `content_gen_recipe_showcase.beats_jsonb` — paired `{narration, clip_start, clip_end, shows, source_video_url}`; 8/10 draft channels, 4–6 beats each |
| `rpm` | `content_gen_channel_rpm.rpm_typical` (+`rpm_low/high`, `geo_guess`, `reasoning`); 8/10 channels |
| `subs / video_count / total_views / published_at` | `niche_spy_channels` (already consumed by `loadChannel`, listicle-builder.ts:28) |
| `top_video_views[0..2]` | `niche_spy_videos` (already queried in `buildTopViewsRapidFireSlots`) |
| `median_views_phrase` | `SELECT percentile_cont(0.5) ... FROM niche_spy_videos WHERE channel_id=$1` → humanize class |
| `age_phrase` | `niche_spy_channels.published_at` → reuse `relativeAge()` (listicle-builder.ts:347) |
| `upload_rate` | `video_count / months_since(published_at)` |
| `geo_hint` | `channel_rpm.geo_guess` |
| transcripts (SAY/SEE/HEAR) | `video_analysis_jobs.timeline_jsonb` JOIN `niche_spy_videos v ON v.id=j.video_id` (361 done jobs) |
| `channel_b.*`, `cluster_size` | DEFERRED — needs cluster grouping decision |

Coverage holes: **வானிமணி தமிழில் (UCxt3KKN_pF70SWEA9xBOJ8A)** and **Dreamy
Flow (UCjByBYYazGapmHpD3fd4mpA)** have no transcript→no recipe/rpm. Plan says
2–3 videos per channel; current coverage is 1 per channel. Enqueue via
`app/api/admin/analyze-vids/jobs` (pipeline: yt-dlp download →
`/data/clips/video_analysis/<jobId>/source.mp4` → Gemini transcription →
`timeline_jsonb`), then `getOrGenerateRecipeShowcase(channelId, force=true)`
(recipe-showcase.ts:302) to re-extract with the richer corpus.

---

## Step 1 — NicheVars + phrase banks (data plumbing)

**New file `lib/content-gen/niche-vars.ts`**: `loadNicheVars(channelId) →
NicheVars` assembling the ~16-variable bundle above (one function, all
queries). Keep `loadChannel` untouched (used by vertical-slice path);
NicheVars wraps it.

**New file `lib/content-gen/phrase-banks.ts`**: the 9 pools VERBATIM from
worked-example §"banked phrase pools":
`intro_card(3)`, `emphasis_intro(4-6)`, `consistency_intro(4-6)`,
`money_opener_optional(3+skip)`, `assumption_modifier(3)`,
`math_connector(4)`, `second_channel_opener(3)`, `appreciation_phrase(3)`,
`transition_optional(3+silent)`. Plus CTA banks (`cta.value_card`,
`cta.action_card` — action MUST contain "check out this video", the 17×
winner-coded phrase).

Rotation: `pickPhrase(bank_id, seed)` — seeded by `(video_id, niche_index)`
for determinism within a render; persist usage in new table
`content_gen_phrase_history (beat_id, phrase, video_id, used_at)` (DDL in
lib/db.ts initSchema); exclusion = last-50 window per bank
(`script-skeleton-class-b.json` variation_rules).

## Step 2 — Narration rewrite (template-faithful lines)

All in `lib/content-gen/listicle-builder.ts`. Current hardcoded strings →
template lines:

| Slot (builder fn) | Today | Target (template) |
|---|---|---|
| intro_card (`buildNicheIntroSlots`, :174) | "Number N." + channel + label mixed in | `{bank.intro_card}` → "Number {N}:" ONLY |
| niche_name_card | ✓ "{label}." | unchanged |
| channel_intro (`buildChannelIntroSlot`, :440) | "Take a look at this channel." | "This channel {recipe_formula_simplified}." |
| channel_page_full (`buildChannelPageFullSlot`, :474) | "And this is what they're doing." | `{bank.emphasis_intro}` ("And the craziest part is —") |
| channel_proof_1 (stubNarration :103) | "This channel already has more than {subs} subscribers." | keep, now follows the emphasis opener |
| channel_proof_2 | "The channel has already gained over {tv} total views." | `{bank.consistency_intro}` + "over {tv} total views in just {age_phrase}." (brings age in per SR beat 5) |
| top_views_rapid ×3 (`buildTopViewsRapidFireSlots`, :404) | "Look at this one. / And this one. / And another." — **numbers never spoken** | "They have videos with {v0} views," / "{v1} views," / "and {v2} views," |
| top_videos_pano (:523) | "And look at their hottest videos." | "and almost every single upload pulls in {median_views_phrase}." |
| top_video_callout | ✓ | unchanged (feeds money) |
| money_math (`buildMoneyMathSlots`, :261) | fixed chain; tier-heuristic RPM | `{bank.money_opener_optional}` 50% · `{bank.assumption_modifier}` rotate · rpm = `channel_rpm.rpm_typical` (qualifier rule :278 already correct) · `{bank.math_connector}` rotate · geo card 30% if rpm>$5 |
| CTA (`buildCtaSlots`, :300) | fixed 4 cards; digit bug | `{cta.value_card}` bank · `{cta_topic_phrase}` variable · number-to-word + plural ("these are the ten" / "this is the niche") · NO subscribe beat (worked-example cuts it as fluff — earlier audit rec was WRONG) |

Verify: render phantomized → narration should read ≈ worked-example §"ONE
example render" (niche-1 stickman fill, adjusted for phantomized data).

## Step 3 — Silent beats + mascot_mosaic + transition

`applyContinuousNarration` (listicle-builder.ts:~790) only processes slots
WITH narration — silent slots naturally fall outside the master text. Slices
stay contiguous across them (the 2s visual pause reads as a deliberate
narrator pause, matching MG). No slicer change needed; just don't give silent
slots a narr gem — set `compose.hold_s` to a literal number instead of
`{{narr.duration_s}}`.

- **mascot_mosaic** (skeleton beat 3, silent, hold 2.0s): new image_gen
  composition `thumb_mosaic` — dense grid of the channel's video thumbnails
  (`niche_spy_videos`, thumbnail URLs like most_popular_callout uses), dark
  bg. Insert between niche_name_card and channel_intro. Reference signature:
  decoded timeline i=104/216/233/240 (mosaic/grid abundance proof).
- **transition** (beat 13, hold 0.5s): silent default, 20% `{bank.transition_optional}`
  vocal; whoosh sfx; emits at niche end (before CTA in single-channel video).

## Step 4 — recipe_demo (b-roll)

Narration is DONE (recipe_showcase.beats_jsonb). Render side:

1. **`clip_extract` tool** (producer-tools.ts + tools.ts registry):
   args `{video_url, clip_start, clip_end}` → yt-dlp whole-video download
   cached per video id under `clips/video_src/` (reuse the yt-dlp+proxy
   pattern from `lib/video-analysis.ts` / `lib/remotion/clipDownloader.ts`)
   → ffmpeg trim → `clips/broll/<hash>.mp4`. Tool-cacheable (version v1).
2. **mini_player treatment** (video-compose.ts): the clip plays inside a
   rounded-rect frame on dark_gray — ffmpeg overlay over a frame PNG (video
   stays video; NOT a static card). video-compose already routes
   `kind:'video'` inputs (resolveLayerToLocalFile :159-177, -stream_loop
   encode :483-493).
3. **Diegetic audio**: remove the unconditional `-an` (video-compose.ts
   :~490) for layers flagged `diegetic: true`; mix source audio at −15dB
   under VO (audio-sfx spec: −12..−18dB, full on narrator pause).
4. **Builder**: 2–4 recipe_demo slots after money_math, narration from
   beats_jsonb[i].narration, visual=clip_extract(main) with mini_player.
   INTERIM (before 1–3 land): render the beats with thumbnail cards so the
   narration ships first.

## Step 5 — concept_tag

Renderer EXISTS (`renderChalkboardCard`, image-gen.ts). Builder emits when a
concept word is derivable (channel_analysis tags / niche_label keyword), 1.2s
hold, chalk_cream, max once per niche, skip when null. Template line:
"The number one thing you must focus on in this niche is {concept_word}."

## Step 6 — transcription top-up (parallel, fire-and-forget)

Enqueue வானிமணி தமிழில் + Dreamy Flow (and +1–2 videos for the other 8) via
`app/api/admin/analyze-vids/jobs`; after done, `getOrGenerateRecipeShowcase(cid, true)`
re-extracts recipes against the bigger corpus. Pipeline also runs locally
(yt-dlp + PapaiAPI both proven on Mac).

## Acceptance (definition of done for ONE channel)

1. Slot sequence = skeleton beats 1–13 minus channel_b/appreciation:
   intro_card → niche_name → mascot_mosaic → channel_intro(recipe line) →
   channel_page_full(emphasis) → proof_1(subs) → proof_2(views+age) →
   rapid×3(spoken numbers) → pano(median close) → callout → money(rotated,
   analyzed RPM) → recipe_demo×2-4(b-roll) → concept_tag? → transition → CTA.
2. Narration diff vs worked-example template: every line traceable to a
   bank, a variable, or a Gemini recipe — zero invented fixed strings.
3. Two consecutive renders of the SAME channel produce different bank picks
   (rotation works); phrase_history rows written.
4. No slot >2.5s hold except money_shot/grids/recipe clips (pacing pass —
   separate task, see realign doc "pacing-hold-budget").
5. All verified via local loop frames + audio listen before any Railway push.

## Explicitly deferred (tracked in realign-2026-06-11.md)

Music rotation + sidechain ducking (audio floor) · channel_b reprise +
saturation (cluster grouping) · banner→expand→scroll motion · search_results
capture kind · icon/meme library · proprietary phase-2 data cards.
