# Class B script skeleton (v1)

**Status:** Checkpoint — the narrator script architecture for Class B generation.
**NOT** a static template. The skeleton is a **formula with prompt recipes** — each beat references variables (slot data) and contains a Gemini generation recipe with tone calibration from Money Groot's actual speech. The output VARIES across generations while staying tone-locked.

---

## Why this is a formula, not a template

If we wrote literal text templates (`"Number {N}: {niche_name}. This channel has {subs} subscribers..."`) every generated video would sound identical. Viewers would catch the repetition instantly.

The skeleton:
1. **Defines the beat structure** — what gets said at each visual beat (mirrors `slot-rendering-class-b.json`)
2. **References variables** — slot data filled by data discovery + content analysis
3. **Contains generation recipes** — per-beat Gemini prompts with verbatim Money Groot examples for tone calibration + variation constraints
4. **Compiles to a meta-prompt** — one Gemini call per video produces the complete narrator script

The output of one generation is a script with timestamped narrator phrases that hit every beat with the right data, in the right tone, without duplicating phrasing across niches in the same video OR across recently-generated videos.

---

## Single-call architecture

For one generated video:

```
INPUT to Gemini call:
  - script_skeleton (this doc, baked as system prompt)
  - filled_slot_data: per-niche channel data + computed money math + niche labels
  - listicle_meta: { niche_count, intro_framing, cta_target_video }
  - variation_history: last N narrator phrases from recent generations (anti-repetition)

OUTPUT from Gemini call:
  - JSON: timestamped beat-by-beat script
    [{ beat_id, narrator_text, hold_seconds, audio_cue }, ...]
  - clean text for TTS (no markup)
  - per-beat narration matched to per-beat visual + audio renderings
```

One call, one script. ElevenLabs then TTS-es each beat's text into per-beat WAV files.

---

## The beat skeleton (per niche)

Each niche segment has 13 beats from `slot-rendering-class-b.json`. The skeleton assigns narration to each — some beats have narrator phrases, some are silent (voice already finished the previous beat, current beat is purely visual).

| # | Beat | Has narration? | Variables | Recipe type |
|---|---|---|---|---|
| 1 | intro_card (Number N) | YES | `niche_number` | bank-based |
| 2 | niche_name_card | YES | `niche_category_label` | hybrid (template + variation) |
| 3 | mascot_mosaic | NO | — | silent visual |
| 4 | channel_proof_1 (subs + video_count) | YES | `channel_name`, `subs`, `video_count`, `channel_age_days` | Gemini-generate |
| 5 | channel_proof_2 (age + total_views) | YES | `channel_age`, `total_views` | Gemini-generate |
| 6 | top_video_callout | YES | `top_video_views`, `top_video_age` | Gemini-generate |
| 7 | top_views_seq (3-5 rapid thumbnails) | YES | array of `top_video_views` | rapid sequence |
| 8 | top_views_pano (grid) | YES | summary stat | Gemini-generate |
| 9 | money_math (6 sub-cards) | YES | `rpm_used`, `lump_sum_dollars` | hybrid (math frame + variation) |
| 10 | recipe_demo (mini-player + narration) | YES | `recipe_formula` (from content analysis) | Gemini-generate |
| 11 | concept_tag (chalkboard) | YES | `concept_word` (from content analysis) | hybrid |
| 12 | appreciation_optional | YES (sometimes) | none | bank-based, ~30% probability |
| 13 | transition | NO (or 1-2 word) | next `niche_category_label` | bank-based |

Plus three video-level beats outside the per-niche loop:
- **Intro** (video opens, 0-15s): hook + listicle promise
- **CTA** (video closes, last 30s): "if you want more, check out this video"
- **Inter-niche transitions** between niche segments

---

## Per-beat recipe specs

Each recipe specifies: **(a) variables it references, (b) tone examples from Money Groot's actual speech, (c) variation constraints, (d) output spec.** Gemini fills the recipe at generation time.

### Beat 1: intro_card (Number N)

**Variables:** `{niche_number}` (integer 1..N)

**Recipe type:** Bank-based — small set of fixed openers, varied across niches in the same listicle so the same phrasing doesn't repeat.

**Bank (mined from MG):**
- `"Number {N}:"`
- `"Number {N}."`
- `"Number {N},"`

**Output spec:** 1 short phrase, 2-4 words. Hold 0.8s on the card.

**Variation rule:** alternate punctuation across niches; never use the same form 3× in a row.

---

### Beat 2: niche_name_card

**Variables:** `{niche_category_label}` (string from content analysis, e.g. "Funny Stickman Fails")

**Recipe type:** Hybrid — primarily just the label, occasionally with a tiny qualifier.

**Bank:**
- `"{niche_category_label}."` (default — used 7/11 times in MG)
- `"{niche_category_label}, {short_qualifier}."` (occasionally, e.g. "True Horror Stories.")

**Output spec:** ≤6 words. Hold 1.5s.

**Variation rule:** if the niche label is already in beat 1 ("Number 6, Personality Quizzes"), skip beat 2.

---

### Beat 4: channel_proof_1 (subs + video count)

**Variables:** `{channel_name}`, `{subs}` (e.g. "400,000"), `{video_count}` (e.g. 122), `{channel_age_phrase}` (e.g. "almost 2 years old", "only 3 months old")

**Recipe type:** Gemini-generate using these tone examples for calibration.

**Tone examples (verbatim from MG):**
- *"This channel already has more than 400,000 subscribers."*
- *"This channel makes explanation style videos"* (when proof_1 also intros recipe)
- *"This channel literally ranks letters and numbers"*
- *"There is another channel that started making the same kind of videos just 3 months ago"*
- *"This channel has posted only 20 videos"*

**Prompt recipe:**
```
Write a single sentence introducing a faceless YouTube channel as part of a niche
listicle. Use the calm-educational voice of Money Groot (NOT high-energy vlogger
style).

Required data to convey (in flowing prose, NOT a list):
  - Channel name: {channel_name}
  - Subscribers: {subs}
  - Optionally: channel age phrase ({channel_age_phrase}) — include if it's
    impressively young (≤6 months old)
  - Optionally: video count ({video_count}) — include if remarkably low (<30)

Tone calibration examples (DO NOT copy verbatim; use as voice reference only):
  - "This channel already has more than 400,000 subscribers."
  - "This channel started posting quiz-style videos only two months ago, and..."
  - "This channel has posted only 20 videos and already gained almost 80,000 subscribers."

Variation rules:
  - This is channel #{channel_index_in_listicle} in the listicle. Vary your
    opener: use "This channel..." for the 1st channel of a niche; use "There's
    another channel that..." or "And there's another channel..." for additional
    channels in the same niche.
  - Avoid repeating phrasing from these recently-used openers across all videos
    we've generated: {variation_history_openers}
  - Maximum 1 sentence, 15-25 words.

Output: the single sentence as plain text.
```

**Output spec:** 1 sentence, 15-25 words. Hold matches the visual card hold (~1.8s).

---

### Beat 5: channel_proof_2 (age + total views)

**Variables:** `{channel_age_phrase}`, `{total_views}` (e.g. "13 million", "800 million")

**Recipe type:** Gemini-generate or skipped (if beat 4 already covered age).

**Tone examples:**
- *"The channel has already gained over 13 million total views."*
- *"And their channel has a mind-blowing total of more than 800 million views."*
- *"Now, it has gained 50k subscribers and is doing..."*

**Prompt recipe:**
```
Continue the channel introduction with a second-pass stat reveal. Lean into
TOTAL VIEWS as the "across the channel" anchor.

Required: {total_views} total views, optionally pair with {channel_age_phrase}
or {video_count}.

Tone calibration:
  - "The channel has already gained over 13 million total views."
  - "And their channel has a mind-blowing total of more than 800 million views."
  - "has almost 7 million subscribers" (when subs are the bigger number than views)

Modifiers to inject for emphasis (rotate, don't repeat):
  - "already" (signals recency)
  - "over" / "more than" / "almost" (rounding direction)
  - "mind-blowing total" (for very impressive scales)
  - "literally" (for unexpected/surprising figures)

Skip this beat entirely if beat 4 already used "total views" or covered age.

Output: 1 sentence, 12-20 words.
```

---

### Beat 6: top_video_callout

**Variables:** `{top_video_views}` (e.g. "29 million", "1.37 million"), `{top_video_age_months}`, optionally `{top_video_title_snippet}`

**Recipe type:** Gemini-generate.

**Tone examples:**
- *"Their most popular video has more than 1 million views."*
- *"That video got over 1 million views."*
- *"this channel made a video called 15 horror movies"*

**Prompt recipe:**
```
Call out THE single most popular video on the channel. This is the proof anchor.

Required: {top_video_views} (specific number).
Optionally include: {top_video_age_months} ago, or {top_video_title_snippet}.

Tone calibration:
  - "Their most popular video has more than 1 million views."
  - "That video got over 1 million views."
  - "this channel made a video called {title} and it got {views} views"

Variation rule: alternate between "their most popular video", "their top video",
"this one video" — never the same phrase twice in a row across the listicle's
top_video_callout beats.

Output: 1 sentence, 10-18 words.
```

---

### Beat 7: top_views_seq (rapid-fire 3-5 thumbnails)

**Variables:** array of `{top_video_views[1..N]}` (e.g. ["29 million", "10 million", "8.8 million"])

**Recipe type:** Rapid sequence — each card holds 1s with a single short phrase.

**Tone examples (verbatim from MG):**
- *"29 million views,"* / *"10 million views,"* / *"8.8 million views,"*

**Prompt recipe:**
```
Generate a rapid-fire enumeration of the channel's top {N} video view counts,
one per visual card. Each card holds ~1s.

Required: {top_video_views_array} = [{view_count_1}, {view_count_2}, ...]

Output format: an array of {N} short phrases, each 2-4 words, ending in a comma
for cards 1..N-1 and a period for the last:
  ["29 million views,", "10 million views,", "8.8 million views..."]

Variation rule: optionally prepend "and" to the last card ("and 8.8 million
views.") for natural rhythm.

Do NOT introduce new data — just enumerate the numbers given.
```

---

### Beat 8: top_views_pano (the grid summary)

**Variables:** `{view_consistency_phrase}` — derived from median-to-top ratio (e.g. "almost every upload pulls in hundreds of thousands of views")

**Recipe type:** Gemini-generate.

**Tone examples:**
- *"and almost every single upload pulls in hundreds of thousands of views."*
- *"And their videos consistently pull really good views."*
- *"And their view consistency is amazing."*

**Prompt recipe:**
```
Sum up the channel's consistency in one sentence — moving from individual top
videos to the "they hit consistently" framing.

Variation bank (rotate, don't repeat across niches):
  - "and almost every single upload pulls in hundreds of thousands of views."
  - "And their videos consistently pull really good views."
  - "And their view consistency is amazing."
  - "and consistently get over {typical_median_views} on every upload."

Pick variation by injecting the channel's actual median-views number when it's
impressive (>100K), or use the generic consistency phrasing otherwise.

Output: 1 sentence, 10-15 words.
```

---

### Beat 9: money_math (6 sub-cards)

**Variables:** `{rpm}` (USD, e.g. "$1", "$6", "$10"), `{base_views}` (the views figure the math is computed on), `{result_dollars}` (the outcome figure)

**Recipe type:** Hybrid — math frame is fixed (assume → conclude), connectors vary.

**Tone examples (verbatim sequences from MG):**
```
Niche 1 (29M view video × $1 RPM):
  "Let's take that video"
  "with 29 million views."
  "Even if we assume"
  "just a $1 RPM,"
  "that one video alone has probably made around"
  "29,000"
  "from ads."

Niche 2 ($3 RPM):
  "If we assume a $3 RPM, that's"
  "roughly $21,000 from ads."

Niche 4 ($6 RPM with geo context):
  "If we assume a $6 RPM,"
  "because the videos are long and most viewers... likely are from countries like"
  "the US and UK."
  "This would translate to"
  "about $6,000"
  "from ads."
```

**Sub-card recipe:**
```
Generate a 4-6 card sequence revealing the channel's estimated earnings on its
top video. Use the assumed RPM = {rpm} and base views = {base_views}.

Card sequence template (vary connectors, anchor math):
  Card 1 (opener, optional): "Let's take that video" / "Take their top video"
                              / (skip and go straight to card 2)
  Card 2: "If we assume" / "Even if we assume"
  Card 3: "{rpm} RPM," / "just {rpm} RPM,"
  Card 4: "this would translate to" / "that's roughly" / "the estimated earnings are"
           / "that one video alone has probably made around"
  Card 5: "{result_dollars}" (the money shot — green text, ding SFX)
  Card 6: "from ads." (closer)

Geo-context insertion (optional, only if {rpm} > $5):
  Between card 3 and card 4, insert a "because viewers are from {high_cpm_countries}"
  card (e.g. "because the videos are long and most viewers likely are from the US
  and UK"). Skip this expansion 70% of the time to keep the math sequence short.

Variation rules:
  - Never use the same connector phrase twice in the same listicle's money-math
    beats (track usage across niches).
  - For low RPM ($1-$3): use "just" or "Even if we assume" modifier.
  - For higher RPM ($6-$10): use "if we assume" without minimizer; consider the
    geo-context insertion.

Output: array of 4-6 short cards (1-6 words each).
```

---

### Beat 10: recipe_demo (recipe formula narration)

**Variables:** `{recipe_formula}` (from content analysis, a 1-sentence summary of what the channel does), `{content_clip_segments}` (visual b-roll references)

**Recipe type:** Gemini-generate — needs to expand 1-sentence recipe formula into 2-4 connected sentences while mini-player plays the actual content.

**Tone examples:**
- *"This channel simply records gameplay of a funny stickman game and uploads it."* (initial recipe drop)
- *"When you look at their videos, the editing style is extremely simple."*
- *"They just record the gameplay, add those viral troll or skull face effects, and whenever something funny happens, they insert quick meme or movie clip edits..."*
- *"On top of that, they use viral fonk music in the background..."*

**Prompt recipe:**
```
Narrate the channel's content recipe across {content_clip_segments} visual beats.
The mini-player frames will show actual content from the channel while you narrate.

Input data:
  - recipe_formula: {recipe_formula}
    (one-sentence summary of what the channel does, from content analysis)
  - additional_details: {recipe_extras}
    (specific elements observed: stock footage, text overlays, music style, etc.)
  - clip_segment_count: {N}  (how many mini-player beats to fill, typically 3-5)

Tone calibration (verbatim MG examples):
  - "This channel simply records gameplay... and uploads it."
  - "When you look at their videos, the editing style is extremely simple."
  - "They just record the gameplay, add those viral troll or skull face effects..."
  - "On top of that, they use viral phonk music in the background..."

Structure your narration as a flowing description that walks through the recipe:
  Beat 1: opening recipe summary ("This channel simply..." or "They take..." or
           "When you look at their videos...")
  Beat 2: editing/production specifics ("They just..." / "On top of that, they...")
  Beat 3-N: additional elements + outcome ("which makes the audience watch till
            the end" / "and keeps the videos engaging")

Variation rules:
  - Connectors: alternate "And", "On top of that,", "When you look at...", "They
    also...", "What's interesting is..." — never the same opener twice within
    the listicle.
  - For low-effort recipes (gameplay, screen recording): emphasize "simply",
    "just", "extremely simple" to drive the "you could do this" narrative.
  - For higher-skill recipes (animation, scripting): emphasize "the storytelling
    is very strong" type framing — implies effort but achievable.

Output: array of {N} narration phrases, each 12-22 words, designed to play over
the corresponding mini-player visual beat.
```

---

### Beat 11: concept_tag (chalkboard)

**Variables:** `{concept_word}` (from content analysis — single key concept word that defines what this niche succeeds on, e.g. "STORYTELLING", "CONSISTENCY", "TIMING")

**Recipe type:** Hybrid — chalkboard shows the word, narrator says a 1-sentence framing.

**Tone examples:**
- *"The number one thing you must focus on in this niche is storytelling."*
- *"Here's the thing — to make videos like this, you need..."*

**Prompt recipe:**
```
Frame the chalkboard concept_word in one sentence.

Variable: {concept_word} (already extracted from content analysis)

Tone calibration:
  - "The number one thing you must focus on in this niche is {concept_word}."
  - "Here's the thing — what makes these channels work is {concept_word}."
  - "What separates the top channels here is {concept_word}."

Pick variation per beat across niches in the same listicle (don't reuse opener).

Output: 1 sentence, 10-14 words, ending in {concept_word} or with it pre-stated.
```

---

### Beat 12: appreciation_optional (~30% probability)

**Variables:** none

**Recipe type:** Bank-based — only inserted in some niches, NOT every niche (it would lose meaning).

**Bank:**
- *"And if you're watching this far, I really appreciate it."*
- *"By the way, if you're still here, thank you."* (variation)
- *"Real quick — if you've made it this far, that means a lot."* (variation)

**Output spec:** 1 sentence, 8-15 words. Used at most TWICE per video (once mid-body around 50-60% point, once optionally before CTA).

---

### Beat 13: transition (between niches)

**Variables:** `{next_niche_number}` (used in beat 1 of next niche, NOT here)

**Recipe type:** Often silent or a single connecting word. The whoosh SFX + glitch transition does the work.

**Tone examples:** mostly silence; occasional MG patterns:
- *"Moving on,"*
- *"Next up,"*
- *"And finally..."* (last niche)

**Output spec:** either empty (silent transition) OR ≤3 words. Default: silent. ~20% of transitions get a vocal cue.

---

### Video-level INTRO (0-15s)

**Variables:** `{niche_count}` (e.g. 11), `{hook_framing}` (e.g. "hidden", "underrated", "blowing up")

**Recipe type:** Gemini-generate, anchored to Money Groot's cold-open style.

**Tone examples:**
- *(Money Groot opens DIRECTLY with "Number one:"  — no intro hook!)*

But other corpus winners use empathy/authority hooks:
- *"I have researched hundreds of faceless YouTube channels..."*
- *"So you want to make money on YouTube without showing your face..."*

**Prompt recipe:**
```
This is the video opener (0-15s). Money Groot's signature style is the COLD OPEN
— go straight to "Number one:" with no preamble. This is the default.

OPTIONAL preamble variant (~30% of generations): use a 1-sentence research-claim
opener BEFORE Number one:
  - "I went through {high_number} faceless YouTube channels..."
  - "These {niche_count} faceless niches are quietly making creators..."

Default behavior: SKIP the preamble. Go straight to beat 1 of niche #1.

Output: empty (default) OR 1 sentence (preamble variant). Decision controlled by
{open_with_preamble} flag from the script orchestrator.
```

---

### Video-level CTA (last 30s)

**Variables:** `{cta_target_video_title}` (the next video to pitch), `{cta_topic_phrase}` (e.g. "20 more niches", "the AI tools they use")

**Recipe type:** Gemini-generate, anchored to MG's CTA pattern.

**Tone examples (verbatim MG CTA):**
- *"So, these are the 11 faceless niches."* (closer)
- *"And each one has huge potential if you're serious about starting a channel."* (light)
- *"And if you want to discover 20 more faceless niches,"* (next-video tease)
- *"just click on this video right here."* (CTA action)

**Prompt recipe:**
```
Write the closing CTA sequence (~20s of narration).

Required structure (4 cards):
  Card 1 (closer): "So, these are the {N} faceless niches." or equivalent.
  Card 2 (light value claim): "And each one has huge potential" / "Any one of
                                these could become a real channel" / similar.
  Card 3 (next-video tease): "And if you want to {cta_topic_phrase},"
  Card 4 (CTA action): "just click on this video right here." / "check out this
                       one." / "you'll want to see this one."

Variation rules:
  - NEVER write the loser phrase "I hope to see each other in another one of
    our videos" (loser-coded, 0× winners use it).
  - NEVER end with "click the link in the description" alone (sponsor-read tone).
  - The phrase "check out [this/next] video" must appear in card 4 (single
    strongest winner-coded CTA, 17× uplift in corpus).

Excluded MG fluff (intentionally cut — pre-CTA personal anecdote / "I'll keep
bringing valuable content"):
  - "A while back I thought about starting a channel in this niche..."
  - "Because I'll keep bringing you more valuable content..."

Output: array of 4 cards, each 4-12 words.
```

---

## Global voice constraints (apply to all beats)

These are tone-locked across the entire generated script.

### Voice / register
- **Calm, educational, matter-of-fact** — NOT high-energy vlogger, NOT corporate
- **Mid-pitch male narrator** (single voice throughout — see audio-sfx-class-b spec)
- **Documentary tone** — like an explainer/teacher, not a salesperson

### Vocabulary preferences
- Concrete numbers always (`"400,000 subscribers"` NOT `"a lot of subscribers"`)
- Active voice, present tense (`"This channel uploads..."` NOT `"This channel has been uploading..."`)
- Direct address sparingly (don't pepper "you guys" everywhere — MG addresses viewer ~3-4× per video)
- Light enthusiasm with restraint (`"absolutely unbelievable"` 1-2× max per video; not every claim is "incredible")

### Vocabulary taboos (cut from output)
- "Today, I'm going to share..." (loser hook, 0× winners)
- "What if I told you..." (overused trope)
- "Imagine if you could..." (abstract hypothetical)
- "Let's talk about..." (filler — cut to the noun)
- "Every single day" (vague universalism — replace with a specific number)
- "Click the link in the description" alone (loser CTA)
- "I hope to see each other in another video" (verbose loser sign-off)
- RPM math exposed in speech ("at $3 RPM × 18 million views = $54,000") — present the OUTCOME only, never the formula

### Pacing constraints
- Median segment length: 1.5-2.5 seconds (matches Money Groot's 1.6s median)
- Each beat's narrator text should be readable in the allotted hold_seconds × 1.05 (slight padding for natural TTS pacing)
- No card holds longer than 2.5 seconds unless explicitly specified (e.g. money_shot card)

---

## Variation rules (across whole script)

These prevent the script from sounding repetitive across niches in the SAME video and across videos in the SAME generation history.

### Within-video (across niches in this listicle)

```
Track and avoid duplicates of:
  1. channel_intro openers: never use "This channel..." for both channels of
     the same niche; never the same opener twice in any 3-niche stretch
  2. money_math connectors: rotate "Even if we assume" / "If we assume" /
     "Let's say we assume" across niches
  3. recipe_demo openers: rotate "This channel simply..." / "When you look at
     their videos..." / "What's interesting is..." across niches
  4. transition phrases: when used, rotate "And finally" / "Moving on" / "Next up"
  5. modifiers ("already", "more than", "literally"): can be reused but never
     three times in the same paragraph
```

### Across generations (anti-repetition history)

```
Maintain a rolling window of the last 50 narrator phrases from prior
generations. When generating a new script:

  - For each beat, fetch the relevant phrase history slice
  - Pass to Gemini as variation_history_for_beat_{beat_id}
  - Gemini avoids exact reuse + paraphrases instead

The rolling window is keyed per beat_id (channel_intro phrases are tracked
separately from money_math connectors).

Purge entries older than 7 days OR keep only the most recent 50 per beat_id
(whichever is smaller).
```

---

## The compiled meta-prompt (what Gemini receives)

At generation time, the script orchestrator builds the actual Gemini prompt by:

1. **Loading the skeleton** (this doc, baked as the system prompt)
2. **Loading filled slot data** for each niche + channel
3. **Loading variation history** (rolling window of past phrases)
4. **Substituting variables** into recipe templates
5. **Calling Gemini once** with structured-output format requesting the timestamped script JSON

The meta-prompt shape (truncated):

```
SYSTEM PROMPT:
  You are generating a YouTube faceless-niche-listicle voiceover script.
  Voice: Money Groot — calm, educational, matter-of-fact male documentary
  narrator. Mid-pitch. Single voice throughout.

  Global rules:
    [insert: global voice constraints from this doc]
    [insert: vocabulary taboos]
    [insert: pacing constraints]

  Variation rules:
    [insert: within-video rules]
    [insert: anti-repetition variation history]

  Beat-by-beat recipes:
    [insert: each per-beat recipe spec from sections above]

  Output as JSON matching this schema:
    {
      "intro": { "text": "...", "duration_s": ... } | null,
      "niches": [
        {
          "niche_index": 1,
          "beats": [
            { "beat_id": "intro_card", "text": "Number one:", "hold_s": 0.8, ... },
            { "beat_id": "niche_name_card", "text": "Funny Stickman Fails.", "hold_s": 1.5, ... },
            { "beat_id": "channel_proof_1", "text": "...", "hold_s": 1.8, ... },
            ...
          ]
        },
        ...
      ],
      "cta": { "cards": [...] }
    }

USER PROMPT:
  Filled slot data:
    [insert: filled_slot_data JSON — per-niche channel data + money math + content
     analysis labels + concept tags]

  Variation history:
    [insert: rolling-window of recent phrases per beat_id]

  Listicle parameters:
    niche_count: {N}
    open_with_preamble: {bool}
    cta_target_video_title: "{title}"
    cta_topic_phrase: "{phrase}"

  Generate the complete script per the system prompt schema.
```

One Gemini call. Full script. TTS-ready text.

---

## What this is NOT

- **Not a literal template** — no boilerplate text gets reused verbatim across generations
- **Not a per-card Gemini call** — single call per video produces the whole script (cost + speed)
- **Not creative writing** — Gemini's job is to fill recipes, not invent structure. The skeleton is rigid.
- **Not a Class A grammar** — talking-head hooks, Social Blade narration, branded SaaS-CTA closes are excluded. Class A gets its own skeleton.

---

## Next checkpoints (queued)

1. `asset-acquisition-spec.md` — for each visual primitive, the Playwright/yt-dlp/AI-image-gen recipe
2. `pipeline-architecture.md` — the worker topology orchestrating discovery → analysis → script → assets → voice → mix → render → publish
3. `icon-library-asset-spec.md` — AI-image-gen prompts for the 15 line-drawing icons
4. `script-skeleton-class-a.md` — when we build the brand-studio template
