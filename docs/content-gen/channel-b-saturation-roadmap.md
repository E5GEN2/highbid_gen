# channel_b_proof / saturation_callout — further features roadmap

Status as of 2026-06-12, checkpoint tag `stable-local-render-2026-06-12`
(commit 022efbb). What is BUILT is documented in
`beats-reference.md` (rows 22a-c, 23), `channel-b-saturation-spec.md`
(canonical reference + frame-study corrections) and
`channel-b-saturation-gaps.md` (original gap analysis). This file is the
PENDING side only.

---

## Phase 2 — suggested-videos seeding loop (NEXT, user-confirmed design)

The honest gating built in Phase 1 exposed the real gap: for heroes like
phantomized the corpus holds only ONE same-format peer (Size Cipher), so
the saturation montage renders zero pages. YouTube's own suggestions are
the strongest "same audience / same format" signal and the ingestion
pipeline for them ALREADY EXISTS.

1. **Related-rail scraper** — new `lib/content-gen/related-videos.ts`:
   open the hero's TOP VIDEO watch page via the existing Playwright +
   xgodo-proxy stack (`watch_page` capture kind exists; add a related-rail
   extractor), collect the first 20-50 suggested `/watch` ids + channel
   handles from the secondary column (ytd-compact-video-renderer /
   lockup view-models).
2. **Feed the existing seed-expand pipeline** — `lib/video-seed.ts` +
   `/api/niche-spy/video-seed/expand` were built for exactly this input
   ("seed URL + batch of candidate URLs scraped from the suggested
   panel"). It resolves each URL to a `niche_spy_videos` row, EMBEDS
   immediately into `combined_v2`, cosine-compares vs the seed, persists
   to `niche_seed_expansions`. Because embedding happens at ingest,
   seeded channels are KNN-visible in the SAME render if seeding runs
   before `findSimilarChannels`.
3. **Timing decision**: block ~60-90s with a timeout cap (proceed with
   whatever embedded in time) so the current render benefits; otherwise
   fire-and-forget and only future renders improve.
4. **Suggestion-frequency rank boost** in
   `lib/content-gen/similar-channels.ts`: a channel appearing >= 2x in
   the hero's suggested rail is YouTube's own same-audience vote — add a
   bonus on top of the format-consistency score.
5. Run it BEFORE the rofe KNN per render (user requirement), so the
   corpus self-enriches over time.

## Phase 3 — polish

- Surface relationship verdicts in the producer Execution overwatch
  (currently only the `[similar]` log line:
  `B=Size Cipher (0.865, sfmt/ssubj/h) ... pool=[...]`).
- Re-tune thresholds once seeding fattens the pool: saturation pool bar
  (sim >= 0.55) can stay loose since pages are relationship-gated;
  CHANNEL_B_MIN_SIM 0.78 review.
- Double-B is implemented but has never fired live (needs a clean
  same/same B + a same-fmt/diff-subj candidate at sim >= 0.8) — verify
  the first time it triggers; n2's reference shape is one page + line,
  ~3-4s.

## Saturation form unlocks (from the gap analysis P2 backlog)

Attested MG forms we cannot render yet:

- **Form C — search results** (SC4, niche_6): new `search_results`
  ScreenKind in `yt-capture.ts` (BBOX_RULES + per-result card extraction:
  thumb, full title, views, age, channel name+avatar, description
  snippet). Query string derivable from the shared title-template n-gram
  across montagePool channels, or the niche label. NEW-build medium.
- **Constant-velocity inner-card scroll** for the Form B grid wall
  (reference: ~0.8-1.2 grid rows/s, content scrolls INSIDE the fixed
  rounded card, rows clipping at card edges; our wall is currently a
  static hold). Linear easing in scroll_record + composer-side card
  mask. NEW-build medium.
- **Form D — moat/contrast** (SC2/SC6): "the competition is low because
  this style is not easy to replicate. Unlike other channels that use
  simple {CATEGORY} videos." Needs (a) a contrast-grid selection query —
  low-median-view channels in an EASIER adjacent niche (niche_spy_channels
  x channel_analysis), shown via the existing videos_tab/wall capture;
  (b) the LOW/HIGH gauge infographic — drivable TODAY by the existing
  `saturationCount`. Note: Phase-1 verdicts now hand us the contrast
  channels for free — the gated-out diff-format candidates ARE the
  "unlike channels that..." pool (with `format_noun` naming what they
  do). NEW selection query + asset.
- **Form E — competition-acknowledged + timeline** (SC5): chess stock
  card, YT-Studio analytics graph card with tooltip scrub, calendar-flip
  animation. Pure asset-library work (see below).
- **Meme/infographic asset library** (Forms C/D/E + channel_b meme
  tails, 2/8 reference): typing memes (kitten/Jim Carrey class), LOW/HIGH
  gauge, calendar flip, emoji-crowd grid; `footage_card` /
  `infographic_card` compositions in image_gen. NEW-build large.

## channel_b polish backlog

- `sort=Oldest` videos-tab read for a TRUE "started posting" date when
  `first_upload_at` is NULL (gap D3) — currently the age claim is simply
  dropped for such channels (performance claim instead).
- Verdict-driven amplifier choice (spec 2A "proof-amplifier varies by
  claim"): views proof -> lone card (built); cadence proof -> Latest grid
  scroll; aggregate proof -> about panel. Only the lone card is wired.
- B meme reaction tails (CB3 Batman 0.27s / CB8 Donatello 0.9s) — needs
  the asset library.
- Twist subject_term phrasing review after more live samples (keep the
  2-4 word cap; never let Gemini prose into the voice track).

## Anchor-only beats (exist in MG, never emitted by us)

`appreciation` (banked, planned p=0.3) · `tool_plug` · `personal_demo` ·
`tips` — executions in `clips/mg-beats/<beat>/`.

## Operational notes

- All of the above is LOCAL-verified only; nothing pushed to Railway.
  Before pushing: one full multi-niche listicle render (the niche loop is
  unchanged but only single-niche was verified this round), then
  `git push --tags` to carry `stable-local-render-2026-06-12`.
- Verdict cache (`content_gen_channel_relationships`) lives on the MAIN
  DB and is shared local/prod; table exists on both (created manually on
  Railway 2026-06-12; initSchema carries it for fresh boots).
