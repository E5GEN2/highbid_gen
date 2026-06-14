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

### A1 — Age = POSTING START, not the "Joined" date (the deepest rule)

MG's spoken age routinely **contradicts the visible "Joined" row**, and
that is intentional — it speaks when the channel started *posting*, not
when the account was created:

| Niche | About-panel "Joined" | MG says | Gap |
|---|---|---|---|
| n10 Horizon | **Joined 6 Jun 2024** | "started posting only three to four months ago" | account ~1.5 yr, posting ~3 mo |
| n11 Mr. Science | **Joined 18 Mar 2022** | "started posting only one month ago" | account ~3 yr, posting ~1 mo |

This is **why the Joined row is never highlighted** (R-rule above): boxing
it would put a 2022 date on screen next to a spoken "one month ago." The
two coexist only because (a) the eye is never drawn to Joined, and (b) the
wording is always "started **posting**" / "started **uploading**" —
never "joined." → Our `age_phrase` must come from `first_upload_at`
(falling back to `channel_created_at`), and the narration verb must be
"started posting," never "joined." Keep the Joined row un-highlighted.

### A2 — The age card is ONE of two interchangeable "smallness" hooks

MG frames every fast-growing small channel as **"[big result] from a
[small input]"** — and the small input is EITHER recency (age) OR catalog
size (video count). It picks whichever number is more striking, sometimes
both. This is the unifying rule that ties the age card to the video-count
box (R2):

| Channel shape | Hook chosen | Example |
|---|---|---|
| Very small catalog (≤ ~12 videos) + big result | **VIDEO COUNT** (box) | n4 "only 10 videos → 1M views"; n8 "only 20 videos" |
| Moderate catalog (≈25–55) **but** posting ≤ ~4 mo | **AGE** (card) | n6 (51 vids / 2 mo); n10 (29 vids / 3–4 mo) |
| BOTH tiny (≤ ~8 videos AND ≤ ~1 mo posting) | **AGE + VIDEO COUNT** | n11 "one month ago with just 6 long videos" |
| Account OLD (years) but catalog small + result big | VIDEO COUNT only (age N/A) | n8 Minimunch (joined 2022, "only 20 videos") |
| Recent **but** high output (≈50+ videos, big result) | **NEITHER** — no "small input" exists | n7 (53 vids, May join) → just "look at this channel" |
| Old account + large catalog | NEITHER (state totals only) | n5 (2017/1,542), n9 (2014/515) |

So the age card's necessary conditions are **all** of:
1. posting start (first upload) is recent: **≤ ~4 months** (observed: 1,
   2, 3, 3–4 mo — never older);
2. the result is impressive for that span (real subs/views — the "blew up
   fast" story, not a dead channel);
3. the catalog is NOT itself tiny-enough to make video count the better
   hook (else MG uses the box instead, or both when both are extreme).

### A3 — Three positions + wording (the card is always a standalone WHITE
card, black bold text, age fragment only, word-revealed — even inside a
dark visual run, because it is a statement break)

| Position | When | Spoken sentence (card shows the **bold** fragment) | Refs |
|---|---|---|---|
| **Hero channel intro / page reveal** | young HERO, age is the opening frame | "This channel started posting **only {N} months ago**, and has already gained {result}." | n6, n11 |
| **Hero proof_2** (after the totals) | young HERO, age as the growth-speed frame + interpreting **kicker** | "Keep in mind, the channel started posting **only {N} months ago**, and these are usually good numbers for such a short span of time." | n10 |
| **channel_b fragment** | the SECOND channel is young | "{opener}… **just {N} month(s) ago**, and is already performing well [even in such a short time]." | n1-B, n10-B |

The interpreting **kicker** (`age_kicker` bank) attaches when age ≤ ~9 mo
("…and these are usually good numbers for such a short span"); we already
encode this in `proof2Text`.

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
- **G3 — DONE (2026-06-14, commit pending).** Age now renders as a
  standalone WHITE `channel_age_card` (age_phrase capitalized, word-
  revealed, white-locked) inserted right after the channel reveal
  (n6/n11 position), gated `age_months ≤ 4`; `proof2Text` stripped of
  age. Verified: "Only about four months ago." on NoFL (4mo). Position-
  2 (proof_2 +kicker) and channel_b age fragment remain as future
  variants.
  <strike>**G3 — Age as a standalone WHITE card (A3), not folded into a stats
  card.**</strike> Today we *speak* the age over the proof_2 views card
  (`proof2Text`) and over the channel_b page — neither emits a dedicated
  white age card with word-reveal. MG always pops a separate white card
  ("only 2 months ago") on the age words, in one of three positions (A3).
  To absorb: emit a white `text_card` whose text is the age fragment,
  word-revealed, white-locked even inside a dark run; place it at the
  hero intro (young hero) or proof_2 (+kicker), and as the channel_b
  fragment. Verb is "started posting," gate `age_months ≤ 4`.
- **G4 — One "smallness picker" shared by G1 and G3 (A2).** Don't decide
  the video-count box and the age card independently — they are the same
  hook in two forms. Per channel, compute: `recent = age_months ≤ 4`,
  `tinyCatalog = video_count ≤ ~12`, `strong = (subs ≥ 10k OR views ≥
  100k)`. Then:
  - `tinyCatalog && strong` → VIDEO-COUNT box + "with just {N} videos."
  - `recent && strong && !tinyCatalog` → AGE card.
  - `recent && tinyCatalog && strong` → BOTH (n11).
  - else → neither (state totals only — old channels, high-output recent
    channels like n7).
- **G5 — first_upload over Joined (A1).** `age_phrase` must derive from
  `first_upload_at` (we already do `first_upload_at ?? channel_created_at`
  in niche-vars) and the visible Joined row must stay un-highlighted, so a
  2022 "Joined" can sit under a spoken "one month ago" without conflict.

Threshold note: the ≤~12-videos / ≤4-months / ≥10k-subs edges are the
empirical bounds of the 11-niche OG sample — widen only with more
reference data.


### G3 correction (2026-06-14)
The age card must be a CONTEXTUAL sentence, never a bare fragment. A
first cut rendered "Only about four months ago." cold — no subject, and
"about" is not MG language. Fixed to the OG template **"This channel
started posting {age_phrase}."** (word-revealed) with MG phrasing
(niche-vars: "just one month ago" / "only {N} months ago", no "about"
for ≤4mo). The viewer always hears the subject + what happened.
