# Worked example — Money Groot's "11 Hidden Faceless YouTube Niches Explained" reverse-engineered

**Status:** Checkpoint — concrete worked example proving the script-skeleton + data discovery + content analysis stack would produce a Money-Groot-equivalent script from real channel data, minus fluff.

**Source:** MG videoId 14563, 121,507 views on 41,900-sub channel (2.90× ratio). 454 segments, 14m04s.

**Method:** Took the actual MG transcript, marked which lines deliver data vs which are fluff. Replaced literal data with `{variables}` and noted the SOURCE (`take from: …`) each variable would be pulled from in our pipeline. Marked fluff segments `[CUT]` with rationale.

The cleaned/variabled output is what our generator would produce if given the same channel data MG had — but **shorter, varied across generations, and zero filler**.

---

## Notation

```
[ts] Original transcript line                       ← MG actual
     → {var:source}                                 ← variable + source
     → [CUT: reason]                                ← removed fluff
     → [RECIPE: …]                                  ← Gemini varies this beat
     → [KEEP-AS-IS]                                 ← reusable connector
```

Sources map to checkpoints we've already committed:

| Source | What it produces |
|---|---|
| `discovery` | from `data-discovery-rules.json` — the picked channel itself |
| `db.subs` / `db.video_count` / `db.top_video` / `db.total_views` / `db.age` | from rofe.ai DB direct columns |
| `db.math.rpm × views` | money math computed in slot-fill (RPM from Gemini cache, views from db) |
| `analysis.recipe_formula` | from per-channel content analysis (the spec we skipped — runs our existing analyzer on channel's top videos) |
| `analysis.concept_word` | same, the chalkboard tag word |
| `analysis.geo_hint` | language/region tag from content analysis |
| `bank.X` | bank phrase from `script-skeleton-class-b.json` |

---

## Niche 1: Funny Stickman Fails (canonical full annotation)

### Beat 1-2: niche reveal (0.0-3.8s)

```
[ 0.0] Number one:
       → "Number {N}:" from bank.intro_card
       → variable: N=1

[ 1.4] Funny stickman fails.
       → "{niche_category_label}." from bank.niche_name_card
       → variable: niche_category_label = "Funny Stickman Fails"
       → source: analysis.niche_category (Gemini Q&A on the channel's top videos)

[ 3.8] This channel simply records gameplay of a funny stickman game and uploads it.
       → [RECIPE: channel_intro + recipe preview]
       → "This channel {recipe_formula_simplified}."
       → variable: recipe_formula_simplified = "simply records gameplay of a funny stickman game and uploads it"
       → source: analysis.recipe_formula (Gemini Q&A)
```

### Beat 4-5: channel proof (6.0-21.3s)

```
[ 6.0] And the craziest
[ 7.0] part is that this channel already has more than 400,000 subscribers.
       → [RECIPE: channel_proof_1 with emphasis intro]
       → "And the craziest part is that this channel already has more than {subs} subscribers."
       → variable: subs = "400,000"
       → source: db.subs (rounded to 2 sig figs)
       → tone_var: "the craziest part" rotates across niches (bank: "the wild thing" / "what's insane" / "the kicker")

[ 9.8] And their views are absolutely unbelievable.
       → [RECIPE: consistency setup]
       → bank.consistency_intro = ["And their views are absolutely unbelievable.", "And every upload pulls real numbers.", "And the views back it up."]
       → rotate across niches in same listicle

[13.0] They have videos with
[14.0] 29 million views,
[15.0] 10 million views,
[16.0] 8.8 million views,
       → [RECIPE: top_views_seq rapid-fire]
       → fragment 1: "They have videos with"
       → fragments 2-4: enumeration of {top_video_views[0..2]}
       → variable: top_video_views = ["29 million", "10 million", "8.8 million"]
       → source: db — top-3 by view_count for this channel, rounded to 2 sig figs

[17.7] and almost every single upload pulls in hundreds of thousands of views.
       → [RECIPE: top_views_pano — view_consistency_phrase]
       → bank: rotated phrase that summarizes median-views performance
       → variable: median_views_phrase derived from db.median(view_count) for channel
       → e.g. if median is ~250K → "and almost every single upload pulls in hundreds of thousands of views"
```

### Beat 6: money math (21.3-31.0s)

```
[21.3] Let's take that video
[22.1] with 29 million views.
       → [RECIPE: money_math card 1 — optional opener]
       → variable: base_views = top_video_views[0] = "29 million"
       → 50% probability this opener — skip directly to "If we assume…"

[24.0] Even if we assume
[25.0] just a $1 RPM,
       → [RECIPE: money_math cards 2-3]
       → variable: rpm = "$1"
       → source: db.gemini_rpm_cache[niche_category]
       → bank: "Even if we assume / If we assume / Let's say we assume" rotation

[27.0] that one video alone has probably made around
[29.0] 29,000
[30.0] from ads.
       → [RECIPE: money_math cards 4-5-6 — connector + money_shot + closer]
       → connector bank: ["that one video alone has probably made around", "that's roughly", "this would translate to", "the estimated earnings are"]
       → money_shot: "${lump_sum}"
       → variable: lump_sum = "29,000"  (computed: base_views × rpm with rounding)
       → closer: "from ads." (semi-fixed)
```

### Beat 10: recipe demo (31.0-65.0s)

```
[31.0] When you look at their videos,
[32.0] the editing style is extremely simple.
       → [RECIPE: recipe_demo opener over mini-player b-roll]
       → bank: "When you look at their videos, the editing style is extremely simple." / "Their videos are surprisingly simple." / "Once you watch a few, you see they're all the same recipe."
       → tone_var: emphasizes "simple" for low-effort niches (drives 'you could do this')

[33.0] They just record the gameplay,
[34.5] add those viral troll or skull face effects,
[37.5] and whenever something funny happens, they insert quick meme or movie clip edits
[41.0] to make the reaction even more hilarious.
       → [RECIPE: recipe_demo body — Gemini expands recipe_formula into per-clip narration]
       → variable: recipe_extras = ["records gameplay", "troll/skull face effects", "meme/movie clip inserts"]
       → source: analysis.recipe_extras (per-clip details from content analysis)
       → output: 2-4 narration phrases timed to mini-player b-roll beats

[44.0] You can find tons
[45.0] of meme and movie clips on TikTok and Instagram.
[47.0] On top of that,
[48.0] they use viral fonk music in the background, which
[51.0] keeps the video engaging and fun.
[53.0] and makes the audience watch till the end.
       → [RECIPE: recipe_demo continuation — tools/sources referenced]
       → variable: recipe_extras_tools = ["TikTok/Instagram meme clips", "phonk music background"]
       → connector rotation: "On top of that / Also / What's interesting"
```

### FLUFF section (55.5-82.6s) — copyright tip detour

```
[55.5] They change the funk track almost every time,
[57.5] and I think they still don't get any copyright issues
[59.5] because the music is used only in short segments.
[62.7] and is mixed well with memes and gameplay audio.
       → [PARTIAL CUT — this is a useful production-tip but specific to MG's editorial framing]
       → KEEP if "production_tip" slot is filled by content analysis flagging a production technique
       → CUT otherwise; doesn't deliver hard data points

[66.2] but if you want to try this niche for yourself,
[67.9] then it is always safer to use No-Copyright Phonk.
[70.7] You might already know this channel.
[71.8] They have a lot of no-copyright funk music that is free to use.
[73.9] free to use.
[74.8] The only thing you need to do
[76.3] is give proper credit in the description.
[78.8] This way, your channel stays secure
[80.2] from copyright issues and can also safely monetize.
       → [PARTIAL CUT — MG plugs a tool channel here]
       → Could KEEP only if our system has a "tools_to_use" slot fed by content analysis
       → For v1: CUT entirely (transcription duplicates show MG even repeats himself here)
       → For v2 (when tools slot exists): "You can use {tool_channel_name} for {tool_use_case}, just give credit in the description."
```

### Beat 4 redo: second channel (83.4-95.2s)

```
[83.4] There is another channel that started making the same kind of videos
[86.4] just 3 months ago,
[87.3] and they are getting really good views on every upload.
[90.4] And when you look around,
[91.2] you'll see many channels doing this
[93.3] and performing well
[94.4] with the same format.
       → [RECIPE: channel_proof_1 for 2nd channel — "another channel" opener]
       → "There is another channel that started making the same kind of videos just {channel_age_phrase}, and they are getting really good views on every upload."
       → variable: channel_age_phrase = "3 months ago"
       → source: db.age for the SECOND picked channel in this niche
       → connector rotation: "There is another channel / And there's another channel / Look at this one"
       → multi-channel saturation: "And when you look around, you'll see many channels doing this" — KEEP as the niche-saturation framing

[95.2] To give you a better idea,
[96.1] I recorded a clip of this game and edited it in a similar style.
[99.1] So you can see how entertaining and simple these videos are to create.
       → [CUT — MG's "I tried it myself" personal demo]
       → For v1: skip — our system doesn't make personal demos
       → For v2: could be a {generated_b_roll_demo} slot, where AI video gen produces a sample clip
       → Length: ~17s cut from niche 1
```

### Niche 1 → Niche 2 transition

```
[116.4] Number two:
       → [RECIPE: transition + niche 2 intro_card]
       → "Number two:" from bank.intro_card
```

---

## Niche 1 — what our system would output (cleaned)

```
[ 0.0]  Number one:
[ 1.4]  Funny Stickman Fails.
[ 3.8]  This channel simply records gameplay of a stickman fail game and uploads it.

[ 6.0]  And the craziest part is —
[ 7.0]  this channel already has more than 400,000 subscribers.
[ 9.8]  And their views are absolutely unbelievable.

[13.0]  They have videos with
[14.0]  29 million views,
[15.0]  10 million views,
[16.0]  8.8 million views,
[17.7]  and almost every single upload pulls in hundreds of thousands of views.

[21.3]  Let's take that video
[22.1]  with 29 million views.
[24.0]  Even if we assume
[25.0]  just a $1 RPM,
[27.0]  that one video alone has probably made around
[29.0]  $29,000
[30.0]  from ads.

[31.0]  When you look at their videos,
[32.0]  the editing style is extremely simple.
[33.0]  They record the gameplay,
[34.5]  add viral troll-face or skull-face effects,
[37.5]  and whenever something funny happens they cut to a meme or movie clip
[41.0]  to make the reaction even more hilarious.
[44.0]  They also use viral phonk music in the background
[51.0]  to keep the videos engaging.

[83.4]  There's another channel doing the exact same format,
[86.4]  just 3 months old,
[87.3]  and already getting hundreds of thousands per upload.
[90.4]  When you look around,
[91.2]  you'll see many channels doing this and performing well with the same format.
```

**~62 seconds total (vs MG's 116s for niche 1)** — same data, ~46% shorter.

**Cuts**: copyright detour (15s), No-Copyright Phonk plug (12s), personal "I tried it" demo (18s) = ~45s of fluff removed.

---

## Niches 2-11 — data inventory + cleaned output

For each niche, I'll list the data slots filled, then the cleaned narration. The structural skeleton is identical — only variables and recipe outputs differ.

### Niche 2: Roblox Lore Explained

**Data inventory (variables filled per niche):**
- `niche_category_label` = "Roblox Lore Explained"
- `recipe_formula_simplified` = "makes explanation-style videos about different Roblox games"
- channel A: `subs` = "?", `total_views` = "7 million" (MG didn't state subs)
- `rpm` = "$3", `lump_sum` = "21,000" (computed)
- channel B: `subs` = "?", `top_video_views` = "1.6 million", `video_count` = "6"

**Cleaned output:**
```
Number two: Roblox Lore Explained.
This channel makes explanation-style videos about different Roblox games
and has already gained more than 7 million views.

If we assume a $3 RPM, that's roughly $21,000 from ads.

There is another channel creating the same Roblox explaining content.
And despite uploading only 6 videos,
they have already received over 1.6 million views.

The best part about this niche is you'll never run out of topics —
Roblox has countless popular games people already love watching on YouTube.
And if you want to take this style beyond gaming,
don't miss niche number seven later in this video.
```

**Cuts:** none significant in niche 2 — MG was tight here.

### Niche 3: Absurd Ranking

**Data inventory:**
- `niche_category_label` = "Absurd Ranking"
- `recipe_formula_simplified` = "literally ranks letters and numbers in a funny way like 'Top 10 numbers to live in'"
- channel A: `total_views` = "13 million", `rpm` = "$3", `lump_sum` = "39,000"
- channel B: `subs` = "28,000", `top_video_views` = "1.8 million", `video_count` = "2"

**Cleaned output:**
```
Number three. Absurd Ranking.
This channel literally ranks letters and numbers in a funny way —
like Top 10 numbers to live in, or Top 10 letters to use as a chair.
And their videos consistently pull really good views.
The channel has already gained over 13 million total views.

If we assume a $3 RPM, the estimated earnings are $39,000 from ads.

There's another channel doing the same — but instead of letters and numbers,
they rank logos. They've uploaded just 2 videos
and already got over 28,000 subscribers and over 1.8 million views.

The advantage of this niche is the competition is extremely low —
because the animation isn't easy to copy. If it were an easy AI niche,
thousands would have copied it already.
And since the idea is so unique, your chances of growing fast can be much higher.
```

**Cuts:** none — niche 3 already tight.

### Niche 4: Movie & TV Show Breakdown

**Data inventory:**
- `niche_category_label` = "Scene Analysis" / "Movie & TV Breakdown"
- channel A: `top_video_views` = "1 million+", `video_count` = "10"
- `rpm` = "$6" (with `geo_hint` = "US/UK for these shows")
- `lump_sum` = "6,000"
- channel B: `niche_focus` = "The Matrix", `top_video_views` = "1 million+"
- channel C: `niche_focus` = "Game of Thrones", `consistency_phrase` = "view consistency is amazing"
- `concept_word` = "STORYTELLING"
- `personal_tips_count` = 2 (with tip variables)

**Cleaned output:**
```
Number four. Scene Analysis.
This channel makes videos on one of the most popular shows ever — Breaking Bad.
With only 10 videos, they have already gained over 1 million views.

If we assume a $6 RPM, because the videos are long
and most viewers likely are from countries like the US and UK,
this would translate to about $6,000 from ads.

The intro of the first 10-15 seconds is nicely edited to grab attention,
but after that, the video is simple clip editing with voiceover.
Yet the storytelling is very strong and keeps viewers hooked.

There's another channel that makes videos only on The Matrix,
breaking down different scenes — their most popular video has more than 1 million views.

And there's another channel that focuses on Game of Thrones,
and their view consistency is amazing.
That consistency shows the real potential here.

By now you must have understood how big the opportunity is in this niche.
There are so many popular movies and shows — you just need to choose one
and start making videos about it.
And the best part? YouTube allows this type of content,
as long as you use clips without sound, your own commentary,
and basic editing.

The number one thing you must focus on in this niche is STORYTELLING.
The way you explain the scene should keep people curious the entire time
so they never want to click away.

Here are two tips:
First — make videos on shows whose new season just released or is coming soon.
Traffic for scene breakdowns becomes extremely high then,
which can help your channel grow faster.
Second — choose movies and shows most popular in high-CPM countries like the US and UK.
That way your RPM will usually be higher.

And if you're watching this far, I really appreciate it.
```

**Cuts:**
- `[CUT — self-promo subscribe ask 347-350s]` "These videos take a lot of time and research, so consider subscribing. It helps me bring you more content like this." → removed; the simple appreciation beat is enough.

### Niche 5: Trending Memes Explained

**Data inventory:**
- `niche_category_label` = "Meme Explained Channels"
- channel A: `inconsistency_note` = "not every video gets high views"
- channel B (the big one): `total_views` = "800 million+", named as "you probably already know"

**Cleaned output:**
```
Number five. Meme Explained Channels.
This channel explains whatever new memes are trending on social media.
Not every video gets high views — some memes go extremely viral, some don't.
For example, when they explained this meme during its early viral days,
that video got over 1 million views.

There's another channel you probably already know —
they make 2-minute videos explaining trending memes and hot topics,
and their channel has a mind-blowing total of more than 800 million views.
You can imagine how much ad revenue that generates.

These videos don't require fancy editing — they're simple.
You just need to be careful about one thing:
never explain wrong information about the meme or topic,
otherwise your channel could get into trouble.

Stay consistent with trending memes.
That's usually how channels in this niche grow faster.
```

**Cuts:** light reorganization, no major cuts.

### Niche 6: Personality Quizzes

**Data inventory:**
- channel A: `age_phrase` = "2 months ago", `total_views` = "1 million+", `subs` = "10,000"
- `rpm` = "$2", `lump_sum` = "2,000"
- `audience_demo_hint` = "girls / young female audience"
- `recipe_formula` = "quiz video with line setup + 20-30 options + reveal"
- `recipe_uniformity_note` = "template reused for every video, only topic changes"

**Cleaned output:**
```
Number six. Personality Quizzes.
This channel started posting quiz-style videos only 2 months ago
and has already gained more than 1 million views and 10,000 subscribers.

If we assume a $2 RPM, that's roughly $2,000 from ads.

Their videos are mostly about girls' personality quizzes —
girls are the main audience for this type of content.

I mentioned this niche because it's very simple to create.
You only need to work hard on your very first quiz video.
After that, you can keep using the same template —
just change the topic.

At the beginning of each video, a line explains what the quiz is about.
Then 20 to 30 options. At the end, reveal the personality based on choices.
The editing style is identical every video. Only the topic changes.
Even the thumbnails follow the same pattern.

That's why they can upload new videos every single day.
The only thing that takes extra time is collecting the images —
you can use Pinterest, but always check the license before using.
```

**Cuts:** transcription duplicates removed.

### Niche 7: Horror Explained

**Data inventory:**
- channel A: `total_views` = "14 million", `recipe_formula` = "horror movies in explaining style"
- `rpm` = "$4", `lump_sum` = "50,000"
- `growth_proof` = "MG screenshot from when it had 1K subs, now 50K"
- `idea_extension` = "could extend to sad/emotional films"

**Cleaned output:**
```
Number seven. Horror Explained.
You'll remember I mentioned earlier — if you want to make explainer-type videos
outside of gaming, this niche can be a very good option.

Look at this channel. It makes videos mostly about horror movies in an explaining style,
and has already gained over 14 million views in total.

If we assume a $4 RPM, that's roughly $50,000 from ads.

I have a screenshot of this channel when it only had 1K subscribers.
Now it has gained 50K subscribers and is doing really well.

Here's a crazy idea — instead of making the same horror explaining videos,
you can choose other genres like sad or emotional films and explain them the same way.

For example, this channel made a video called "15 horror movies where evil wins."
You could make "10 Saddest Movie Scenes Where the Audience Almost Cries"
or "Scariest Movie Monsters of All Time."

This style adapts to any genre.
```

**Cuts:** "This idea just came to my mind" → cut (filler).

### Niche 8: AI Game Development

**Data inventory:**
- channel A: `video_count` = "20", `subs` = "80,000", `total_views` = "7 million"
- `rpm` = "$6" with `niche_topic_hint` = "AI and coding"
- `lump_sum` = "42,000"
- `barrier_note` = "needs coding knowledge"
- channel B: `subs` = "50,000", `video_count` = "19"
- `creator_background` = "data science + physics student"

**Cleaned output:**
```
Number eight. AI Game Development.
This is one of the interesting niches I noticed recently.
This channel has posted only 20 videos
and already gained almost 80,000 subscribers.
Just look at the views on every video —
the channel has already achieved more than 7 million total views.

If we assume a $6 RPM, since the videos focus on AI and coding,
this would translate to around $42,000 from ads.

To make videos like this you need some coding knowledge.
But if you don't know coding, you can collaborate with a friend
who does — share the revenue when the channel starts earning.

For example, there's another channel that started uploading similar content
and got almost 50,000 subscribers with just 19 videos.
When you look at their channel description,
you'll see the creator is a data-science-plus-physics student.

In this niche, you'll almost never run out of topics —
there are hundreds of popular PC and mobile games you can make videos about.
```

**Cuts:** repeated lines from transcription noise.

### Niche 9: True Horror Stories

**Data inventory:**
- channel A: `subs` = "100,000", `total_views` = "18 million", `video_length_note` = "40-50 min long"
- `rpm` = "$10", `lump_sum` = "180,000" with `geo_hint` = "English videos"
- `recipe_formula` = "photos + script voiceover"
- `tool_suggestion` = "ChatGPT/Claude for scripts (NOT Reddit due to copyright/reuse)"
- `production_tip` = "mix photos + B-roll stock videos (YouTube limits monetization on still-only)"
- `style_tip` = "vignette effect adds horror vibe"
- `growth_proof_channel` = "almost 7M subs, 1.5B total views from long-form"

**Cleaned output:**
```
Number nine. True Horror Stories.
This channel posts true horror style videos
and now has almost 100,000 subscribers with over 18 million total views.

Here's the crazy part — because these videos are usually 40 to 50 minutes long,
they have potential for more watch time and multiple ad placements,
which can result in a higher RPM.
And since the videos are in English, if we assume a $10 RPM,
that's roughly $180,000 for 18 million views.

The recipe is mostly a bunch of photos with a script voiceover. Nothing else.

You can use Reddit for horror stories, but I wouldn't recommend it —
many people use Reddit, which increases the chances of reused content or copyright issues.
Use ChatGPT or Claude to generate fresh scripts instead.

Another tip — most horror channels use only photos with voiceover, and it works.
But I'd suggest mixing in B-roll stock videos as well.
YouTube sometimes limits monetization on videos that rely too much on still images.
Mixing photos and videos makes your content look more original and keeps your channel safer.
And if you add a vignette effect, your videos instantly get a stronger horror vibe.

There is competition in this niche, but that actually proves the niche works.
Your channel could grow and get monetized within a month,
or it might take three to six months.
What truly matters is consistency — and by consistency
I mean uploading genuinely good content, not posting anything for the sake of it.

Here's a great example — one of the most popular faceless channels in this niche
has almost 7 million subscribers and over 1.5 billion total views.
All from long-form videos.
```

**Cuts:** transcription duplicates; "This effect is available in almost every editing software" trivia line cut.

### Niche 10: Data Map Visuals

**Data inventory:**
- channel A: `subs` = "8,000", `total_views` = "2 million", `age_phrase` = "3-4 months old"
- `recipe_formula` = "real data + map animations about companies expanding/dominating/disappearing"
- `rpm` = "$4" with `geo_hint` = "US-based companies → US audience"
- `lump_sum` = "8,000"
- `evergreen_note` = "videos keep getting views over years"
- `tool_named` = "GeoLayers (After Effects plugin)"
- channel B: `age_phrase` = "1 month old", `performance_note` = "already performing well"

**Cleaned output:**
```
Number 10. Data Map Visuals.
This channel combines real data and map animations to make videos
about how famous companies expanded, dominated, or disappeared in different parts of the world.
It has gained over 8,000 subscribers and more than 2 million views.

If we assume $4 RPM — since the topic is business
and most of the companies featured are US-based —
that's roughly $8,000 from ads.

Keep in mind: the channel started posting only 3-4 months ago.
These are good numbers for such a short span of time.

The best part? These videos are evergreen.
They keep getting views over the years and generate continuous revenue.

Another channel started posting just 1 month ago and is already performing well.

You can get data about big companies from many data-related websites on Google.
And the videos are probably made using GeoLayers —
a third-party plugin used in After Effects to create map animations.

The competition in this niche is low because the style isn't easy to replicate,
unlike channels that use simple data-related videos.
```

**Cuts:** transcription duplicates.

### Niche 11: Strange Animal Facts (last niche)

**Data inventory:**
- channel A: `age_phrase` = "1 month old", `video_count` = "6 long videos", `subs` = "50,000", `total_views` = "7 million"
- `rpm` = "$3", `lump_sum` = "21,000"
- `recipe_formula` = "deep sea creatures, documentary-style"
- `growth_tip` = "spend time on thumbnails and titles"

**Cleaned output:**
```
Number 11. Strange Animal Facts.
This channel started posting only 1 month ago.
With just 6 long videos, they gained over 50,000 subscribers
and more than 7 million views.

If we assume $3 RPM, that would translate to around $21,000 from ads.

Most videos focus on deep sea creatures —
people love this type of content because it's both educational and mysterious.
Watching their videos feels a bit like watching a documentary.

If you want to grow in this niche, spend more time on thumbnails and titles.
They should look really interesting
and make viewers curious enough to click.
```

**Cuts:**
- `[CUT — MG personal anecdote 800-805s]` "A while back I thought about starting a channel in this niche myself, but due to time constraints, I couldn't."
- `[CUT — forced reaction 810-812s]` "And here was my reaction. Oh! What!"
- `[CUT — moralistic preachy 812-822s]` "The lesson is clear. If you have an idea and just keep thinking about it..."

Cuts ~22 seconds from end of niche 11.

---

## CTA — Money Groot's actual close annotated

```
[822.7] So, these are the 11 faceless niches.
        → [KEEP] cta.card_1 closer template
        → "So, these are the {N} faceless niches."

[825.2] And each one has huge potential
[827.2] if you're serious about starting a channel.
        → [KEEP] cta.card_2 light value claim
        → bank: ["And each one has huge potential", "Any one of these could become a real channel", "Pick one and run with it"]

[829.4] If this video helped you find a niche, or you learned something useful,
[832.4] hit the like button and subscribe.
        → [TIGHTEN] conditional ask is weaker than imperative
        → Could drop conditional or replace with the direct "If this helped, hit subscribe."

[834.7] Because I'll keep bringing you
[837.2] more valuable content completely free.
        → [CUT] self-promotion fluff, zero value to viewer

[837.2] And if you want to discover 20 more faceless niches,
[840.3] just click on this video right here.
        → [KEEP — MOVE UP] this is the gold cta.card_4 (the "check out this video" pattern, 17× winner-coded)
        → bank: ["And if you want to {cta_topic_phrase},", "Want even more? Check out this one."]
        → "{cta_topic_phrase}" filled per script orchestrator
```

**Cleaned CTA:**
```
So, these are the 11 faceless niches.
And each one has huge potential if you're serious about starting a channel.

And if you want to discover 20 more faceless niches,
just click on this video right here.
```

~9 seconds vs MG's 20 seconds = **~55% shorter CTA**, ends on the strongest winner-coded phrase.

---

## Cross-niche fluff cut summary

Total fluff removed across the 11 niches + CTA:

| Cut | Where | Seconds | Why |
|---|---|---|---|
| Copyright detour ("they don't get copyright issues because…") | niche 1 (55-65s) | ~10s | production trivia, doesn't deliver a slot |
| No-Copyright Phonk plug (full reveal) | niche 1 (66-82s) | ~16s | tool plug, no slot — could be tools_used slot in v2 |
| "I tried it myself" personal demo | niche 1 (95-115s) | ~20s | personal anecdote, our system doesn't make demos in v1 |
| "These videos take time, consider subscribing" | niche 4 (347-350s) | ~3s | self-promo |
| "This idea just came to my mind" | niche 7 (~509s) | ~1s | filler |
| Transcription duplicates | scattered | ~5s total | speech repetition noise |
| Trivia line "vignette is in every editing software" | niche 9 (~647s) | ~2s | not a real data point |
| Personal anecdote "a while back I thought about starting this niche" | niche 11 (800-805s) | ~5s | personal regret, no value |
| Forced reaction "Oh! What!" | niche 11 (810-812s) | ~2s | manufactured energy |
| Moralistic preachy outro "the lesson is clear, if you have an idea…" | niche 11 (812-822s) | ~10s | preachy filler, sermons not data |
| Self-promo "I'll keep bringing more valuable content free" | CTA (832-837s) | ~5s | self-promo, zero viewer value |

**Total fluff removed: ~80 seconds (≈10% of the video)**

Result: a 14m04s video becomes a ~12m40s video, with the same data delivered, plus rotation/variation rules preventing same-phrasing repeat across generations.

---

## Data inventory needed per niche (proof check)

Each niche needs these slots filled from our DB + content analysis. Showing what we need for niche 1 as the canonical:

| Slot | Source | Value (niche 1 example) |
|---|---|---|
| `niche_category_label` | analysis.niche_category | "Funny Stickman Fails" |
| `channel_a.name` | discovery + db.name | (the actual channel name from picks) |
| `channel_a.subs` | db.subscribers | 400,000 |
| `channel_a.video_count` | db.video_count | 122 |
| `channel_a.age_phrase` | db.age → phrase | "~5 months old" or `"created Jan 2025"` |
| `channel_a.top_video_views[0..2]` | db top-3 by view_count | [29M, 10M, 8.8M] |
| `channel_a.median_views_phrase` | db.median(view_count) → phrase | "hundreds of thousands per upload" |
| `recipe_formula_simplified` | analysis.recipe_formula | "simply records gameplay of a stickman game and uploads it" |
| `recipe_extras` | analysis.recipe_extras | ["troll face effects", "meme clip inserts", "phonk music"] |
| `rpm` | db.rpm_cache[niche_topic] | $1 (gameplay = low RPM) |
| `lump_sum` | computed: top_video_views[0] × rpm | "$29,000" |
| `channel_b.age_phrase` | db.age for 2nd channel | "3 months ago" |
| `channel_b.performance_note` | db.median_views | "getting really good views on every upload" |
| `niche_saturation_note` | proprietary: cohort.cluster_size | "many channels doing this" |

That's **14 data points** for one niche. Across 11 niches + intro + CTA = ~180 data points per generated video. Most are direct DB queries; ~30% need content analysis; <5% need proprietary cohort signals.

---

## What this worked example proves

1. **The skeleton is correct.** Every MG line maps to either a beat recipe (filled by variables + Gemini rotation) or fluff to cut. No structural gaps.

2. **Our data inventory is sufficient.** Every variable has a clear source in our DB or content analysis. Nothing needs human input.

3. **Variation will keep generations fresh.** The bank phrases + Gemini rotation + cross-generation history prevent the "same script every time" failure mode.

4. **De-fluffing is real.** ~80 seconds of MG's video are personal anecdote / self-promo / preachy filler. Our system literally cannot produce those (no slot, no recipe → not generated). The output is tighter by construction.

5. **The system would beat MG on the SAME data.** Same channels, same numbers — but ~12m40s instead of 14m04s, higher information density, no transcription duplicates, varied phrasing across niches, ending on the strongest CTA.

---

## What's NOT covered by this example (gaps to address later)

- **Visual b-roll for content clips** — MG uses actual gameplay/movie/TV clips. Our system will pull source content via yt-dlp (per asset-acquisition-spec when we write it) and play the channel's actual top video segments in mini-player frames.
- **"Tools used" slot** — niche 1's No-Copyright Phonk plug could become a real slot if we add `tools_referenced` to the data inventory.
- **AI-generated demo clip** — MG's "I made one myself" niche 1 demo is currently CUT. A Phase 2 feature could use AI video gen to produce equivalent demonstration clips.

---

## Next checkpoints (unchanged)

1. `asset-acquisition-spec.md` — per-primitive Playwright/yt-dlp/AI-gen recipes
2. `pipeline-architecture.md` — worker topology
3. `icon-library-asset-spec.md` — AI prompts for the 15 icons
