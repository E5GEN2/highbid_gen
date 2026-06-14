# Meme placement & selection rules (Class B)

Derived from the OG MG decode (video_analysis_jobs id=1, video 14563 —
454 segments, 61 meme/clip cutaways). **Corpus = OG MG only** (user
decision 2026-06-12): purest clone of MG's taste, consistent with
treating MG as the pivot anchor.

This is NOT a new subsystem. It is two additions to
`script-skeleton-class-b` (the existing narration formula where every
beat is a Gemini recipe with MG calibration examples):
1. **Placement** — a per-beat `meme_eligible` flag + one hard rule.
2. **Selection** — a new Gemini recipe that picks a meme from the asset
   catalog by context (the skeleton's own pattern), with the OG MG
   concept→meme pairs as calibration examples (not a hardcoded lookup).

---

## R1 — the hard rule: numbers are never a meme

Across all 61 OG MG meme cutaways, **zero** land on a subscriber count,
view count, RPM, dollar figure, video count, or age. Every number lives
on a text card, a screenshot, or the icon. This is the inverse of
"numbers on screen, claims in voice": a meme-eligible beat must never
carry a data-claim line. Enforced structurally — data beats are
`meme_eligible: false`, so selection is never even called for them.

## R2 — placement = beat eligibility (maps onto the skeleton beat table)

Meme cutaways cluster on the rhetorical / advice / emotional "talking to
you" tissue and avoid the evidence beats. OG MG counts by beat (61
total): tips 16 · concept_tag 10 · recipe_demo 9 · money_math 5 ·
personal_demo 5 · saturation_callout 5 · intro_card 3 · transition 2 ·
channel_b 2 · cta 2 · tool_plug 1.

| Skeleton beat | meme_eligible | form | note |
|---|---|---|---|
| niche_name_card | NO | — | carries the niche label / number |
| channel_proof_1 / channel_proof_2 | NO | — | subs / views — data |
| top_video_callout, top_views_seq, top_views_pano | NO | — | view counts — data |
| money_math · lump_sum sub-card | NO | — | the payoff number |
| channel_b chip / page / top_video | NO | — | screenshots + the payoff number |
| money_math · assumption / opener / translates | YES | card | the opinion line, not the payoff |
| saturation_callout (moat lines) | YES | card | "competition is low because it's not easy" |
| transition | YES | card | connective aside |
| video_cta | YES | card | "consider subscribing" reaction |
| concept_tag | YES | card | the niche-essence aside (currently benched) |
| recipe_demo | YES | overlay | troll-face / clip inserts ON the channel's footage |
| tips / personal_demo / appreciation / tool_plug | YES | card | MG's heaviest meme beats — NOT emitted by us yet |

**Form split:** `card` = meme replaces the text card on an aside;
`overlay/tail` = meme punctuates a screenshot/footage beat (troll-face on
recipe_demo footage; the 0.3–0.9s reaction tail after channel_b). The
selection recipe must know which form the beat takes.

**Coverage reality:** MG's meme density lives mostly in `tips`,
`concept_tag` (benched), and `personal_demo` — beats we don't emit.
Intersected with our current beat set, memes land on: money_math asides,
saturation moat lines, transition, video_cta, channel_b tails,
recipe_demo overlays. To approach MG's meme surface we'd also un-bench
`concept_tag` and/or add a `tips`-style aside beat.

## R3 — budget, duration, sync (fold into skeleton `pacing_constraints`)

- **Budget:** ~15–20 genuine reaction-memes across 844s ≈ **1 per
  ~45–55s**. They come in RUNS on advice beats, then go silent across the
  whole data stretch. Cap per niche so no niche becomes meme-soup.
- **Duration:** 0.6–2.5s (median ~2s) — shorter than the 3–8s screenshot
  beats.
- **Sync:** hard cut in/out, **keyword-locked** — the meme lands on the
  operative word of the line.

## R4 — selection = a Gemini recipe (context → meme), NOT a static map

Same architecture as every skeleton beat recipe. For a beat that fired
its meme slot (eligible + budget remaining), call Gemini:

```
Input:
  - beat_id, form (card | overlay)
  - narration_line        (the exact spoken text for this slot)
  - niche_context         (niche label + recipe_formula)
  - meme_asset_catalog    (available royalty-free assets: id, concept tags, duration)
  - budget_remaining      (memes left for this niche / video)

Calibration (verbatim OG MG concept → meme, as few-shot examples):
  - "isn't easy" / "not simple" / "every single day" / "simple … videos"
        → typing/effort clip   (cat / Donatello / Jim-Carrey-class at a keyboard)
  - "if we assume" / "$X RPM"        → shrug + question marks (Flork)   [already built]
  - "here's a crazy idea" / "came to my mind"  → lightbulb / thinking shot
  - "you might say…"                  → skeptic reaction (talk-to-camera)
  - "not everyone can make this"      → frustration reaction
  - "here was my reaction. Oh! What!" → celebrity-class reaction clip
  - "makes the audience watch"        → watching-TV reaction

Output: { asset_id }  OR  "none"
  - "none" → keep the text card (no fit, or low confidence). DEFAULT-SAFE.
```

Selection is adaptive to context and the catalog; the calibration pairs
steer taste without freezing the mapping. Ineligible beats (R2) never
reach this step, so R1 cannot be violated.

## R5 — dependency: the royalty-free asset catalog

Gemini can only pick from what exists, so the rule is only as good as the
catalog. The OG MG concept clusters ARE the required-coverage spec:

  effort/typing · uncertainty/shrug · idea/lightbulb · skeptic ·
  frustration · personal-reaction · watching/audience

**Rights caveat:** MG uses copyrighted film/TV/celebrity clips as memes
and absorbs the exposure. Our catalog should source the same FUNCTIONAL
slots from genuinely royalty-free / CC / public-domain stock — same
grammar, clean rights. This is the `meme/infographic asset library
(NEW-build large)` item in `channel-b-saturation-roadmap.md`.

## How it plugs into the skeleton (minimal change)

1. Add `meme_eligible` + `meme_form` to each beat in
   `script-skeleton-class-b.json` per the R2 table.
2. Add a `meme_budget` to `pacing_constraints` (R3).
3. Add the R4 recipe as a `meme_selection` recipe block (parallel to the
   per-beat narration recipes); it runs AFTER narration per slot, gated by
   `meme_eligible && budget_remaining`, and returns an asset_id or "none".
4. Builder: when selection returns an asset_id, emit the meme as a `card`
   (replaces the text_card gem) or `overlay` (composites on the footage)
   per `meme_form`; "none" → unchanged text card.
