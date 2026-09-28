# The engine patches: notes

These patches change the C++ engine (https://github.com/ServeurpersoCom/yue2.cpp) at commit `f17d526` of 2026-09-24.
Each note below says what its patch does, why, and which files it touches, so the change can be
redone by hand where a patch no longer applies. Changes inside upstream files carry a
`// Local addition`, `// Local patch` or `// Local change` comment.

## Use them safely

- **They were made for upstream `f17d526` (2026-09-24).** Upstream may have moved on since: the
  newer it is, the likelier a patch needs redoing by hand.
- **Never apply them to a working install in place.** Build in a separate folder: clone upstream at
  `f17d526` (or a newer commit) into it and apply the patches there. An existing install stays as it is.
- **Try first, in a scratch copy:** `git am -3 patches/*.patch`. If one fails: `git am --abort`,
  and redo that change from its note (and the Local comments in the files) on the newer code.
- **The built page is not in the patches.** `page/index.html.gz` is it; copy it to `tools/public/index.html.gz`
  and commit it, or make it with `./build-page.sh`. Then build and run the tests.
- **Check:** on the base commit, all patches plus the page give the tree in `BASE.txt`.

## 0001 Add stackable voice and genre sliders and an optional full-precision weight load

2026-09-24. Sliders are routed-particle adapters on the four attention projections of
every autoregressive layer, all in float32, summed when several are active,
in both the prefill graph and the static decode graph. The graph size grows
to fit sixteen of them. Weights stored as bfloat16 or float16 can now be
widened to float32 as they load, fused projections included. Two parity
harnesses cover the adapters alone and the backbone with sliders attached.

Files:
- `src/gguf-weights.h` (+41 −2)
- `src/qwen3-lm.h` (+43 −7)
- `src/sliders.h` (+213 −0)
- `tests/CMakeLists.txt` (+6 −0)
- `tests/test-slider-unit.cpp` (+68 −0)
- `tests/test-slider.cpp` (+91 −0)

## 0002 Pick the decoder per request, keep songs in a library, change engine settings live

2026-09-24. Requests may name a decoder, a set of sliders with strengths, ask for the
score alone, and carry a title and the take they re-render. Sliders act
only while the music tokens are written; the acoustic stage re-reads the
song without them. The server takes several named decoders and backbones,
a slider catalog, a song library folder and a settings file. Every track is
saved with its replay request, and the library can be listed, streamed,
renamed, starred and deleted, with cached waveform peaks. Engine settings
(backbone, precision, keeping modules loaded, context rows, decoder tiles)
apply between jobs and persist; unload and hardware endpoints report and
free memory. Job status reports queued jobs, resolved seeds, the score of a
plan and the reason of a failure. The listening address prints as a link.

Files:
- `src/model-store.cpp` (+28 −0)
- `src/model-store.h` (+6 −0)
- `src/pipeline.h` (+86 −7)
- `src/request.cpp` (+52 −0)
- `src/request.h` (+15 −0)
- `tools/yue-server.cpp` (+869 −5)

## 0003 Replace the embedded page with the full console

2026-09-24. The console keeps the layout, themes and info tips of the owner's other
front end and adds this engine's options: separate music and sound seeds,
decoder per song and re-rendering with another decoder, stacked sliders,
batches and sound variations, output format, length cap, engine settings
with a precision choice, the on-disk library with favourites, prompt files,
recording transcription and a live server log.

Files:
- `tools/console/app.css` (+1483 −0)
- `tools/console/app.js` (+3750 −0)
- `tools/console/index.html` (+636 −0)

## 0004 Keep a playing song going when a run finishes, name downloads after the take

2026-09-24. A finished song no longer replaces the one that is playing; it waits first
in the library with a note. Every library card has a download button, the
song page an Audio link, and the player's download, the song page and the
server all name the file after the take (date, time and title). A
background refresh no longer overwrites engine fields while they are being
edited.

Files:
- `tools/console/app.css` (+5 −2)
- `tools/console/app.js` (+31 −8)
- `tools/console/index.html` (+1 −0)
- `tools/yue-server.cpp` (+4 −2)

## 0005 Let songs be browsed without stopping the one that plays

2026-09-25. The player keeps its own song. Opening another song shows its page and
offers a Play this song button; the player only follows the page while it
is idle, a version chip switches it on purpose, and a new version of the
playing song waits as a chip instead of taking over. Space controls
whatever the player holds; deleting the song in the player empties it.

Files:
- `tools/console/app.js` (+84 −33)

## 0006 Add MP3 and FLAC downloads and a model picker in the top bar

2026-09-25. The song page offers a WAV take as MP3 at a chosen bitrate (320/256/192/128,
remembered per browser) and as lossless FLAC. Library cards get an mp3 chip
and the player an MP3 button for what it holds. Takes made as MP3, and songs
kept only in the tab, offer no conversions.

/library/mp3 encodes once per bitrate and keeps the file beside the take,
remaking it if the audio is newer, with an ID3 title and lyrics.
/library/flac encodes on request with a new built-in lossless encoder
(src/flac-enc.h: fixed predictors, partitioned Rice residuals, stereo
decorrelation, MD5 in STREAMINFO, Vorbis comment tags); about a second for a
four-minute song, three quarters of the WAV's size.

A Model select in the top bar lists every backbone the server was started
with, with its size; the change loads with the next song.

Files:
- `src/flac-enc.h` (+686 −0)
- `tools/console/app.css` (+24 −0)
- `tools/console/app.js` (+72 −0)
- `tools/console/index.html` (+13 −0)
- `tools/yue-server.cpp` (+129 −0)

## 0007 Add instrumental songs, following the official YuE2 recipe

2026-09-25. An Instrumental switch under the planning modes renders a song with no
singing. With no score in the form, Generate first plans one (from the
lyrics, or a bare Intro/Verse/Chorus/Outro), then every vocal note moves
to the instrument voice with its pitch and timing, instrument notes under
it giving way. The render gets section tags as its only lyrics, the style
gains "Instrumental ... no vocals, no singing, no choir, no spoken words",
and the mode follows the score: full with chords, melody without. A score
already in the form (planned, pasted or transcribed) is converted instead;
the style and lyrics fields are never overwritten.

tools/console/instrumental.js is the same file the other console ships: a
port of the recipe's score parser, event compiler and voice transfer, with
the same strictness and self-checks. The score drawer gains a Make
instrumental button.

Files:
- `tools/console/app.css` (+4 −0)
- `tools/console/app.js` (+81 −5)
- `tools/console/index.html` (+16 −0)
- `tools/console/instrumental.js` (+498 −0)

## 0008 Explain every setting with an (i) beside it

2026-09-25. tools/console/help.js is the same file the other console ships: the help
for every form and engine control, what it does, its default, and when to
change it (the sampler knobs per stage, guidance, ODE steps, max length,
sound variations, peak clip, VAE tiles and the rest). It places an (i)
beside each label, and missing() lists any control left without help for
the page tests. An (i) inside a label or a drawer heading no longer ticks
or folds anything when pressed. The MP3 bitrate picker sizes to its content.

Files:
- `tools/console/app.css` (+2 −0)
- `tools/console/app.js` (+1 −0)
- `tools/console/help.js` (+239 −0)
- `tools/console/index.html` (+1 −0)

## 0009 Add a LoRA loader that merges while the model loads

2026-09-25. src/lora.h reads the published YuE2 LoRA layouts straight from
.safetensors (the same rules as the other console's loader: unfused and
fused keys, lora_A/B or lora_down/up, per-module alpha, metadata or
adapter_config.json scale, .diff/.diff_b deltas, small full replacements;
a file with a tensor that does not land on the model is refused with the
reason). --loras <dir> lists every file under it in /props loras.

A request names LoRAs with a music and a sound strength (0..2). The
pipeline checks every target against the model's shapes before anything
loads, and the loader adds the scaled B @ A to each touched weight as it
reads it, a block of rows per thread (AVX2 build with a fallback), then
stores it in the weight's own type. In a quantized model the touched
weights are kept at Q8_0: re-quantizing to Q5_K lost the change wherever
a LoRA moves a weight less than Q5 rounding. Each half's store key carries
its own LoRA signature, so a new set reloads only the half it touches, and
with models kept loaded the old copy is swapped out instead of kept.
A failed merge discards the load and the job says why.

tests/test-lora dumps catalogs and merged weights for the parity script.
The console gains the shared LoRA picker (tools/console/loras.js). Takes
record their LoRAs; strengths are written rounded to 3 decimals.

Files:
- `CMakeLists.txt` (+1 −0)
- `src/gguf-weights.h` (+232 −15)
- `src/lora.h` (+801 −0)
- `src/model-store.cpp` (+43 −3)
- `src/model-store.h` (+5 −0)
- `src/pipeline.h` (+82 −2)
- `src/request.cpp` (+27 −0)
- `src/request.h` (+9 −0)
- `tests/CMakeLists.txt` (+3 −0)
- `tests/test-lora.cpp` (+188 −0)
- `tools/console/app.css` (+22 −0)
- `tools/console/app.js` (+23 −0)
- `tools/console/index.html` (+20 −0)
- `tools/console/loras.js` (+179 −0)
- `tools/yue-server.cpp` (+85 −2)

## 0010 Add a copy icon to the song page's Prompt card

2026-09-25. It copies the prompt exactly as the card shows it and says so in a toast.

Files:
- `tools/console/app.css` (+4 −0)
- `tools/console/app.js` (+9 −0)
- `tools/console/index.html` (+4 −1)

## 0011 List LoRAs in the Engine panel; grow the style box and count the prompt

2026-09-25. The Engine panel lists every LoRA in loras/ under the VAEs: what it steers,
rank, size and trigger, the ones on in the form marked in use, a file that
cannot load in red with the reason.

The style box grows with its text (also when the page fills it), and a
counter under it shows characters and estimated tokens, with style and
lyrics counted against the room they share in the context (about 11,400
tokens beside a full score and a six-minute song): amber near it, red past
it. The style help states the limit.

Files:
- `tools/console/app.css` (+10 −0)
- `tools/console/app.js` (+1 −0)
- `tools/console/help.js` (+67 −6)
- `tools/console/index.html` (+4 −0)
- `tools/console/loras.js` (+30 −3)

## 0012 Mark the playing take PLAYING in the Takes list

2026-09-25. The card of the song the player is playing shows a PLAYING tag beside its
mode; it follows the player (play, pause, end, switching songs) and survives
the list being redrawn.

Files:
- `tools/console/app.css` (+3 −0)
- `tools/console/app.js` (+15 −4)

## 0013 Split Reuse this take into Retake and Reuse

2026-09-25. Retake loads the exact request, score, both seeds and music codes
included, so Generate renders the same music again. Reuse loads the
prompt, lyrics and every setting without the score, seeds or codes, so
Generate writes a new song from them.

Files:
- `tools/console/app.js` (+16 −2)
- `tools/console/index.html` (+2 −1)

## 0014 Add a New song button; the seed dice now toggles

2026-09-25. ＋ New song at the top of the Compose column (and Clear in the top bar)
puts every field, the seeds, the score, the mode, sampling, sliders,
LoRAs, Instrumental and the version count back to their defaults; the
VAE, output and theme choices stay.

A seed dice on an empty box puts in a random seed to keep or edit, and
pressed again it clears the box (random each run); its tip says which.

Clear also redraws the sliders it drops (they stayed on screen before).

Files:
- `tools/console/app.css` (+3 −0)
- `tools/console/app.js` (+40 −8)
- `tools/console/help.js` (+4 −2)
- `tools/console/index.html` (+4 −2)

## 0015 Add 41 themes and a swatch picker

2026-09-25. The top bar's theme menu becomes a swatch grid of 50 themes: the nine
hand-tuned ones plus 41 generated from compact palettes (23 Bold, 12 Soft,
6 more Classic). Every text colour of every theme clears 4.5:1 on every
surface it can sit on. Filters for All, Favorites, Bold, Soft and Classic,
a search, hover (or keyboard focus) to preview on the whole page, click to
keep, Esc to go back, a star to keep favourites, arrow keys through the
grid. themes.css and themes.js are shared by both consoles; the palettes
and the generator live outside the repository.

Files:
- `tools/console/app.js` (+6 −12)
- `tools/console/index.html` (+3 −1)
- `tools/console/themes.css` (+1478 −0)
- `tools/console/themes.js` (+300 −0)

## 0016 Show the Engine panel's LoRAs as tiles in their own card; keep the waveform

2026-09-25. The list squeezed long names and details into narrow key/value rows and
stretched the whole row of cards. LoRAs now get a full-width card under the
VAEs with one compact tile each: name, an in use tag, then what it steers,
folder, rank, size, trigger and mode; a file that cannot load has a red edge
and the reason.

The player's waveform was drawn only while a take was open on the page, so
opening a running song blanked it although the song kept playing. It now
follows the song in the player.

Files:
- `tools/console/app.css` (+14 −2)
- `tools/console/app.js` (+2 −1)
- `tools/console/index.html` (+6 −3)
- `tools/console/loras.js` (+14 −11)

## 0017 console: F32 toggle beside the model menu, on/off switches on engine LoRA tiles

2026-09-25. The F32 button flips precision between f32 and bf16 without opening the
Engine tab and stays in step with the Engine form. Each LoRA tile in the
Engine tab gets an On/Off switch that adds it to the song form at strength
1.0 on each half it has, or takes it out; broken files get no switch.

Files:
- `tools/console/app.css` (+7 −1)
- `tools/console/app.js` (+15 −0)
- `tools/console/index.html` (+1 −0)
- `tools/console/loras.js` (+23 −11)

## 0018 console: engine VAE tiles with switches, source links and recaps on every tile

2026-09-26. The Engine tab's VAE list becomes tiles like the LoRAs: an On/Off switch
picks the song's VAE (one per song, the form follows), and each tile is
marked official or third-party. Every VAE and LoRA tile now shows where it
came from as a link, with an (i) that recaps what it does and how it was
made. Links, recaps and a fallback trigger word come from an optional
sources.json in the LoRA folder, which /props passes through.

Files:
- `tools/console/app.css` (+13 −0)
- `tools/console/app.js` (+11 −5)
- `tools/console/index.html` (+5 −4)
- `tools/console/loras.js` (+49 −12)
- `tools/console/vaes.js` (+83 −0)
- `tools/yue-server.cpp` (+10 −0)

## 0019 console: stock and add-on marks, a clean LoRA picker, read-only engine tiles

2026-09-26. The form's LoRA buttons become one even grid: each shows a short name, the
half it steers and a few words on what it does (from sources.json, else the
file's own name and style note). Stock and add-on are marked the same way
everywhere: the Sliders and LoRAs headings and the Blend VAE carry an ADD-ON
badge in the form; the Engine VAE tiles say STOCK or ADD-ON, and the Engine
gets a Sliders card (an add-on: its source link, an (i) recap, one tile per
slider). Engine tiles lose their On/Off buttons and only mark what the song
form has picked; the form is where things are chosen.

Files:
- `tools/console/app.css` (+25 −9)
- `tools/console/app.js` (+36 −19)
- `tools/console/index.html` (+16 −11)
- `tools/console/loras.js` (+33 −25)
- `tools/console/vaes.js` (+37 −27)

## 0020 console: the Engine is its own page

2026-09-26. Opening the Engine now sets the song workspace aside instead of dropping the
panel above it, so it is never mistaken for Compose: a band names it (a gear,
Engine, what it holds) and stays pinned under the top bar with a Back to
compose button, the backdrop is dotted, the cards sit tighter, and the top
bar's Engine button stays lit while it is open. It is all keyed off the panel
itself, so the button, Back and Escape look the same. The empty player bar
now dims only its contents, so pages scrolling under it no longer show
through.

Files:
- `tools/console/app.css` (+27 −6)
- `tools/console/app.js` (+1 −0)
- `tools/console/index.html` (+5 −0)

## 0021 Mark the request parser's additions and the local test targets

2026-09-26. Every change to an upstream file now carries a Local addition comment, so
an upstream update shows at a glance which lines are ours.

Files:
- `src/request.cpp` (+4 −1)
- `tests/CMakeLists.txt` (+2 −2)

## 0022 console: only web links in the source list become links

2026-09-26. A link from the LoRA, VAE or slider source list is shown as a link only
when it starts with http:// or https://; anything else stays plain text.

Files:
- `tools/console/app.js` (+4 −3)
- `tools/console/loras.js` (+7 −4)
- `tools/console/vaes.js` (+7 −3)

## 0023 Colour the playing song's card in the library

2026-09-26. Tinted card, a thicker accent bar, an accent title and a solid PLAYING badge, all from the theme's own accent colour, so the playing song stands out from the selected one.

Files:
- `tools/console/app.css` (+8 −3)

## 0024 Step the temperature knobs by 0.01

2026-09-26. The presets and the useful range sit on hundredths (0.55, 0.85, 0.9-0.95); the arrows moved by 0.1.

Files:
- `tools/console/app.js` (+3 −2)

## 0025 Step top-p, penalty, guidance and LoRA strength finely enough for documented values

2026-09-26. Top-p by 0.005 (a model card uses 0.975), the music repetition penalty by 0.01 (1.18, 1.24), guidance by 0.01 (the protocol's 1.01, presets 0.85-1.15), LoRA strengths by 0.025 (a card's 0.375), and strength readouts keep a third decimal when the value has one.

Files:
- `tools/console/app.js` (+9 −8)
- `tools/console/index.html` (+1 −1)
- `tools/console/loras.js` (+13 −5)

## 0026 Remove the F32 weight option

2026-09-26. It widened BF16 weights to F32 at load for a quality gain that was never measured, while doubling the backbone's memory and measuring about 60% slower on the same song. The button, the Engine setting, its tip and the server setting are gone; an older page or settings.json that still sends precision is ignored. Songs made with it keep saying so on their page.

Files:
- `src/gguf-weights.h` (+4 −53)
- `tests/test-slider.cpp` (+0 −2)
- `tools/console/app.css` (+0 −2)
- `tools/console/app.js` (+10 −36)
- `tools/console/index.html` (+0 −15)
- `tools/yue-server.cpp` (+6 −25)

## 0027 Pad the sound stage's attention keys to a multiple of 256 on the GPU backend that needs it

2026-09-26. That backend's flash attention takes its grouped-query path only when the key count is a multiple of 256; otherwise every query head reads K and V again. Masked zero rows after the latent block make the count fit, with the same bytes out (measured on his laptop's 8 GB GPU: attention per layer 55 -> 29 ms). Other backends are unchanged: a CPU render is byte-identical to before.

Files:
- `src/nar.h` (+37 −8)

## 0028 Add --fp16-matmul for GPUs without BF16 tensor cores

2026-09-26. On older GPUs with FP16 but no BF16 tensor cores (compute 7.x), a batched BF16 matmul runs on the FP32 cores. With the flag, matmuls of more than 8 rows cast the BF16 weight to F16 and run on the FP16 tensor cores; single-token decode keeps reading BF16. Measured on his 8 GB laptop GPU: sound stage 9.25 -> 3.4 s per step, a song 440 -> 215 s, closer to the full-precision render than Q8_0. It changes the output, so earlier seeds do not reproduce exactly. Off by default.

Files:
- `src/pipeline.h` (+5 −0)
- `src/qwen3-enc.h` (+10 −0)
- `tools/yue-plan.cpp` (+4 −1)
- `tools/yue-server.cpp` (+3 −0)
- `tools/yue-synth.cpp` (+3 −0)

## 0029 Correct the key padding's note: near-identical, not identical, on newer cards

2026-09-26. Measured on his desktop GPU with a 242 s song: each sound-stage step 690 -> 443 ms, and the output is no longer the same bytes, since the faster path adds up in another order; its spectrum stays 0.99998 alike. On his laptop's older GPU it was the same bytes.

Files:
- `src/nar.h` (+5 −3)

## 0030 Colour the terminal copy of the server log

2026-09-26. Whole lines by meaning (errors red, warnings and cancels yellow, a finished song or save green, loading chatter and counters dim), otherwise the tag by stage with stage summaries in bold. Only when stderr is a terminal and NO_COLOR is unset; the page's log stream stays plain.

Files:
- `tools/yue-server.cpp` (+91 −1)

## 0031 Put Play this song beside the song's title; a double-click in the list plays

2026-09-26. The button moves from the end of the action row to right after the title. A double-click on a song in the list opens and plays it; it is read from the second click, because the first click redraws the list and the browser then sends no dblclick. Renaming stays on the Rename button.

Files:
- `tools/console/app.js` (+12 −13)
- `tools/console/index.html` (+1 −0)

## 0032 Show where a song's Composition, Performance and Style influence sliders sat

2026-09-27. The song info names each slider's position (lowest to highest), or says custom with the values, from the saved request; Style influence replaces the plain Guidance row and still shows the guidance value.

Files:
- `tools/console/app.js` (+29 −3)

## 0033 Clean up the song details: grouped buttons and one aligned card

2026-09-27. Favourite, Rename and Delete become icons on the title line; the line under the title says age, length and render time instead of repeating the music seed; the buttons sit in Download, Make again and Files groups with MP3 and its bitrate as one split button. The pills become one card in five sections (song, sound, shape, add-ons, seeds) with fixed label and value columns: the shape sliders on a five-step scale, one line per slider or LoRA with its halves together, seeds with copy buttons. The card folds its columns in a narrow window.

Files:
- `tools/console/app.css` (+44 −20)
- `tools/console/app.js` (+89 −43)
- `tools/console/index.html` (+19 −15)
- `tools/console/loras.js` (+18 −1)

## 0034 Make the song details compact: Song, Sound and Shape side by side

2026-09-27. One card of three rows: Song | Sound | Shape, then Sliders | LoRAs with each strength beside its name, then the two seeds stacked with copy buttons. Length and render time stay on the line under the title only, and Style influence shows its position without the guidance text (a hover gives it). In a narrow window Shape drops under Song and Sound.

Files:
- `tools/console/app.css` (+34 −24)
- `tools/console/app.js` (+37 −35)

## 0035 Link the logo: YuE2 opens the model's repo, the CPP badge the engine's

2026-09-27. Both open in a new tab and look as before until hovered.

Files:
- `tools/console/app.css` (+4 −0)
- `tools/console/index.html` (+2 −2)

## 0036 Add an About card, VAE tooltips and a status pill; trim the player bar

2026-09-27. About closes the Engine page: the credit, then YuE2 (project page, code, weights, decoder, covers, report, paper), the C++ engine and ggml (and its fork), then every add-on from sources.json. Standard, Legacy and Blend explain themselves on hover (Standard: the quality choice and the newer model; Blend: two thirds Standard, one third Legacy) instead of Blend spelling the mix out. The player bar drops its WAV and MP3 buttons and the style line (the style is on hover of the name) and gains a fixed-size status: Rendering, Queued, Playing, Paused or Idle; a click shows the run or opens the song.

Files:
- `tools/console/app.css` (+39 −2)
- `tools/console/app.js` (+66 −10)
- `tools/console/index.html` (+36 −4)

## 0037 Add resize grips between the page's columns

2026-09-27. Drag the line left or right of the middle column to size the compose column or the takes list; the middle keeps at least 420px. Double-click or Home resets a column, arrow keys move a focused grip, and the widths are kept per browser. Hidden when the columns stack on narrow windows.

Files:
- `tools/console/app.css` (+21 −4)
- `tools/console/app.js` (+82 −0)
- `tools/console/index.html` (+7 −1)

## 0038 Show the chat server's state as a fixed-size button

2026-09-27. The idea writer's line of status text becomes a square button: Chat Server Connected in green when the server answers, Chat Server Offline in red when not. Both labels share one cell, so the button never changes size; the old text is its tip, and a click checks again.

Files:
- `tools/console/app.css` (+9 −0)
- `tools/console/app.js` (+10 −5)
- `tools/console/index.html` (+3 −0)

## 0039 Make the idea box a full line that grows; Write the brief beside the chat state

2026-09-27. The idea is a one-line box across the whole drawer that grows with its text, like the style box (Shift+Enter for a new line; Enter still writes). Write the brief moves down beside the Chat Server button, the same height, the two kept together on the right; a run's result line goes under them.

Files:
- `tools/console/app.css` (+8 −1)
- `tools/console/app.js` (+1 −1)
- `tools/console/index.html` (+7 −5)

## 0040 Clean up the idea drawer; the Compose heading stands alone

2026-09-27. The drawer gets labels like the rest of the form (Idea, Structure, Writer model, each (i) on its label), the writer model as a read-only box instead of a disabled menu, and the structure's note inside its (i). The small chat server tag goes: the Chat Server button already says it. Under a thin line, the Chat Server button and Write the brief sit together on the left at the same size, then the checkbox; a run's result line goes under them. The Compose heading loses its tagline.

Files:
- `tools/console/app.css` (+13 −27)
- `tools/console/app.js` (+9 −3)
- `tools/console/help.js` (+0 −1)
- `tools/console/index.html` (+11 −16)
