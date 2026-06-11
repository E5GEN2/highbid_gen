# Content-Gen Listicle System — Technical Inventory (as implemented)

All paths relative to `/Users/rofe/Desktop/lab/hbgen/highbid_gen/lib/content-gen/`.

---

## 1. SLOT SEQUENCE

Assembled by `buildListicleScript()` (listicle-builder.ts:867-979). Max 16 channels (`channels.slice(0,16)`, :869). Per accepted channel = one "niche" with `niche_index` N. Every slot has 3 gems: `narr` (tts → usually swapped to `audio_slice`), `main` (visual), `sfx` (sfx_render).

### Per niche, in playback order

| # | slot_id | beat_id | main visual | narration (source) | sfx | bg | motion |
|---|---------|---------|-------------|--------------------|-----|----|--------|
| 1 | `niche_N_intro_card` | `intro_card` | `logos_montage` tool (2×5 avatar grid) | "Number N. {channel_name}." — **builder** (:198-200) | whoosh | white | `zoom_in_to_target` + `target_idx` (:219-221) |
| 2 | `niche_N_niche_name_card` | `niche_name_card` | image_gen `text_card` "{niche_label}." | "{niche_label}." — **builder** (:233-235) | whoosh | white | zoom_in_8pct |
| 3 | `niche_N_channel_intro` | `channel_intro` | yt_capture `channel_page` + crop_target `channel_chip` | "Take a look at this channel." — **builder** (:440) | whoosh | white | zoom_in_8pct (:439-467) |
| 4 | `niche_N_channel_page_full` | `channel_page_full` | yt_capture `channel_page` + crop_target `channel_page_full` | "And this is what they're doing." — **builder** (:474) | whoosh | dark_gray | zoom_in_8pct (:473-502) |
| 5 | writer slot | `channel_proof_1` | yt_capture forced to `kind=about_page` + `annotate_element=subscriber_count` + crop_target `about_panel` + `highlight_row=subscribers` | "This channel already has more than {subs} subscribers." — **builder stub** (:108,116), tool-annotated by **Gemini writer** | whoosh+ding | white (forced, :746) | STATIC + animated yellow highlight |
| 6 | writer slot | `channel_proof_2` | same path, `total_views` / `highlight_row=views` | "The channel has already gained over {tv} total views." — builder stub (:109,117) | whoosh+ding | white | STATIC + highlight |
| 7-9 | `niche_N_top_views_rapid_{0,1,2}` | `top_views_rapid` | yt_capture `videos_tab` + crop_target `thumbnail_rapid_fire:{0,1,2}` | "Look at this one." / "And this one." / "And another." — **builder** (:403) | whoosh | dark_gray | zoom_in_8pct (:396-432) |
| 10 | `niche_N_top_videos_pano` (skipped if <4 videos in DB, :519) | `top_videos_pano` | yt_capture `videos_tab` + crop_target `videos_grid` (tall PNG) | "And look at their hottest videos." — **builder** (:523) | whoosh | dark_gray | `scroll_down` (:550) |
| 11 | writer slot | `top_video_callout` | swapped to image_gen `most_popular_callout` (composed card; :620-670); fallback crop `top_video_card` if no top_video_id (:679) | "Their most popular video has more than {vv} views." — builder stub (:110,118) | whoosh+ding | white | zoom_in_8pct |
| 12 | `niche_N_mm_assumption` | `money_math` | text_card "Even if we assume"/"If we assume" | same text — **builder** (:282-284) | whoosh | white | word_reveal (4 words) |
| 13 | `niche_N_mm_rpm` | `money_math` | icon_card "$X RPM" + `shrug_with_question_marks`, inline_green | "just a $X RPM," / "a $X RPM," (:285-287). RPM tiers: <1M views→$1, 1-10M→$3, ≥10M→$6 (:272) | whoosh | white | zoom_in_8pct |
| 14 | `niche_N_mm_translates` | `money_math` | text_card "that one video alone has probably made around" | same — builder (:288-290) | whoosh | white | word_reveal |
| 15 | `niche_N_mm_lump_sum` | `money_math` | text_card "$X,XXX" money_shot_green | "{formatted}." (:291-293); lump = views/1000×RPM, 2-sig-fig rounding (:241-253) | **ding** | white | zoom_in_8pct (1 word, no reveal) |
| 16 | `niche_N_mm_closer` | `money_math` | text_card "from ads" | "from ads." (:294-296) | whoosh | white | zoom_in_8pct |

Money-math block skipped entirely if `top_video_view_count` null or <1000 (:262). Slot insertion logic: channel_intro+page_full before channel_proof_1; rapid-fire+pano after channel_proof_2 (:924-943).

### CTA (after all niches, buildCtaSlots :302-325)

| slot_id | composition | text | narration | sfx | bg |
|---------|-------------|------|-----------|-----|----|
| `cta_card_1` | text_card neutral | "So these are the N faceless niches." | same | whoosh | white |
| `cta_card_2` | icon_card `checkmark_green_circle` money_shot_green | "Huge potential." | "And each one has huge potential." | whoosh+ding | white |
| `cta_card_3` | icon_card `pointing_hand` neutral | "Discover more." | "If you want to discover more faceless niches like these," | whoosh | white |
| `cta_card_4` | icon_card `cat_thumbs_up` neutral | "Check out this video." | "check out this video right here." | **`ascending_electronic_sting` (BROKEN — see §6)** | dark_gray |

Final: `video_compose` with all slot_ids, 1920×1080@30fps, `default_bg: 'dark_gray'`, `music_token: 'bed'` (:968-976).

### Writer vs builder ownership
- **Gemini writer** (script-writer.ts:399-501, gemini-2.5-flash via xgodo proxy, temp 0.2, 16K out tokens) only receives the 3 stub proof beats (`channel_proof_1/2`, `top_video_callout` from `stubNarration('niche_segment_3')`, listicle-builder.ts:111-119) and annotates them with tool calls. Narration text itself is builder-authored (writer told "do NOT rewrite it", script-writer.ts:280).
- Writer prompt knows about many more beats (mascot_mosaic, top_views_seq, money_math expansion, growth.in_period, concept_tag, video_cta — script-writer.ts:116-179) but the builder never feeds them; builder hand-authors money_math, CTA, intros, rapid-fire, pano itself.
- Writer output post-processed: `forceProofKind` (:702-761, forces about_page + strips writer's annotate_kind/shape, adds highlight_row, bg white), `swapMostPopularCallout` (:620-670), `injectCropTargets` (:672-695). `swapChannelProof` exists but is **intentionally not called** (:12-13, :915-916).

---

## 2. COMPOSITIONS

### image-gen.ts (SVG → Sharp PNG, cached by SHA256 of args, 1920×1080 default)
- **text_card** (:103-137): font `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`, weight 800 (900 for money_shot_green), size via `fitFontSize` clamped **48-200px** (:67-77), max 3 lines, 85% width target, text cap 80 chars (:51). Colors (:39-47): neutral `#111111`, money_shot_green/inline_green `#22C55E`, inline_red `#EF4444`, chalk_cream `#F5EFD9`, yellow_ring `#111111` + `#FACC15` bar @0.45 opacity. BG: white `#FFFFFF` / dark_gray `#2A2A2A` (:48).
- **text_card_reveal** (:143-176, :262-281): renders N+1 PNG variants (k=0 blank → k=N full); identical layout, unspoken words `fill-opacity=0`; returns `local_paths[]`.
- **chalkboard_card** (:178-208): bg `#1F2A2F` + feTurbulence chalk noise (alpha 0.06), font `'Caveat','Comic Sans MS',cursive` weight 700 `#F5EFD9`, -1.5° rotation, max 2 lines. Registered but not emitted by current listicle flow.
- **icon_card** (:210-238): icon at y=0.36h, size 0.32·min(w,h) (~340px), from icon-library.ts (real line-drawn SVG for all 9 ICON_IDS — header comment at image-gen.ts:17-19 claiming "placeholder" is stale); stroke white-on-dark/black-on-white, accent `#22C55E` (red `#EF4444` for inline_red); text at y=0.74h weight 800.
- **text_card_in_title_sequence** (:240-244): alias of text_card.
- **most_popular_callout** (cards/most-popular-callout.ts): white canvas; thumbnail 52% width (~1000px) 16:9 fetched from `i.ytimg.com` maxres→hq, 12px radius mask; title 56px/700 max 2 lines + ellipsis; meta line 34px `#606060`; 3-dot menu; optional duration badge (black@0.78 pill) + watermark (white, 3px black stroke).
- **top_videos_pano** (cards/top-videos-pano.ts): `#202020` card 88%×80% radius 32 on white; adaptive grid 4×2 (N≥6) down to 2×1; cell title 28px/600, meta 22px `#AAAAAA`. **Registered but unused by the listicle path** — pano slot uses yt_capture+crop instead.
- **channel_about_panel** (cards/channel-about-panel.ts): `#202020` card 58%×78% radius 28 on white; 6 icon rows (globe/globe/info/subs/play/chart), 48px/500 white text, 92px row gap; static yellow `#E8E84F` 10px vertical bar next to highlighted row; "Share channel" pill 360×78 `#3A3A3A`. **Implemented but unused** (swapChannelProof not called).

### yt-compose-mg.ts (screenshot → 1920×1080 composed frames, dispatched via crop_target in video-compose.ts:217-324)
- **composeAboutPanelMG** (:49-111): crop anchored on `joined_date` bbox (x−44, y−110, w+308, h=372); 1000×780 `#202020` card radius 40, white canvas. Anchor fallback: synthesized from `total_views` y−150 when no joined row (video-compose.ts:212-216).
- **composeChannelChipMG** (:215-278): anchor `subscriber_count` (x−356, y−68 → +320/+110); card 1500×440 radius 36 pad 20, white canvas.
- **composeChannelPageFullMG** (:299-359): strips YT sidebar (248/1440 prop.) + topbar (48/900); card 1760×980 `#101010` radius 36, outer rgb(95,95,95).
- **composeThumbnailRapidFireMG** (:378-428): single `video_card_N` bbox + 14px pad; card 1100w `#161616` radius 36, outer rgb(35,35,35).
- **composeTopVideosPanoMG** (:439-514): union of all `video_card_*` bboxes → **tall 1920×N PNG** (N≥1080); card 1800w `#161616`, outer rgb(95,95,95), 100px top/bottom margins — fuel for scroll_down.
- **composeChannelLogosMontageMG** (:592-616): 2×5 grid, cells 384×540, 280px circular avatars + 10px black ring, avatars from YT CDN upsized `=s400-`, white canvas. (Grid caps at 10; builder allows up to 16 channels.)

Generic crops: composite bbox crop pad 16, single bbox pad 32 (video-compose.ts:327-336).

---

## 3. MOTION

Declared ken_burns enum (video-compose.ts:45): `none | zoom_in_8pct | zoom_out_8pct | pan_left | pan_right | scroll_down | zoom_in_to_target | word_reveal`.

**Implemented:**
- **zoom_in_8pct** (default, :416-419): 4× lanczos supersample → `zoompan z=1+0.08·on/frames`, centered, then fit+pad.
- **scroll_down** (:379-382): scale-to-width then crop window pans y linearly 0→(ih−1080) over slot duration; no zoom.
- **zoom_in_to_target** (:389-409): 4× supersample anti-jitter; `zoompan z=1→3` centered on grid cell `(col·384+192, row·540+270)·4` from `target_idx`.
- **word_reveal** (:479-505): concat demuxer over progressive PNGs; frame k holds `[word_times[k-1], word_times[k])`, final frame to hold_s; static fit+pad (no zoompan). Wired in listicle-builder.ts:832-844 — only when main is `text_card` AND card text === slot narration AND ≥4 words (`REVEAL_MIN_WORDS=4`, :778).

**NOT implemented:** `none`, `zoom_out_8pct`, `pan_left`, `pan_right` — type-only; the vf selector (:461-464) only branches on highlight/scroll_down/zoom_to_target, so these **silently render as zoom_in_8pct**.

**about_panel highlight** (:424-449): yellow L→R growing rect over the stats row — 18 stepped `drawbox` segments with `between(t)` enables over 0.6s, `yellow@0.45`, startX=625, width grows to row width (~300px+12 pad). Row located by **pixel-scanning** the composed PNG (:227-268: scan column x650-760, y200-900, brightness>50, row h 8-30; index 3=subs/4=videos/5=views). Highlight slots are forced **fully static** (:452-459) so the box stays aligned.

---

## 4. AUDIO

- **Continuous narration** (`applyContinuousNarration`, listicle-builder.ts:783-846): ONE `ttsWithTimestamps` master per niche group + one per CTA group (texts joined with ' '); voice `money_groot` = ElevenLabs `onwK4e9ZLuTAKqWW03F9`, model `eleven_multilingual_v2` (voice.ts:37-38), `/with-timestamps` char alignment → word timings cached in `content_gen_voice_assets.alignment_jsonb`. Each slot's `narr` tts gem replaced with `audio_slice {src, start_s, end_s}`; spans tile master at next-slot-first-word boundaries minus 0.06s lead pad (`SLICE_LEAD_PAD_S`, :779); min span 0.3s; last slot runs to master end. Master TTS failure → silently keeps per-slot `ttsBeat` (robotic joins, :794-798). Alignment hole → that slot keeps per-slot tts (:811).
- **audio_slice** (producer-tools.ts:65-99): decode-accurate ffmpeg `-i src -ss -t`, libmp3lame q2, hash-cached.
- **Per-slot mux** (video-compose.ts:529-577): voice+fx → `amix` voice 1.0 / fx **0.7**, apad+atrim to hold_s, AAC 128k; voice-only / fx-only variants; neither → `anullsrc` silence. **No ducking** ("no ducking yet", :366-367).
- **SFX** (producer-tools.ts:213-275): `getSfx(token)` per token via ElevenLabs `/v1/sound-generation` (sfx.ts:141-145), SHA256 cache on volume + `content_gen_sfx_assets`. Single-token natural-length copy; multi-token concat + apad/atrim to `fit_duration_s`. Per-token failure logged + skipped; all-fail throws — but sfx gem is **non-critical** (`CRITICAL_GEM_IDS = {narr, main}`, producer.ts:38), so the slot proceeds with no fx layer.
- **Music bed** (video-compose.ts:638-668): stage 3; default token `'bed'` (lofi prompt, sfx.ts:62); calls `getSfx(musicToken, totalDur)` with the FULL video duration. **Broken cap:** sfx.ts `getSfx` clamps only MIN (0.5s, :121) — no max — so for any video beyond ElevenLabs sound-generation's duration limit (registry hints 30s default, :62), the API rejects → catch (:661-665) → `copyFile(concat, out)` → **video ships with no music at all**. Even on success the bed is never looped — `apad` fills with silence (:653), so music covers at most the first ~30s. Mix when it works: bed volume 0.25, `amix weights '4 1'` (static weighting, explicitly "side-step true sidechaining", :650-654), AAC 160k.
- **Ducking:** not implemented anywhere in this path. `audio_mix` tool is a pure stub returning `stub://audio_mix/composite`, duration 0 (producer-tools.ts:339-344). (audio-bed.ts:71-204 is a real mixer with looped bed @0.18 + alimiter, but belongs to the separate timeline/recipe-showcase pipeline, not the listicle producer.)

---

## 5. TRANSITIONS

- **Between slots: hard cuts only.** Per-slot mp4s are joined with the concat demuxer using `-c copy` (video-compose.ts:617-621), falling back to a plain re-encode on stream-incompatibility (:623-629). No `xfade`, no crossfade, no dip-to-color anywhere in the file. The only transition treatment is the `whoosh` SFX firing at slot start.
- The `video_compose` tool description claims "Ken Burns / cross-fade" (tools.ts:416) — cross-fade is aspirational, not implemented.
- Audio across boundaries: each slot's audio is apad/atrim'ed to exactly hold_s, so concat is gapless but with no audio crossfade; continuous-narration slicing makes voice sound seamless across cuts.

---

## 6. BROKEN / STUBBED

1. **`ascending_electronic_sting` unresolvable** — emitted on `cta_card_4` (listicle-builder.ts:322), present in `SFX_TOKENS` (tools.ts:83), but **absent from sfx.ts `TOKENS`** (:45-67) → `getSfx` throws `unknown sfx token: ascending_electronic_sting` (sfx.ts:120) → single-token sfx_render throws "all tokens failed to resolve" (producer-tools.ts:231) → sfx gem fails (non-critical) → final CTA card renders with **no sting**. Nearest existing token: `ascending_sting` (sfx.ts:59).
2. **SFX enum/registry mismatch** — tools.ts SFX_TOKENS members `click, keyboard_typing, bell_ring, page_turn, cash_counting, mouse_click, generic_impact, ascending_electronic_sting` have **no generator entry** in sfx.ts; only `whoosh`, `ding`, `soft_chimes` exist in both. Conversely sfx.ts variants (`subtle_whoosh`, `ding_high_pitch`, `whoosh_on_*`, `ding_on_*`) are not in the writer enum.
3. **MUSIC_TOKENS zero overlap** — tools.ts:89-100 (`upbeat_light`, `phonk_funk`, etc.) vs sfx.ts music registry (`bed, intro, niche_in, duck_under_diegetic, duck_deeper`). Any writer-chosen music token would throw; only the hardcoded `'bed'` works.
4. **Music bed duration cap** — no max clamp in `getSfx` (sfx.ts:121); `getSfx('bed', totalDur)` with multi-minute totals fails at ElevenLabs → bed silently dropped (video-compose.ts:661-665); no loop fallback in this pipeline.
5. **`audio_mix` stub** — producer-tools.ts:339-344, returns `stub://audio_mix/composite` / 0s.
6. **4 dead ken_burns modes** — `none/zoom_out_8pct/pan_left/pan_right` typed (video-compose.ts:45) but unimplemented; silently become zoom_in_8pct.
7. **Stub placeholder fallback** — unresolvable main visuals render a labeled system-ui placeholder PNG (`renderStubImage`, video-compose.ts:134-153; missing-layer fallback :357-361) — failure mode visible in output video, not a crash.
8. **Implemented-but-unused composers** — `channel_about_panel` card + `swapChannelProof` (listicle-builder.ts:564-613, deliberately bypassed :12-13,:915-916); `top_videos_pano` image_gen composition (cards/top-videos-pano.ts) bypassed in favor of yt_capture `videos_grid` crop.
9. **Stale STUB/TODO comments** — producer-tools.ts:7-10/:176-180/:208-211/:278-282 label tts/sfx_render/image_gen as STUBs and :346-356 calls video_compose a PLACEHOLDER, but all dispatch real implementations; video-compose.ts:13-28 header still says "silent video, image-only" + "TODO when audio real" though audio mux is implemented; image-gen.ts:17-19 claims icon assets are placeholders though icon-library.ts renders real SVGs for all 9 ICON_IDS.
10. **Logos grid vs channel cap mismatch** — builder accepts 16 channels (listicle-builder.ts:869) but the montage renders only 10 (2×5; yt-compose-mg.ts:594) and `logos_montage` schema caps `channelIds` at 10 (tools.ts:391); channels 11-16 would be missing from the intro grid and target_idx clamps to 9 (listicle-builder.ts:221).
11. **Word reveal punctuation sensitivity** — reveal requires `cardText === narration.trim()` (listicle-builder.ts:836-837); slots like `mm_closer` (text "from ads" vs narration "from ads.") and `mm_lump_sum` ("$4,000" vs "$4,000.") never reveal due to trailing-period mismatch — only ≥4-word exact matches (mm_assumption, mm_translates, cta_card_1, niche_name_card when long) get it.