# CLASS B GENERATED-VIDEO REQUIREMENT INVENTORY

Sources: `visual-packaging-class-b.md/.json` (VP), `slot-rendering-class-b.md/.json` (SR), `script-skeleton-class-b.md/.json` (SS), `audio-sfx-class-b.md/.json` (AX), `data-points.md/.json` (DP), `data-discovery-rules.md` (DD), `worked-example-mg-reverse-engineered.md` (WE). All paths under `/Users/rofe/Desktop/lab/hbgen/highbid_gen/docs/content-gen/`.

---

## BEATS (ordered)

### Per-niche beat sequence (13 beats, executed once per niche; median total 50s, range ~35-60s) — SR "per_niche_beat_sequence" + SS "beats_per_niche"

| # | id | Beat | Visual composition (bg / composition / primitive / icon) | Audio treatment | Hold | Narration requirement |
|---|---|---|---|---|---|---|
| 1 | `beat.intro_card` | "Number N" card | white / text_card / — / — (SR) | SFX: whoosh + ding on number; music = current niche track (track switch happens at this boundary) (SR, AX) | 0.8s | YES, bank-based: `"Number {N}:"` \| `"Number {N}."` \| `"Number {N},"`; 2-4 words; alternate punctuation, never same form 3× in a row (SS Beat 1) |
| 2 | `beat.niche_name_card` | Niche name card | white / text_card / — / — | SFX: whoosh (SR); none per AX example | 1.5s | YES, hybrid: `"{niche_category_label}."` (default, 7/11 in MG) or `"{label}, {short_qualifier}."`; ≤6 words; SKIP if label folded into beat 1 (SS Beat 2) |
| 3 | `beat.mascot_mosaic` | 3 circular profile pics | white / mosaic of 3 circular channel avatars / — / — (SR md sequence) | SFX: subtle whoosh | 2.0s | NO — silent visual (SS) |
| 4 | `beat.channel_proof_1` | subs + video_count proof | dark_gray / annotated_screenshot (yt_channel_page_mock) / yellow_circle_screenshot_annotation on subs number / — (SR `channel.subscribers`) | SFX: whoosh_on_load + ding_on_circle_reveal; music ducks under narration | visual 2.5s (SR sequence); narration hold 1.8s (SS) | YES, Gemini-generate: 1 sentence, 15-25 words; vars `channel_name, subs, video_count, channel_age_phrase, channel_index_in_listicle`; opener rule: 1st channel of niche = "This channel...", 2nd/3rd = "There's another channel that..." / "And there's another channel..." (SS Beat 4) |
| 5 | `beat.channel_proof_2` | age + total_views proof | dark_gray / annotated_screenshot (yt_about_page_mock / Stats page) / yellow ring on subs or total-views number / — (SR) | SFX: whoosh + ding | 2.0s (SR sequence); narration 1.5s (SS) | YES, Gemini-generate: 1 sentence, 12-20 words; modifier rotation ["already","over","more than","almost","mind-blowing total","literally"]; SKIP if beat 4 already used total views or age (SS Beat 5) |
| 6 | `beat.top_video_callout` | THE most popular video | dark_gray / most_popular_callout_card primitive / optional yellow ring on view count / — (SR `video.top_video`) | SFX: ding_on_card_entry | 2.0s (range 1.5-2.5s, longer than grid items — VP tool 2) | YES, Gemini-generate: 1 sentence, 10-18 words; vars `top_video_views, top_video_age_months, top_video_title_snippet`; rotate "their most popular video" / "their top video" / "this one video", never same twice in a row (SS Beat 6) |
| 7 | `beat.top_views_seq` | rapid-fire top-3..5 thumbnails | dark_gray / thumbnail_card_rapid_fire (3-5 single thumbnail cards in succession) / — / — (SR `video.views_sequence`) | SFX: whoosh per card transition; optional ding cascade | 1.0s per card; 3.0s total in beat sequence | YES, rapid_sequence: 3-5 phrases, 2-4 words each, e.g. "29 million views," … final phrase period; optionally prepend "and" to last (SS Beat 7) |
| 8 | `beat.top_views_pano` | thumbnail grid | dark_gray / thumbnail_grid (8-12 of channel's top videos with view counts) / — / — (SR `video.views_panoramic`) | SFX: whoosh_on_grid_reveal | 3.0s (3-4s per SR md) | YES, Gemini-generate: 1 sentence, 10-15 words; consistency framing bank ("and almost every single upload pulls in hundreds of thousands of views." etc.); inject actual median views if >100K (SS Beat 8) |
| 9 | `beat.money_math` | 6-card RPM-hidden money reveal | sequence (SR `money.lump_sum`): ① white text_card "Even if we assume" 0.8s; ② white icon_card icon=`shrug_with_question_marks` "$X RPM" inline_green 1.5s; ③ dark_gray thumbnail_card (cited top video) 1.5s; ④ white text_card "this would translate to" 0.8s; ⑤ white text_card "$X,XXX" money_shot_green 1.8s; ⑥ white text_card "from ads" 0.8s | SFX: ding on each $ reveal, ding_high_pitch on card ⑤; optional cash_counting on final $ (SR md money table) | full sequence ~6-8s (6.7s in beat table) | YES, hybrid_card_sequence: 4-6 cards, 1-6 words each; card templates: c1 optional ["Let's take that video","Take their top video"], c2 ["If we assume","Even if we assume"], c3 ["$X RPM,","just $X RPM,"], c4 ["this would translate to","that's roughly","the estimated earnings are","that one video alone has probably made around"], c5 = `{result_dollars}`, c6 = "from ads."; geo-context card inserted between c3/c4 only if rpm > $5 at probability 0.3; low RPM ($1-$3) → "just"/"Even if we assume" minimizer; higher RPM ($6-$10) → no minimizer (SS Beat 9) |
| 10 | `beat.recipe_demo` | recipe narrated over real content | mixed: white text_cards alternating with dark_gray mini_player_cards showing the channel's actual content (SR `recipe.formula`) | DIEGETIC: source channel native audio under mini-player, mixed −12 to −18dB under narration, full volume on narrator pause; whoosh on transitions; music returns to baseline when clip ends (AX, SR) | 2-4s per content sample; ~8.0s beat total | YES, Gemini multi-beat: N phrases (N = clip_segment_count, typically 3-5), 12-22 words each; structure: opener → editing specifics → outcome; connector rotation ["And","On top of that,","When you look at...","They also...","What's interesting is..."]; low-effort recipes emphasize "simply/just/extremely simple", higher-skill emphasize "the storytelling is very strong" (SS Beat 10) |
| 11 | `beat.concept_tag` | chalkboard concept word | dark_gray / chalkboard_card / chalkboard_concept_tag primitive / — | SFX: soft_chimes | 1.2s (1.0-1.5s SR md; 1-2s VP) | YES, hybrid: 1 sentence, 10-14 words, ending in or pre-stating `{concept_word}`; max once per niche; rendered only if concept_word set (SS Beat 11, WE) |
| 12 | `beat.appreciation_optional` | viewer appreciation | white / icon_card / — / icon=`cat_thumbs_up` (SR JSON `cta.viewer_appreciation`; VP composition example shows it on dark_gray) | music ducks deeper; NO SFX | 2.0s | YES (sometimes), bank-based, trigger probability 0.30, max 2× per video, preferred positions mid-body ~50-60% and optionally before CTA; bank: "And if you're watching this far, I really appreciate it." / "By the way, if you're still here, thank you." / "Real quick — if you've made it this far, that means a lot."; 8-15 words (SS Beat 12) |
| 13 | `beat.transition` | niche boundary | whoosh transition; music track fades out → new track fades in (SR, AX) | SFX: whoosh; music switch mandatory at niche boundary | 0.5s | DEFAULT silent; vocal cue probability 0.20, ≤3 words, bank ["Moving on,","Next up,","And finally..." (last niche only)] (SS Beat 13) |

### Per-niche extensions from worked example (WE "THE PER-NICHE TEMPLATE")

| id | Requirement |
|---|---|
| `beat.channel_a_recipe_intro` | After niche name, recipe intro line: "This channel {recipe_formula_simplified}." (Gemini-varied per niche) |
| `beat.channel_b_proof_reprise` | Second channel proof (beat 4 reprise): opener from `bank.second_channel_opener` ["There is another channel that","And there's another channel","Look at this one"] + Gemini fill of channel_b age/performance |
| `beat.saturation_callout_optional` | Rendered ONLY if cluster_size > 20: "And when you look around, you'll see many channels doing this and performing well with the same format." |
| `beat.money_opener_probability` | `bank.money_opener_optional` used at 50% probability (WE; SS marks card 1 as optional) |
| `beat.skeleton_bends_to_data` | Missing slot data → associated lines skipped entirely (e.g. no top-3 enumeration → skip beat 7, swap total_views framing) |
| `beat.banked_phrase_pools` | 9 rotating banks required: intro_card (3 variants), emphasis_intro (4-6), consistency_intro (4-6), money_opener_optional (3 + skip), assumption_modifier (3), math_connector (4), second_channel_opener (3), appreciation_phrase (3), transition_optional (3 + silent default) |

### Video-level beats — SS "video_level_beats"

| id | Requirement |
|---|---|
| `video.intro` | 0-15s max. DEFAULT: cold open, NO preamble — go straight to niche 1 intro_card (Money Groot style). Preamble variant at probability 0.30: 1 sentence research-claim ("I went through hundreds of faceless YouTube channels..."). Controlled by `open_with_preamble` flag. |
| `video.cta` | Last ≤30s, ~20s narration. Required 4-card structure: ① closer "So, these are the {N} faceless niches."; ② light value claim "And each one has huge potential" / "Any one of these could become a real channel"; ③ next-video tease "And if you want to {cta_topic_phrase},"; ④ CTA action — MUST contain "check out [this/next] video" phrase (17× winner uplift), e.g. "just click on this video right here." Each card 4-12 words. |
| `video.cta.exclusions` | NEVER: "I hope to see each other in another one of our videos" (0× winners); "click the link in the description" alone; MG's pre-CTA personal anecdote; "I'll keep bringing you more valuable content" self-promo. |
| `video.cta.subscribe_ask` | white / text_card / "hit subscribe" / optional inline_green on "subscribe" / hold 1.5s / NO SFX, no animated button (SR `cta.subscribe_ask`) |
| `video.cta.next_video_pitch` | white / icon_card / icon=`pointing_hand` / inline_green on "check out this video" / hold 2.2s (2.0-2.5s md) / ascending_electronic_sting on final beat (SR `cta.next_video_pitch`) |

### Script-global narration constraints — SS "Global voice constraints" + "Variation rules"

| id | Requirement |
|---|---|
| `script.voice.register` | Calm, educational, matter-of-fact male documentary narrator; mid-pitch; single voice throughout; NOT high-energy vlogger, NOT corporate |
| `script.voice.concreteness` | Concrete numbers always; never "a lot"/"many"; active voice, present tense |
| `script.voice.direct_address` | Viewer addressed max ~3-4× per video |
| `script.voice.enthusiasm_caps` | "absolutely unbelievable" ≤2/video; "mind-blowing" ≤1/video; "literally" ≤3/video |
| `script.taboos` | Banned phrases: "Today, I'm going to share"; "What if I told you"; "Imagine if you could"; "Let's talk about"; "Every single day"; "Click the link in the description" (alone); "I hope to see each other in another one of our videos"; any spoken RPM math ("views × RPM = $") |
| `script.variation.within_video` | Never "This channel..." for both channels of same niche; never same channel-intro opener twice in any 3-niche stretch; rotate money-math connectors ("Even if we assume"/"If we assume"/"Let's say we assume"); rotate recipe-demo openers; rotate transition phrases; modifiers ("already"/"more than"/"literally") never 3× in same paragraph |
| `script.variation.across_generations` | Rolling window of last 50 narrator phrases per beat_id (purge >7 days old or keep most-recent 50, whichever smaller); passed to Gemini per beat; no exact reuse |
| `script.output_schema` | One Gemini call per video → JSON `{intro: null\|{text,duration_s}, niches:[{niche_index, beats:[{beat_id,text,hold_s,audio_cue}]}], cta:{cards:[{text,hold_s}]}}`; downstream ElevenLabs TTS per beat → WAV |
| `script.fluff_exclusion` | No slots exist for: production trivia, tool-channel plugs, personal demos, self-promo subscribe asks, filler interjections, editing trivia, personal regret anecdotes, moralistic outros (WE "fluff" table — structurally impossible to generate) |

---

## COMPOSITIONS

### Visual systems (load-bearing, every frame) — VP "5 general systems"

| id | Requirement | Parameters |
|---|---|---|
| `comp.system_a.two_backgrounds` | Every frame lives in exactly one of two semantic background modes; narration content never on dark_gray, YT/proof data never on white | white = `#FFFFFF` (narration/commentary); dark_gray = `#2A2A2A` (YouTube-world/proof/data) |
| `comp.system_b.card_padding` | No content edge-to-edge; every screenshot/thumbnail/clip/text block is a padded centered card on the background | inner card max 80-85% frame width; corner radius 8-16px; padding ≥8% of frame height each side |
| `comp.system_c.typographic_hierarchy` | Text within a card has size+weight+color hierarchy (see COLOR/TYPE section) | token roles: connector / emphasis / money_shot |
| `comp.system_d.icon_host_proxy` | Every emotional/reaction beat must render an icon from the line-drawing library (host face substitute) | ~10-15 SVG icons, single consistent line-drawing style mandatory; flat single-color (black on white / white on dark) |
| `comp.system_e.yt_native` | All proof-side visuals must match YouTube's actual current rendering: typography, channel-page layout, thumbnail aspect ratio, "X views • N ago" timestamp format | templates: yt_channel_page_mock, yt_about_page_mock, yt_thumbnail_card, yt_search_results_mock, rounded-rectangle mini-player frame |

### Composition enum — SR "render_contract_fields"

`text_card | yt_screenshot_card | thumbnail_card | thumbnail_grid | mini_player_card | annotated_screenshot | chalkboard_card | icon_card` plus named: `most_popular_callout_card`, `thumbnail_card_rapid_fire`, `narration_with_content_demo`, `text_card_in_title_sequence`.

### Icon library enum — VP primitive 1

| icon id | use |
|---|---|
| `shrug_with_question_marks` | uncertainty / "we don't know exactly" / "let's estimate" (money_math assumption beat) |
| `pointing_hand` | direct viewer address / next-video pitch |
| `checkmark_green_circle` | confirmation / format.production_type element cards |
| `dollar_sign_green_circle` | monetization beat |
| `cat_thumbs_up` | viewer-appreciation beat |
| `speaker_muted` | "muted audio / you can't use this" |
| `speaker_with_sound_waves` | "audio is used here" |
| `shrug_emoji` | quick reaction beat |
| `cash_pile` | money emphasis (sparingly) |
| (chalkboard asset) | concept tag (tool #5) |

### Named primitives — VP "5 emphasis tools"

| id | Spec |
|---|---|
| `comp.most_popular_callout_card` | dark_gray bg; single thumbnail centered, YT-native layout (thumbnail + title below + "X views • N ago"); ~60% of card area (grid items ~30%); hold 1.5-2.5s; no grid context |
| `comp.yellow_circle_annotation` | SVG overlay on screenshot; color `#FACC15`; ring stroke 4-6px; fade-in 200ms; types: ring around number / background fill behind word / highlight box around row; MUST fire whenever speech references a visible element (subs stated + channel page on screen → circle subs) |
| `comp.inline_color_highlight` | `<span>` color override inside text card; green `#22C55E` or red `#EF4444` only; same font size as surrounding text (NOT bigger); bold weight; yellow never used inline |
| `comp.chalkboard_concept_tag` | dark green/black chalkboard texture; serif chalk-style font; text color `#F8F4E3`; centered; max 3 words; hold 1-2s; at most once per niche segment |
| `comp.icon_card` | flat single-color SVG, full-frame as single card or composed with text |

### Excluded visual patterns (must NOT appear) — VP "excluded_patterns"

`talking_head_on_camera`, `social_blade_overlay`, `custom_branded_earnings_callout`, `dark_grid_pattern_background`, `blue_gradient_background`, `particles_or_sparkles_animation`, `animated_word_by_word_text_reveal`, `vidiq_or_tubebuddy_overlay`, `subscribe_button_animation`, `end_card_video_thumbnail_grid`, `visible_browser_url_bar`, `corner_webcam_pip_host_overlay`.
(NOTE conflict-as-data: DP "tricks_to_add_from_corpus_winners" lists Social Blade overlay 9.0×, "Estimated monthly earnings $X/month" callout 10.0×, glitch SFX 7.5× as Phase-1 additions; VP/AX exclude all three as Class A patterns.)

---

## COLOR / TYPE TREATMENTS

| id | Requirement | Values |
|---|---|---|
| `color.semantics` | Strict video-wide color meaning | GREEN `#22C55E` = money/opportunity/positive; RED `#EF4444` = warning/friction/"don't do this"; YELLOW `#FACC15` = highlight/"look here" (circles/fills ONLY, never inline text); BLACK `#111111` = neutral on white; WHITE `#FFFFFF` = neutral on dark_gray |
| `type.token_roles` | Three-tier hierarchy within cards | connector: normal size / regular weight / neutral color; emphasis: same-or-slightly-larger / bold / green-or-red; money_shot: much larger / bold / green |
| `color.treatment_enum` | Per-slot color_treatment values | `neutral \| money_shot_green \| inline_green \| inline_red \| yellow_ring \| chalk_cream` |
| `color.money_pattern` | Money always revealed via sequential text-card chain ending in money-shot green $ card; RPM math never displayed | (SR money table) |
| `color.per_slot` | channel.subscribers/total_views → yellow_ring; channel.age → neutral; channel.upload_rate overlay → inline_green; niche.category → neutral or inline_green on keyword; competition.zero → inline_green on count; competition.saturated → inline_red on "avoid"; growth.in_period → green on view count + month count; money cards → money_shot_green on $, neutral connectors; concept tag → chalk_cream; subscribe → optional inline_green; next-video pitch → inline_green on "check out this video" (SR tables) |

---

## AUDIO RULES

### Systems — AX "4 audio systems"

| id | Requirement |
|---|---|
| `audio.music.multi_track_rotation` | Music switches tracks at semantic boundaries (never one track throughout). Triggers: ① section boundary (new niche / tips section / CTA), ② mode shift (narration ↔ demo ↔ proof), ③ topic match (tech → upbeat_tech, gameplay → phonk, inspirational → upbeat_modern_inspirational). Per-niche `mood` field default `upbeat_light`; `mood_override` for high-affinity niches; tips → calm, CTA → upbeat_calm. |
| `audio.music.ducking` | Sidechain ducking: music drops ~−6dB when narrator speaks; returns to full volume over ~200ms release on pause; full volume on cuts with no narration; explicit fade-out at section boundaries before new track fades in; ONE track at a time, no cross-fading beds |
| `audio.diegetic_mirroring` | Audio plays what's shown, not what's described: narrated phonk → phonk actually plays; money counting → cash SFX; thumbnail appears → ding synced; cursor → click; content clips keep source channel's native audio at −12 to −18dB under narration, full volume on narrator pause; diegetic SFX clipped from source videos, NOT pre-baked |
| `audio.voice` | Single ElevenLabs-class voice: male, calm/measured, clear articulation, mid-pitch, documentary style, single voice throughout entire video |

### Music track enum — AX "music_tracks"

| token | use-case | BPM |
|---|---|---|
| `upbeat_light` | default narration baseline | ~120 |
| `upbeat_motivational` | proof / inspirational moments | ~125 |
| `upbeat_tech` | tech-niche topic match | ~125 |
| `calm_uplifting` | tips / educational | ~95 |
| `upbeat_calm` | CTA outro | ~110 |
| `upbeat_corporate` | section-pivot transitions between niches | ~120 |
| `phonk_funk` | DIEGETIC — matches source content music | ~140 |
| `soft_calm` | intimate / personal advice (optional) | ~80 |
| `upbeat_modern_inspirational` | inspirational niches (optional) | ~120 |
| `energetic_dramatic` | hype peaks (optional) | ~130 |

Minimum library 6 tracks (`upbeat_light`, `upbeat_motivational`, `calm_uplifting`, `upbeat_tech`, `upbeat_calm`, `upbeat_corporate`), expanded 10.

### SFX primitive enum — AX "sfx_primitives"

| token | trigger rule | duration |
|---|---|---|
| `whoosh` (variants: subtle / sharp / per-item) | every visual element entry/exit, every text-card cut, between niches | 150-400ms |
| `ding` (soft / strong) | exactly when a NUMBER or VALUE lands on screen; pitch rises with figure size ($29K higher than $6) | ~150ms |
| `click` | cursor clicks / scrolling / navigation | 50-80ms |
| `keyboard_typing` | text appearing with typewriter effect | 200-600ms (3-6 keystrokes/word) |
| `bell_ring` | affirmation/notification | ~400ms |
| `page_turn` | major section boundaries | ~300ms |
| `cash_counting` | earnings totals / accumulating money | 800-1200ms |
| `soft_chimes` (rising) | positive reveals, chalkboard concept tag, "best part is…" | 400-600ms |
| `mouse_click` | demonstrated YouTube click-through (paired with cursor visual) | 50-80ms |
| `ascending_electronic_sting` | final CTA beat before music ends | ~500ms |
| `generic_impact` | rare hype moments | ~200ms |

### Hard audio rules

| id | Requirement |
|---|---|
| `audio.sfx.one_per_cut` | Maximum ONE SFX per cut — no stacking |
| `audio.sfx.ding_on_every_dollar` | Ding on every $ reveal; ding_high_pitch on money-shot card |
| `audio.music.niche_boundary_switch` | Music track MUST change at each niche boundary (fade out → new track fade in + whoosh) |
| `audio.appreciation_duck` | Music ducks deeper (beyond standard −6dB) on viewer-appreciation beat; no SFX |
| `audio.cta.no_subscribe_cue` | Subscribe ask gets NO audio cue/jingle |
| `audio.excluded` | Banned: glitch SFX heavy distortion, cinematic orchestral swells, multi-voice narrator mix, high-energy vlogger narration, loud bang/explosion on number reveals, multiple SFX stacked per cut, continuous narration with no music gaps, subscribe-button jingle. (Conflict-as-data: DP tricks list includes "Glitch SFX between niche reveals" 7.5×.) |

---

## DATA POINTS

### Phase 1 slots (must be fillable; uplift = winner%/loser%) — DP

| id | uplift | slot role | presentation rule |
|---|---|---|---|
| `money.yearly` | 3.5× | REQUIRED_OF_DOLLAR_TRIO | round 2 sig figs ($1.1M/year); use when ≥$50K/year |
| `channel.upload_rate` | 3.0× | HIGH_LEVERAGE | integer if ≥1/week; "one every N days" if rarer; never fractional; fill when channel has ≥4 indexed videos |
| `money.daily` | 2.1× | REQUIRED_OF_DOLLAR_TRIO | use when round ($100/day, $1k/day); else yearly/monthly |
| `growth.in_period` | 2.0× | HIGH_LEVERAGE_UNDERUSED | use on ≥2 of N items per video; reserve for channels <18mo; integer months |
| `money.monthly` | 1.7× | REQUIRED_OF_DOLLAR_TRIO | default fallback $ slot |
| `video.top_video` | 1.6× | HIGH_LEVERAGE_PER_ITEM | always pair with its view count; cut to its thumbnail while stating views |
| `channel.age` | 1.4× | REQUIRED | round phrasing ("almost 2 years old", "just 6 months old") |
| `money.per_video` | 1.3× | OPTIONAL | strongest with low video count |
| `niche.category` | 1.3× | REQUIRED | maximum specificity (sub_niche preferred) |
| `competition.saturated` | 1.3× | HIGH_LEVERAGE_WHY_BEAT | cluster video_count > ~200 |
| `competition.zero` | 1.3× | HIGH_LEVERAGE_WHY_BEAT | cluster video_count < ~20; pair with "We track N channels" |
| `channel.total_views` | 1.3× | HIGH_LEVERAGE | readable format (52M not 52,418,773) |
| `format.tool_named` | 1.2× | HIGH_LEVERAGE_HOW_BEAT | name 1-2 tools, show logos; P1 heuristic: AI voiceover→ElevenLabs, static+Ken Burns→Canva/Pictory |
| `channel.video_count` | 1.1× | REQUIRED | integer; "only N" when <30 |
| `channel.subscribers` | 1.1× | REQUIRED | readable (436K, 1.2M) |
| `money.lump_sum` | 1.1× | HIGH_LEVERAGE | "that one video has probably made around $29,000" |
| `time.posting_year` | 1.1× | REQUIRED_FRAMING | "in {current_year}" in title + opening line |
| `video.views` | 1.1× | REQUIRED | every item cites ≥1 specific video view count |
| `format.production_type` | 1.0× | REQUIRED | always mention ("AI voiceover + animated visuals") |
| `social.comments` | 1.0× | P1 optional | — |
| `time.went_viral_in` | 1.0× | OPTIONAL | use sparingly |
| `format.video_length` | 0.8× | AVOID-BY-DEFAULT | only if duration IS the niche differentiator |

### AVOID slots (never render; skip entirely) — DP + SR "avoid_slots"

| id | uplift | rule |
|---|---|---|
| `money.rpm_exposed` | 0.75× | compute RPM internally; output dollar outcome only; never speak/show "views × RPM = $" |
| `social.likes` | 0.6× | never render like counts |
| `time.posting_window` | 0.53× | never "past N days"; if unavoidable drop "past" → "in 90 days" |

### Dollar trio rule — DP
`data.dollar_trio.required`: at least one of {money.yearly, money.daily, money.monthly} MUST fire per listicle item; prefer yearly when impressive, daily when round, monthly as fallback.

### Slot-fill priority order — DP JSON `slot_fill_priority`
`niche.category → channel.subscribers → channel.video_count → channel.age → video.top_video → video.views → one_of_dollar_trio → channel.upload_rate → growth.in_period → competition.zero_or_saturated → format.production_type → format.tool_named → channel.total_views → money.lump_sum` (drop when no data).

### Phase 2 proprietary slots — DP + SR "phase_2_proprietary_slots"

| id | render (all white text_card) | color / sfx / hold |
|---|---|---|
| `cohort.saturation_rank` | "Nth most-active channel in this niche" | inline_green on rank / ding / 1.5s |
| `cohort.growth_multiplier` | "N× the cluster median views per day" | inline_green / ding_rising_pitch / 1.5s |
| `novelty.embedding_distance` | "only N channels in our index look like this" | inline_green / soft_chimes / 1.5s |
| `cohort.first_mover` | "created N days ago, already top X%" | inline_green on both numbers / ding ×2 / 2.0s |
| `niche.emergence_rate` | "N new channels entered this niche in 60 days" | inline_green / ding / 1.5s |
| `cohort.ai_rank`, `cross_niche.format_import` | DP-defined, rendering TBD | — |
Optional "we tracked it" badge may brand proprietary cards (SR md).

### Data discovery constraints (channel selection feeding the video) — DD (skim)

| id | Rule |
|---|---|
| `discovery.A1` | 10,000 ≤ subscribers ≤ 5,000,000 |
| `discovery.A2` | Age-tiered top-video floor: >365d → ≥1M views; 180-365d → ≥500K; 90-180d → ≥200K; ≤90d → ≥100K |
| `discovery.A3` | top_video_views / subscribers ≥ 5 |
| `discovery.B1` | channel_age_days ≤ 730 (prefer ≤365, ideal ≤180) |
| `discovery.B2` | top video posted within last 12 months |
| `discovery.C1` | channel has ≥1 video in requested niche_tree cluster |
| `discovery.D1` | video_count ≥ 5 |
| `discovery.D2` | median_views / top_video_views ≥ 0.05 |
| `discovery.gate1` | consensus_picks_count ≥ 5 → 50% down-weight on tie-breaks |
| `discovery.gate2` | max K=3 channels per niche (default 2: hero + supporting); no two niches in same listicle share cluster_id |
| `discovery.gate3` | scale diversity per listicle: ≥1 channel in [10K,100K], ≥1 in [100K,1M], ≥1 in [1M,5M] subs |
| `discovery.count` | 5-12 channels per generated listicle |
| `discovery.score` | rank = 0.30·recency(exp(−age/365)) + 0.25·virality(min(ratio/100,1)) + 0.20·scale(bell μ=200K σ=400K) + 0.15·proof(min(top/10M,1)) + 0.10·novelty + consensus boost ≤1.2× − overpicked penalty floor 0.7× |

---

## TIMING RULES

| id | Rule | Values |
|---|---|---|
| `timing.per_niche_total` | One niche segment duration | ~35-60s; median 50s |
| `timing.segment_median` | Median visual segment length | 1.5-2.5s (MG median 1.6s) |
| `timing.max_hold` | No card held >2.5s unless explicitly specified | exception: money_shot card; grids 3-4s; recipe clips 2-4s |
| `timing.tts_fit` | Beat narrator text must be readable within hold_seconds × 1.05 | — |
| `timing.cold_open` | First segment ≤2s (snappier than MG's 1.42s baseline) | DP tricks list |
| `timing.intro_max` | Video intro ≤15s | SS |
| `timing.cta_max` | CTA ≤30s (~20s narration) | SS |
| `timing.hold_per_beat` | intro_card 0.8s; niche_name 1.5s; mascot_mosaic 2.0s; channel_proof_1 2.5s (narration 1.8s); channel_proof_2 2.0s (narration 1.5s); top_video_callout 2.0s (1.5-2.5s); top_views_seq 1.0s/card ×3; top_views_pano 3.0s; money_math 6.7s (~6-8s; sub-cards 0.8/1.5/1.5/0.8/1.8/0.8); recipe_demo 8.0s (2-4s/sample); concept_tag 1.2s (1-2s); appreciation 2.0s; transition 0.5s; subscribe 1.5s; next-video pitch 2.2s | SR |
| `timing.money_shot_holds` | $ reveal cards: yearly 1.8s, daily/monthly 1.5s, lump_sum final 1.8s; connectors 0.8s | SR money table |
| `timing.annotation_fade` | Yellow-circle fade-in 200ms | VP |
| `timing.duck_release` | Music duck release ~200ms | AX |
| `timing.sfx_durations` | See SFX enum (whoosh 150-400ms … sting 500ms) | AX |

---

## PACKAGING (title / thumbnail)

| id | Requirement |
|---|---|
| `packaging.title.year_framing` | Title and opening line must frame the video as "in {current_year}" (DP `time.posting_year`: REQUIRED_FRAMING, "Use in title + opening line") |
| `packaging.title.formula` | Explicitly NOT specified in these specs — DP "What's NOT in this v1 inventory": "Title formula — separate file when we get there" |
| `packaging.thumbnail` | Explicitly NOT specified — DP: "Thumbnail design rules — separate analysis; this file is about claims-in-video" |
| `packaging.structural_target` | Video structurally clones MG videoId 14563 (pacing, listicle structure, proof-first cold-open); secondary reference videoId 14435 (DP `phase_1_reference_videos`) |
| `packaging.listicle_shape` | N-niche listicle ("Number 1 … Number N"), per-niche template identical across niches, only variables differ (WE); ~16 variables per niche + global banks |