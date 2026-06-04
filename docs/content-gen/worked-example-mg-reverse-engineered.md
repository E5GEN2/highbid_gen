# Worked example — MG's "11 Hidden Faceless YouTube Niches Explained" reverse-engineered into a variable template

**Status:** Checkpoint — concrete proof that the script-skeleton + data inventory + content-analysis stack reduces a Money-Groot-style listicle into ONE per-niche template (in variable form) that any niche fills.

**Source:** MG videoId 14563 (121K views / 41.9K subs / 2.90× ratio), 454 segments, 14m04s.

**Method:**
1. Take MG's actual transcript
2. Identify each line as either: (a) a slot filling DATA, or (b) connective glue / banked phrase, or (c) FLUFF
3. Extract THE per-niche template using `{variables}` for every data point
4. Show ONE example render (niche 1 filled with MG's stickman-channel data) as a sanity check
5. Catalog the cuts

---

## What's actually templated

The whole point: there's **one per-niche template** that applies to all 11 niches. Niche 1, 2, ... 11 are all the SAME template with different data filling the `{variables}`.

```
For each picked niche:
  fill the template's variables from DB + content analysis
  → render the niche segment
```

So the artifact our system consumes is the template below — not 11 separate scripts. The fluff cuts and the fill example exist to validate the template covers MG's structure.

---

## THE PER-NICHE TEMPLATE (variable form)

This is what one niche-reveal segment looks like as a template. Every `{var}` is a slot filled per-niche by our pipeline.

```
─────── BEAT 1-2: NICHE REVEAL ───────

{bank.intro_card "Number {N}:"}
{niche_category_label}.

{recipe.channel_a_intro}
  ↳ Gemini fills using: channel_a.name, recipe_formula_simplified
  ↳ tone: "This channel {recipe_formula_simplified}." (with variation across niches)

─────── BEAT 4: CHANNEL A PROOF ───────

{bank.emphasis_intro}                          ← rotates per niche: "And the craziest part is" / "What's insane" / "The wild thing"
this channel already has more than {channel_a.subs} subscribers.

{bank.consistency_intro}                       ← rotates: "And their views are absolutely unbelievable." / "And every upload pulls real numbers." / "And the views back it up."

─────── BEAT 7: TOP-3 VIEWS RAPID SEQUENCE ───────

They have videos with
{channel_a.top_video_views[0]} views,
{channel_a.top_video_views[1]} views,
{channel_a.top_video_views[2]} views,
{channel_a.median_views_phrase}.
  ↳ derived: "and almost every single upload pulls in {median_view_class}"
  ↳ where median_view_class is computed from db.median(view_count)

─────── BEAT 9: MONEY MATH (6-CARD HYBRID) ───────

{bank.money_opener_optional}                   ← 50% probability: "Let's take that video" / "Take their top video" / skip
with {channel_a.top_video_views[0]} views.

{bank.assumption_modifier}                     ← rotates: "Even if we assume" / "If we assume" / "Let's say we assume"
{bank.rpm_qualifier} ${rpm} RPM,               ← rpm_qualifier rotates: "just a" / "" / (for low RPMs only)
{geo_context_card_optional}                    ← inserted if rpm > $5 with 30% probability:
                                                  "because the videos are {video_length_or_topic},
                                                   most viewers likely are from {high_cpm_countries}"

{bank.math_connector}                          ← rotates: "this would translate to" / "that's roughly" /
                                                  "that one video alone has probably made around" /
                                                  "the estimated earnings are"
${lump_sum}                                    ← computed: top_video_views[0] × rpm, rounded
from ads.

─────── BEAT 10: RECIPE DEMO (mini-player + narration) ───────

{recipe.recipe_demo_opener}                    ← Gemini varies per niche
  ↳ tone bank: "When you look at their videos, the editing style is extremely simple."
              / "Their videos are surprisingly simple."
              / "Once you watch a few, you see they're all the same recipe."

{recipe.recipe_extras_narration}               ← Gemini expands recipe_extras into 2-4 narration phrases
  ↳ data: recipe_extras = [...]                 (from analysis.recipe_extras)
  ↳ length: matches {clip_segment_count} mini-player visual beats
  ↳ tone calibration: emphasize "simply"/"just"/"extremely simple" for low-effort niches;
                      emphasize "the storytelling is very strong" for higher-skill ones

─────── BEAT 4 (REPRISE): CHANNEL B PROOF ───────

{bank.second_channel_opener}                   ← rotates: "There is another channel that" /
                                                  "And there's another channel" / "Look at this one"
{recipe.channel_b_intro_continued}             ← Gemini fills:
                                                  "{started_or_focuses_on} {recipe_formula_simplified}
                                                   just {channel_b.age_phrase},
                                                   and {channel_b.performance_phrase}"

{niche_saturation_callout_optional}            ← only if cluster_size > 20:
                                                  "And when you look around, you'll see many channels
                                                   doing this and performing well with the same format."

─────── BEAT 11: CONCEPT TAG (optional) ───────

{recipe.concept_tag_narration}                 ← only if concept_word is set
  ↳ "The number one thing you must focus on in this niche is {concept_word}."
     OR "Here's the thing — what makes these channels work is {concept_word}."
  ↳ visual: chalkboard with {concept_word} in chalk

─────── BEAT 12: APPRECIATION (optional, 30% probability) ───────

{bank.appreciation_phrase}                     ← used at most 2× per video, ~50-60% point in body
  ↳ "And if you're watching this far, I really appreciate it."
  ↳ "By the way, if you're still here, thank you."

─────── BEAT 13: TRANSITION ───────

(silent default; 20% probability of vocal cue from bank)
{bank.transition_optional}                     ← "Moving on," / "Next up," / "And finally..." (last niche only)
```

That's the entire per-niche template. **~15-20 narrator beats**, each backed by either a bank phrase, a slot variable, or a Gemini recipe.

---

## Variables this template references

Total of **~16 variables per niche** (+ a few globals):

| Variable | Source | Type | Example value |
|---|---|---|---|
| `N` | listicle orchestrator | int | 1, 2, 3, ... |
| `niche_category_label` | analysis.niche_category | string | (human-readable label from content analysis) |
| `channel_a.name` | discovery + db | string | (the picked channel name) |
| `channel_a.subs` | db.subscribers | int → phrase ("more than X") | 400,000 → "400,000" |
| `channel_a.video_count` | db.video_count | int | 122 |
| `channel_a.age_phrase` | db.age → phrase | string | "almost 5 months old" |
| `channel_a.top_video_views[0..2]` | db top-3 by view_count | int[] → phrases | ["29 million", "10 million", "8.8 million"] |
| `channel_a.median_views_phrase` | db.median(view_count) → phrase | string | "hundreds of thousands per upload" |
| `recipe_formula_simplified` | analysis.recipe_formula | string | (1-sentence "what they do" from Gemini Q&A) |
| `recipe_extras` | analysis.recipe_extras | string[] | (list of production specifics from Gemini Q&A) |
| `rpm` | db.rpm_cache[niche_topic] | $ amount | $1 / $3 / $6 / $10 |
| `lump_sum` | computed: top_views × rpm | $ amount → phrase | "$29,000" |
| `channel_b.*` | same shape as channel_a for 2nd pick | — | — |
| `cluster_size` | proprietary: cohort | int | drives saturation callout opt-in |
| `concept_word` | analysis.concept_word (optional) | string | "STORYTELLING" / "CONSISTENCY" |
| `geo_hint` | analysis.geo_hint (optional) | string | "US/UK for these shows" |

Plus banked phrase pools (no variable per generation — Gemini rotates):
- `bank.intro_card` — 3 niche-opener variants
- `bank.emphasis_intro` — 4-6 variants
- `bank.consistency_intro` — 4-6 variants
- `bank.money_opener_optional` — 3 variants + skip
- `bank.assumption_modifier` — 3 variants
- `bank.math_connector` — 4 variants
- `bank.second_channel_opener` — 3 variants
- `bank.appreciation_phrase` — 3 variants
- `bank.transition_optional` — 3 variants + silent default

---

## ONE example render — niche 1 filled with MG's actual stickman-channel data

For sanity check: feed the template the values MG happened to have, see what comes out.

**Variable fill (niche 1):**

```
N = 1
niche_category_label = "Funny Stickman Fails"
channel_a.name = "VES STICK"
channel_a.subs = 437000
channel_a.video_count = 122
channel_a.age_phrase = "almost 5 months old"
channel_a.top_video_views = [29_000_000, 10_000_000, 8_800_000]
channel_a.median_views_phrase = "hundreds of thousands per upload"
recipe_formula_simplified = "simply records gameplay of a stickman fail game and uploads it"
recipe_extras = ["troll-face / skull-face effects", "meme/movie clip inserts", "phonk music background"]
rpm = 1
lump_sum = 29000
channel_b.age_phrase = "3 months ago"
channel_b.performance_phrase = "getting really good views on every upload"
cluster_size = 24    (assumed; triggers saturation callout)
concept_word = null  (none specified; chalkboard tag skipped)
geo_hint = null
```

**Rendered output (template + variables → words):**

```
Number 1:
Funny Stickman Fails.
This channel simply records gameplay of a stickman fail game and uploads it.

And the craziest part is —
this channel already has more than 400,000 subscribers.
And their views are absolutely unbelievable.

They have videos with
29 million views,
10 million views,
8.8 million views,
and almost every single upload pulls in hundreds of thousands per upload.

Let's take that video
with 29 million views.
Even if we assume
just a $1 RPM,
that one video alone has probably made around
$29,000
from ads.

When you look at their videos, the editing style is extremely simple.
They record the gameplay,
add viral troll-face and skull-face effects,
and whenever something funny happens they cut to a meme or movie clip
to make the reaction even more hilarious.
They also use viral phonk music in the background
to keep the videos engaging.

There's another channel doing the exact same format,
just 3 months old,
and getting really good views on every upload.
And when you look around, you'll see many channels doing this
and performing well with the same format.
```

**Duration:** ~62s (vs MG's 116s for niche 1 — 46% shorter, same data delivered).

---

## SECOND example render — niche 2 (Roblox) from the SAME template

To show the template works on any niche, here's the same template filled with niche 2's data:

**Variable fill (niche 2):**

```
N = 2
niche_category_label = "Roblox Lore Explained"
channel_a.name = "Roblox Tales"     (placeholder — MG didn't name)
channel_a.subs = null               (MG didn't state — template skips subs line)
channel_a.total_views = 7_000_000   (using total_views since subs missing)
channel_a.top_video_views = null    (MG didn't enumerate top-3)
recipe_formula_simplified = "makes explanation-style videos about different Roblox games"
recipe_extras = []                   (light recipe — template renders fewer phrases)
rpm = 3
lump_sum = 21000
channel_b.age_phrase = null
channel_b.video_count = 6
channel_b.top_video_views[0] = 1_600_000
cluster_size = 8                    (low; triggers low-competition framing instead of saturation)
concept_word = null
geo_hint = null
extra_callout = "niche-link-to-7"   (forward-reference to niche 7)
```

**Rendered output:**

```
Number 2:
Roblox Lore Explained.
This channel makes explanation-style videos about different Roblox games
and has already gained more than 7 million views.

If we assume a $3 RPM, that's roughly $21,000 from ads.

There's another channel creating the same Roblox explaining content.
And despite uploading only 6 videos,
they have already received over 1.6 million views.

The best part about this niche is you'll never run out of topics —
Roblox has countless popular games people already love watching on YouTube.
And if you want to take this style beyond gaming,
don't miss niche number 7 later in this video.
```

**Duration:** ~38s.

Same template — different variables — different output. The skeleton bends to what data is present (skips top-3-views rapid sequence when no enumeration available, swaps in `total_views` framing instead).

---

## What FLUFF the template intentionally doesn't generate

Cataloged from MG's actual video — these are lines our template has no slot for, so they can't appear in our output:

| MG line | Niche | Why no slot exists |
|---|---|---|
| "I think they still don't get any copyright issues because the music is used only in short segments." | 1 | Production trivia — no slot. (Could be added as `production_observation` in v2 if content analysis surfaces it.) |
| "but if you want to try this niche for yourself, then it is always safer to use No-Copyright Phonk. You might already know this channel. They have a lot of no-copyright funk music that is free to use…" | 1 | Tool-channel plug — no slot. (Could be `tools_referenced` slot in v2 if we curate a tool DB.) |
| "To give you a better idea, I recorded a clip of this game and edited it in a similar style. So you can see how entertaining and simple these videos are to create." | 1 | Personal demo — no slot. Our system doesn't make demos in v1. (Phase 2: AI video gen could fill `generated_demo_clip` slot.) |
| "These videos take a lot of time and research, so consider subscribing. It helps me bring you more content like this." | 4 | Self-promo subscribe ask — no slot. |
| "This idea just came to my mind." | 7 | Filler interjection — no slot. |
| "This effect is available in almost every editing software." | 9 | Editing trivia — no slot. |
| "A while back I thought about starting a channel in this niche myself, but due to time constraints, I couldn't. Then I saw this channel's first video blow up to 5.6 million views. And here was my reaction. Oh! What!" | 11 | Personal regret + forced reaction — no slot. |
| "The lesson is clear. If you have an idea and just keep thinking about it or making excuses instead of starting, someone else might take action first, and you'll just be watching." | 11 | Moralistic preachy outro — no slot. |
| "Because I'll keep bringing you more valuable content completely free." | CTA | Self-promo — no slot. |

**Total fluff our template doesn't generate: ~80 seconds across the 14-minute MG video (≈10% of runtime).**

The cuts happen by absence — the template literally has no place for these because they don't map to data we deliver.

---

## CTA — the template (variable form)

```
{cta.closer_card}
  ↳ "So, these are the {N} faceless niches."

{cta.value_card}
  ↳ bank: "And each one has huge potential if you're serious about starting a channel."
         / "Any one of these could become a real channel."
         / "Pick one and run with it."

{cta.next_video_card}
  ↳ "And if you want to {cta_topic_phrase},"
  ↳ cta_topic_phrase variable: e.g. "discover 20 more faceless niches" / "see the AI tools they use"

{cta.action_card}
  ↳ MUST include "check out [this/next] video" phrase (17× winner-coded)
  ↳ bank: "just click on this video right here."
         / "check out this one."
         / "you'll want to see this one."
```

**Rendered for MG's data** (N=11, cta_topic_phrase="discover 20 more faceless niches"):

```
So, these are the 11 faceless niches.
And each one has huge potential if you're serious about starting a channel.

And if you want to discover 20 more faceless niches,
just click on this video right here.
```

~9s vs MG's 20s CTA (–55%), ending on the winner-coded phrase.

---

## What this template proves

1. **One template per niche** — the same skeleton applies to all 11 (and any future) niches. Variables differ; structure is constant.

2. **All variables have data sources** — every `{slot}` maps to either `db.*`, `analysis.*`, `discovery`, or `computed:` math. Nothing requires human input.

3. **The skeleton bends to data shape** — niche 2 (missing subs/top-3) renders differently from niche 1 (full data). The template tolerates missing slots by skipping their associated lines.

4. **Variation is built-in** — banks rotate per-niche within a listicle and per-generation across history. Same data, different phrasing each render.

5. **Fluff cuts are structural, not editorial** — the template has no slots for personal anecdotes, self-promo, or moralistic outros. They're impossible to generate by construction.

---

## What's NOT in this template (gaps to address later)

- **Visual b-roll for mini-player frames** — defined in `slot-rendering-class-b.json` but the template here is narration-only. The renderer composites b-roll onto the appropriate beats.
- **Tools-referenced slot** — niche 1's NCS plug, niche 9's ChatGPT/Claude mention, niche 10's GeoLayers reference. Could add `recipe.tools_referenced` slot in v2.
- **AI-generated demo slot** — replaces MG's "I tried it myself" personal demos.

---

## Next checkpoints (unchanged)

1. `asset-acquisition-spec.md` — per-primitive Playwright/yt-dlp/AI-gen recipes
2. `pipeline-architecture.md` — worker topology
3. `icon-library-asset-spec.md` — AI prompts for the 15 line-drawing icons
