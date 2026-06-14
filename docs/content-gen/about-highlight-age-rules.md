# About-panel highlight & channel-age rules (from the OG MG decode)

Source: full timeline decode of the pivot anchor (`video_analysis_jobs`
id=1, video 14563 — 454 segments) cross-referenced with `mg-og-beat-
spans.json` and frame-confirmed on `clips/mg-beats/`. Covers all **25**
yellow-highlight events and all **8** channel-age treatments in the OG.

User question (2026-06-12): "MG sometimes yellow-highlights the VIDEO
COUNT and/or does a text card about the channel's AGE — when?"

---

## THE ONE RULE FOR THE YELLOW BOX

**The yellow highlight tracks the SPOKEN number.** At each moment MG
boxes exactly the about-panel stat the narration is citing — subscribers,
video count, OR views — and nothing else. The "Joined" date row is
**never** boxed in any of the 25 events.

Corollaries, all observed:

- **R1 — Multiple stats in one sentence → multiple boxes.** When the
  sentence names two stats, both rows are boxed (sequentially as each is
  spoken, both visible by sentence end):
  - n8 channel_intro: *"…only 20 videos and already gained almost 80,000
    subscribers"* → **20 videos** + **79.2k subscribers** both boxed.
  - n8 channel_b: *"almost 50,000 subscribers with just 19 videos"* →
    **48.4k subscribers** + **19 videos** both boxed.
  - n4 proof_2: *"only 10 videos … over 1 million views"* → **10 videos**
    + **1,032,678 views** both boxed (frame-confirmed; Joined NOT boxed).
  - n3 channel_b: *"…subscribers … views"* → subs + views boxed, the
    "2 videos" row left alone (not spoken).
- **R2 — Video count is boxed IFF it is spoken.** It is spoken only on
  the **small-catalog hook**: "only/just N videos" paired with an
  outsized result. Boxed: 6 (n2-B), 10 (n4), 19 (n8-B), 20 (n8). NOT
  boxed despite tiny catalogs, because the line never says the number:
  2 videos (n3-B), 7 (n11), 14 (n10-B), 29 (n10) — those beats spoke
  subs/views instead, so subs/views got the box.
- **R3 — Default proof grammar (when video count is NOT the hook):**
  `channel_proof_1` boxes **subscribers**, `channel_proof_2` boxes
  **views** (often + subscribers when the sentence opens with subs). This
  is our current behaviour and it matches MG for large-catalog channels.
- **R4 — Visual treatment** (already built, `about_panel` +
  `highlight_row`): opaque marker `#E7F61A`, covered text flipped dark,
  L→R sweep, anchored exactly on the row text. Supports
  `subscribers | videos | views` today — we simply never request
  `videos`.

### When does MG SPEAK the video count? (so it can be boxed)

The small-catalog-big-output contrast — the "could I do this?" hook:

| Pattern | Example | Boxed |
|---|---|---|
| `only {N} videos … {big views}` | "only 10 videos … over 1 million views" (n4) | videos + views |
| `only/just {N} videos … {big subs}` | "only 20 videos … almost 80,000 subscribers" (n8) | videos + subs |
| `{big subs} with just {N} videos` | "almost 50,000 subscribers with just 19 videos" (n8-B) | subs + videos |

Heuristic threshold from the data: video count is spoken when the
catalog is **≤ ~25 videos AND** the channel still has a strong result
(≥100K views or ≥10K subs) — i.e. views-per-video or subs-per-video is
remarkable. Above ~50 videos it is never spoken (n5=1,542, n9=363/515,
n7=53 all stay silent on count).

---

## CHANNEL AGE — never a box, always a text card

Age is **never** a yellow highlight (the Joined row is never boxed). It
is delivered two ways, together:

1. **Spoken** in the proof/channel_b narration: "started posting only
   {X} ago".
2. **A dedicated WHITE text card** showing the age phrase, popped on the
   spoken words. Confirmed instances:
   - n1 channel_b: white card **"just 3 months ago"** (t=86.4)
   - n6: white card **"only 2 months ago"** (t=402)
   - n10 proof_2: spoken "three to four months ago" + interpreting kicker
   - n10 channel_b: white card **"just one month ago"** (t=729)
   - n11 channel_intro: spoken "only one month ago" + **"with just 6
     long videos"** card

### When does the age card fire?

**Only when the channel is YOUNG and the recency is impressive** — every
age treatment in the OG is **≤ 4 months** ("one/two/three-to-four months",
"just a month"). Older channels get NO age mention at all:
- NOT mentioned: n5 (Joined 2017), n9 (2014 / 2022), n7 (May 2025 but
  53 videos — age not the hook), n3-B Norway (Dec 2024).
- The age claim also pairs with an **interpreting kicker** when ≤9 mo
  ("…and these are usually good numbers for such a short span of time"),
  which we already encode in `proof2Text` + the `age_kicker` bank.

---

## How this maps to our system

What we already do right (keep): proof_1=subs box, proof_2=views box
(R3); marker treatment (R4); "started posting X ago" spoken +
`age_kicker` ≤9mo (age spoken side); the `channel_b_fragment` white age
card.

Gaps vs MG, to absorb (see `beats-reference.md` for slot wiring):

- **G1 — Video-count box (R1/R2).** When the small-catalog hook fires
  (catalog ≤~25 AND strong result), (a) the narration should SPEAK the
  count ("with just {N} videos"), and (b) the matching proof slot should
  request `highlight_row: 'videos'`. Plumbing exists; only the trigger +
  narration template are missing. Builder owns the decision (it has
  `video_count`, `subscriber_count`, `total_views` on `ChannelData`).
- **G2 — Dual-row highlight (R1).** When one sentence cites two stats,
  box both. Today each proof slot highlights a single row. Either split
  into two micro-highlights timed to each spoken number, or let
  `highlight_row` accept an array; the marker-bake pass already finds the
  row by text, so two rows = two baked sweeps.
- **G3 — Age as a dedicated card in the HERO proof (not just
  channel_b).** MG floats a white "only 2 months ago" card during the
  hero proof for young channels (n6, n11). We currently fold age into the
  proof_2 views-card narration; a dedicated young-channel age card would
  match MG. Gate: `age_months ≤ 4` (the observed ceiling).

Threshold note: the ≤~25-videos / ≤4-months numbers are the empirical
edges of the 11-niche OG sample — widen only with more reference data.
