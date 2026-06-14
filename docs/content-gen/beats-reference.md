# Beats Reference — current production sequence (2026-06-11)

The authoritative list of every beat the listicle builder emits, in
render order, with the purpose each serves. Slot ids match the
`--labels` technical-mode overlays and the `clips/mg-beats/` anchor
library. Assembly: `lib/content-gen/listicle-builder.ts`
(buildListicleScript); narration master per niche group via continuous
TTS with word timecodes.

## Per-niche sequence (slot_id prefix `niche_N_`)

| # | slot_id | Purpose (narrative function) | Visual | Narration source |
|---|---|---|---|---|
| 1 | `intro_card` | List-position hook — tells the viewer a new item is starting and resets attention | logos montage, camera zooms into this niche's channel avatar | bank `intro_card` ("Number {N}:" / "." / ",") |
| 2 | `niche_name_card` | Names the niche — the "what is it" headline; word-by-word reveal synced to VO builds anticipation | white text card, word reveal | niche label (MG's own names for anchor renders; analysis label otherwise) |
| 3 | `channel_page_full` | Immediately grounds the niche in a REAL example + explains the content format (MG starts explaining at t=3.8) | full channel page screenshot | Gemini recipe line ("This channel narrates/compiles/…", 8-12 words, anti-parroting vs the niche name) |
| 3b | `channel_age_card` | The fast-growth hook — a YOUNG channel started recently (impressive recency) | standalone WHITE card, bold black, age fragment only, word-revealed (statement break) | `age_phrase` capitalized ("Only about four months ago."); fires ONLY when posting-start ≤ 4 months (first_upload-based); older channels get no age mention; about-highlight-age-rules.md A3/G3 |
| 4 | `emphasis_card` | Tension builder — opens the proof sentence and makes the viewer expect a big number | white text card with the opener words | bank `emphasis_intro` ("And the craziest part is," …); sentence completes over the next slot |
| 5 | `channel_proof_1` | Authority proof #1 — subscribers, OR the small-catalog hook | about-panel screenshot, animated L→R yellow box; boxes the SUBS row by default, or the VIDEOS row when the small-catalog hook fires | template: "this channel already has more than {subs} subscribers." — OR, when `video_count ≤ 12 AND (subs ≥ 10k OR views ≥ 100k)`: "This channel has posted just {N} videos, and already has more than {subs} subscribers." (smallness picker, about-highlight-age-rules.md G1/G4) |
| 6 | `top_videos_pano` | Abundance proof — the wall of content shows it's not a one-hit channel | videos-grid screenshot (tall crop) | bank `consistency_intro` ("And their views are absolutely unbelievable.") |
| 7-9 | `top_views_rapid_0..2` | Rapid-fire evidence — concrete view counts, accelerating rhythm | single video cards cropped from the videos tab | spoken counts read from the CAPTURE itself (always match the cards on screen) |
| 10 | `channel_proof_2` | Authority proof #2 — cumulative scale | about-panel screenshot, highlight on views row | template: "Over {tv} total views." (age moved to the dedicated `channel_age_card` at the reveal — A3/G3) |
| 11 | `top_video_callout` | Sets up the money math — isolates the single best-performing video | most-popular callout card (thumbnail + views) | template: "Their most popular video has more than {v} views." |
| 12 | `mm_opener` *(50%)* | Bridges callout → math ("Let's take that video…") | white text card | bank `money_opener_optional` |
| 13 | `mm_assumption` | Sets the conservative frame so the $ figure is believable | white text card | bank `assumption_modifier` ("Even if we assume" …) |
| 14 | `mm_rpm` | The RPM input — deliberately minimized ("just a $3 RPM") | icon card, shrug figure, green RPM | analyzed RPM (`channel_rpm.rpm_typical`, rounded; tier heuristic fallback) |
| 15 | `mm_geo` *(30%, rpm>$5)* | Justifies a high RPM via audience geography | white text card | template + `geo_guess` |
| 16 | `mm_translates` | The math connector — builds the reveal | white text card | bank `math_connector` ("that's roughly" …) |
| 17 | `mm_lump_sum` | THE money shot — the payoff number of the whole niche | giant green $ figure, ding | computed: top views × RPM |
| 18 | `mm_closer` | Caps the claim ("from ads.") — implies it's only part of the revenue | white text card | fixed template |
| 19-21 | `recipe_demo_0..2` | The actionability beat — HOW the videos are made; feeds "could I do this?" | the channel's REAL footage in the rounded mini-player (58%, watermark, lighter canvas), playing forward from the transcript-matched moment | transcript-grounded narration from `recipe_showcase.beats_jsonb` |
| 22a | `channel_b_chip` | Pattern proof opener — a SECOND channel succeeding with the same format; the chip carries the digits (name, @handle · subs · videos) ON SCREEN, never in voice | header chip card (~48% w, blends #0D0D0D, full button row) on the beat's seeded canvas (white or dark, constant within the beat) | bank `second_channel_opener` + format tail ("…makes the same kind of videos —"); B found via embedding KNN (hero top video → pgvector, sim ≥ 0.78), then RELATIONSHIP-VERIFIED (channel-b-verify.ts: format/subject axes via title-based Gemini classification, cached per pair) — the tail comes from the MG matrix: same/same → "same kind of videos"; same-fmt/diff-subj → "the exact same style, just with {SUBJECT}"; same-fmt/narrower → "videos only on {SUBJECT}"; diff-fmt/same-subj → "the same {SUBJECT}, but as {FORMAT}"; low confidence → n8 hedge "similar content". Both-axes-different is never shown. Double-B (n2 precedent): a strong same-fmt/diff-subj second candidate gets one compact page slot with the delta named |
| 22b | `channel_b_page` | Format-replication proof — the wall of same-template thumbnails | full page card (~61% w: banner→chip→tabs→sort chips→2 grid rows), static dead-hold, NO ken burns | age claim if `first_upload_at` known ("it started posting only X ago,") else performance claim — never digits |
| 22c | `channel_b_top_video` | The payoff number | LONE top-video card (~34% w) from a `videos_tab_popular` capture (Popular chip clicked → card_0 = top video) + 0.8s silent dwell on the number | "their most popular video has more than {N} views." — N read from the capture's own views_texts[0], rounded DOWN (voice never overshoots the card) |
| 23 | `saturation_callout` | Opportunity-scale proof — "many channels are doing this" | Form A (≥2 lookalikes): 2-3 sequential page cards (rapid, the cut rhythm IS the claim) → dark verdict card "and performing well" (pop-on) → dark ITALIC word-build "with the same format." · Form B (1 lookalike): page → consistency card → header-less GRID WALL (top row clipped mid-thumbnail) | fires when ≥ 20 channels clear sim 0.55; split worked-example line across the cuts. Pages are GATED to verified format_match=same channels (the line claims "same format"); adjacents count toward the cluster number but never get screen time — montage narration stays generic (MG never names channels there) |
| 24 | `transition` | Breathing room before the next item; resets pacing | blank dark card, 0.5s | silent (80%) / bank `transition_optional` vocal (20%) |

## Video-level beats

| slot_id | Purpose | Visual | Narration source |
|---|---|---|---|
| `cta_card_1` | The closer — wraps the list ("So, these are the eleven faceless niches.") | white text card | template + number-to-word (singular guard for 1-niche renders) |
| `cta_card_2` | Value affirmation — tells the viewer the list is actionable | checkmark icon card | bank `cta_value_card` |
| `cta_card_3` | Next-video pitch setup | pointing-hand icon card | fixed template ("If you want to discover more…") |
| `cta_card_4` | The action — carries the 17×-winner-coded "check out this video" phrase | icon card on dark + ascending sting | bank `cta_action_card` |

## Cross-cutting systems the beats ride on

- **Continuous narration**: one ElevenLabs call per niche group; slots are
  audio_slice windows that tile exactly — sentences flow across cuts
  (e.g. emphasis_card → proof_1).
- **Phrase banks + rotation**: 10 banks, seeded per render, no repeat
  within a video, last-50 history across videos
  (`content_gen_phrase_history`).
- **Word reveal**: text cards ≥4 words whose card text equals the
  narration pop word-by-word at the VO's timestamps.
- **Technical mode** (`--labels`): every slot stamped with its slot_id.
- **≤6 printed words per text screen** (MG rule): word-reveal cards PAGE —
  sentences longer than 6 words break onto fresh cards at punctuation
  boundaries, timed by the word timestamps.
- **Icons get dedicated screens** (MG rule): icon cards render the icon
  alone — no text. Sole sanctioned combo: the RPM-assumption card
  (shrug + "$3 RPM").
- **Background semantics** (decoded study, N=122 MG text cards): dark
  text cards are CONNECTORS inside dark visual runs (85% continuity);
  white cards are statement BREAKS. White-locked: intro/niche-name/
  emphasis/money/CTA/concept. Dark-locked: transition. Everything else
  inherits the previous slot's bg (`applyBgPolicy`). MG cadence: median
  2-3 cuts per bg before flipping; money/CTA may run long white.

## Removed / not emitted

- `concept_tag` — BENCHED 2026-06-11 (commented out in
  buildListicleScript; the essence/insight data still generates and
  caches — uncomment to re-enable).
- `mascot_mosaic` — removed 2026-06-11 (off-reference; user veto).
- `channel_intro` (chip) — removed; the recipe line plays over the full
  channel page per MG's pacing.
- chalkboard visual for concept_tag — scrapped (no chalkboard exists in
  the OG); renderer remains in image-gen, unused.

## Anchor-only beats (exist in MG, not yet in our sequence)

`appreciation` (banked, planned p=0.3) · `tool_plug` · `personal_demo` ·
`tips` — see `clips/mg-beats/<beat>/` for MG's executions of each.
(`channel_b_proof` + `saturation_callout` built 2026-06-11 via embedding
similarity — lib/content-gen/similar-channels.ts.)
