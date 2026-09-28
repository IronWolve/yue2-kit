/* Help for every setting: an (i) beside each control's label shows what the
   setting does, its default, and when to change it. The same file ships in
   both consoles; an entry whose control a page lacks is simply unused.

   window.YueHelp:
     decorate()   add the (i) marks (safe to call again, e.g. after the sampler knobs are rebuilt)
     missing()    ids of form and engine controls that have no help, for the page tests
   It also makes the style box grow with its text and counts the prompt against the model's
   context under it (#styleMeter). */
(function (root) {
  "use strict";

  var ODE = "How many steps the sound solver takes to turn the music tokens into audio (flow matching, midpoint method). " +
    "32 is the release setting.\n" +
    "Each step runs the sound model twice over the whole song, so 64 steps make this stage take twice as long as 32; " +
    "the music itself (melody, words, length) is already fixed by then and does not change.\n" +
    "Fewer steps (8–16) are quicker drafts. Whether 64 sounds better than 32 has not been published: " +
    "to hear it, re-render one take's sound at both settings.";

  var HELP = {
    // ------------------------------------------------------------ the form
    title: "Names the take in the library and every file it downloads as (date-time-title). " +
      "It is not sent to the model and does not change the song.",
    seed: "One number that fixes the random draws of the score and the music: the same seed, prompt and settings give the same song. " +
      "Blank means random: every run picks a new one. The dice puts a random seed in the box to keep or edit; press it again to clear the box. " +
      "Every take keeps its seed, so a good one can be reused with a small change to the prompt (Retake).",
    soundSeed: "Fixes only the acoustic noise of the sound stage: the same music (melody, words, timing) played through a different grain. " +
      "Blank means random each run; the dice puts one in, and pressing it again clears it. Change it, or use Re-render sound on a take, " +
      "to get another rendering in seconds.",
    style: "What the song should sound like, as short comma-separated phrases: language, genre, singer (e.g. female alto, raspy male), " +
      "instruments, mood, tempo (e.g. 92 BPM). Both the score planner and the music read it; it goes in as the prompt's tag list.\n" +
      "Size: no fixed limit. Style and lyrics share the model's 24,576-token window with the score (up to 4,096) and the song " +
      "(up to 9,000, six minutes), so together they can take about 11,400 tokens, roughly 40,000 characters of English, " +
      "before a full-length song no longer fits; the counter under the box keeps count. The box grows with the text.",
    lyrics: "The words, with section tags such as [Verse], [Pre-Chorus], [Chorus], [Bridge], [Outro] on their own lines. " +
      "The sections set the song's form, and together with the words its length: more sections, a longer song. " +
      "Leave a blank line between sections. Lyrics count against the same budget as the style (see the counter under the style box).",
    modes: "Full plan: the model first writes a score (melody and chords) and the song follows it. Best for new songs; the score can be edited.\n" +
      "Melody only: the score has the melody but no chords, so the accompaniment is free. Recommended for covers.\n" +
      "Direct: no score; the music is written straight from style and lyrics. Some add-ons (the sliders, some LoRAs) were trained this way.\n" +
      "A supplied score needs Full or Melody.",
    abc: "A score in YuE2's own notation: two voices, Vocal and Ins (instrument), in bars of 1/32 notes, with chord symbols on the Vocal line " +
      "and section comments (% verse). In Full or Melody mode the song follows it in time and pitch.\n" +
      "Plan score only writes one here to check or edit; a transcription or an older take can fill it too. " +
      "For a cover, use Melody only with a score that has no chord symbols.",
    versions: "Renders this prompt several times, each extra version with a fresh seed. " +
      "Picking the best of several is the most reliable way to a better song: the model card's own benchmark compared best-of-2 and best-of-8 picks.",
    cfg: "Classifier-free guidance, for the music stage only (the score planner never uses it). " +
      "The release defaults are 1.0 in Full and Melody mode and 1.01 in Direct.\n" +
      "Above 1 the music follows the style prompt more strongly; in Full and Melody mode the score is kept either way. " +
      "Any value other than 1.0 runs two passes per step: half the speed and twice the memory for the music stage. " +
      "No best value is published; 1.1 to 1.3 are the usual experiments.",
    shapeComposition: "Moves the score planner's temperature, top-p and top-k together. Left: familiar, safe melodies and chord changes; " +
      "right: surprising ones. The middle is the tuned default. No effect in Direct mode or with a supplied score (nothing is planned).",
    shapePerformance: "Moves the music stage's temperature, top-p and top-k together. Left: a steadier delivery that sticks to the prompt; " +
      "right: looser and more adventurous, with more garbled words. The middle is the tuned default.",
    shapeStyle: "Sets Guidance (CFG) from 0.85 to 1.15. Higher follows the style and lyrics more strongly; " +
      "any setting except the middle runs the music stage at half speed.",
    odeSteps: ODE,
    maxLength: "A ceiling on the song's length in seconds (360 by default): the music stage stops at 25 tokens per second of this. " +
      "The length itself comes from the lyrics and the score; this only cuts a runaway song short (it is then marked truncated).",
    variations: "Renders the same music up to 9 times with different sound seeds (seed, seed + 1, …) in one pass. " +
      "The music is written once, so this is a cheap way to pick the best-sounding render of a song you like.",
    outFormat: "WAV 24-bit: full quality; download it as FLAC or MP3 later from the song page.\n" +
      "WAV 16-bit: CD quality, smaller. WAV 32-bit float: the raw output, not normalised, can exceed full scale.\n" +
      "MP3: small, lossy; nothing better can be made from it later.",
    mp3Bitrate: "Bitrate when the song itself is made as MP3 (Format: MP3). 320 is near transparent; the server's own default is 128. " +
      "To share a WAV song as MP3, use the MP3 download on its page instead.",
    peakClip: "Loudness. The song is normalised so its loudest part reaches full scale after ignoring this many samples per million " +
      "(default 10: the top 0.001% are clipped, which also lifts quiet songs). 0 normalises to the true peak: no clipping, a little quieter. " +
      "WAV 32-bit float is not normalised.",
    instrumental: null,   // has its own (i)
    lookTheme: "The page's colours. The same choice as the swatches behind the theme button in the top bar; this browser keeps it.",
    lookCorners: "How round the corners of buttons, fields and cards are: Rounded (the default), Softer or Square.",
    lookHover: "Hover highlights take the theme's accent colour instead of a neutral grey (the DMM theme does this on its own).",
    lookGlow: "A faint ring and glow in the theme's accent around cards, drawers and panels.",
    lookMotion: "Turns the page's animations and fades off (spinners, sliding bars, tips fading in), whatever the system setting.",
    fontSans: "The font for labels, fields and paragraphs. The app's own fonts come first; under the line, fonts installed on this computer. " +
      "Each browser keeps its own choice.",
    fontHeading: "The font for headings: Compose, Takes, the song's title, the cards. Medium weight.",
    fontMono: "The font for numbers and code: seeds, the score, the server log. A fixed-width font keeps columns straight.",
    coverFile: "A recording to take the melody from (WAV, FLAC, MP3, M4A, OGG). Only the tune is transcribed: " +
      "not the words and not the singer's voice.",
    coverTask: "Lead melody: the most prominent line, voice or instrument, without chords (use Melody mode).\n" +
      "Vocal melody only: just the sung line.\n" +
      "Melody and chords: melody plus chord symbols (use Full mode).",
    coverTake: "One of your own takes whose score becomes the melody of a new song; the style and lyrics can change completely.",
    coverMelodyOnly: "Removes the chord symbols so the new style can build its own harmony (the run then uses Melody only). " +
      "Untick to keep the original chords and render in Full mode.",
    idea: "One line about the song you want (a story, a mood, a genre). The writer model drafts the title, style prompt and lyrics from it, " +
      "into the form below, where you can edit them before generating.",
    museModel: "The language model that drafts the brief (title, style and lyrics). Any instruction-following model works; " +
      "a bigger one writes better lyrics, a smaller one answers faster.",
    structure: "The shape of the lyrics the writer drafts: which sections (verse, chorus, bridge, pre-chorus, intro, outro) and in what order.",
    autoRun: "After the writer drafts the brief, start generating the song straight away with it.",
    museFree: "Unloads YuE2 from the GPU before the writer runs, so both fit on one card; YuE2 loads again for the song (a slower start).",
    // ------------------------------------------------------------ engine (PyTorch console)
    setModel: "The YuE2 model to load: a Hugging Face id such as m-a-p/YuE2-3B, or a local folder. A change loads with the next song.",
    setVae: "The VAE a song is decoded with when its request names none (saved prompts, other clients). " +
      "The VAE buttons in the form choose per song, and a finished song can get another from its page.",
    setOffline: "Use only files already on disk: nothing is checked or fetched online. " +
      "Turn it on once everything is downloaded to start faster and work without internet.",
    setDevice: "Where the model runs. Blank or auto: the GPU when there is one. cuda:1: the second GPU. cpu: no GPU (very slow).",
    setBackend: "torch: the normal path, with CUDA graphs for fast music writing.\n" +
      "torch-eager: the plain reference path, slower; for checking a problem.\n" +
      "vllm: the language half runs in a separate vllm process (needs the fast extra), one song at a time, " +
      "and the GPU is freed for the sound stage.",
    setQuant: "none: the release BF16 weights.\n" +
      "fp8: the language model's linear layers in 8 bits, about half their memory. Needs an RTX 40-series card or newer, " +
      "and turns off CUDA graphs, so music writing is much slower (about 6.5× in one user's measurement). Not allowed with FP32.",
    memPreset: "Fills VRAM budget and offload for a card of that size; press Save to apply. Auto reads this GPU's memory. " +
      "Whole card: no cap.",
    setBudget: "A hard cap on the GPU memory this app may use, in GB, with 2 GB of it kept in reserve. Blank or 0: the whole card.\n" +
      "At 12 or less the VAE also decodes in smaller tiles (512 frames instead of 1024: less memory, the same sound). " +
      "The model card measured an 11.2 GB peak on a 3.6-minute song and 14.1 GB at the longest context.",
    setOde: ODE,
    setOffload: "Moves the language model's layers to system RAM while the sound stage runs, and back afterwards: " +
      "a lower GPU memory peak for a few seconds more per song. Useful on 12–16 GB cards.",
    setWriterBackend: "Which program runs the writer model. Automatic: the chat server if an address is set, " +
      "else llama.cpp if it is installed here with a model, else Ollama.",
    setLlamaModel: "The GGUF model llama.cpp loads to write briefs. It runs only while a brief is written, then leaves the GPU.",
    writerDir: "Another folder to search for .gguf writer models; its models join the list above.",
    setChatUrl: "The /v1 address of a chat server that is already running. The page uses whatever model it has loaded; " +
      "it never loads, switches or unloads a model there.",
    setOllama: "Where Ollama listens (normally port 11434).",
    setMuseModel: "The Ollama model that writes briefs.",
    setMuseFree: "Unloads YuE2 from the GPU before the writer starts, so both fit on one card. YuE2 loads again for the next song.",
    setArtModel: "The image checkpoint that draws a cover from the song's title and style.",
    setArtAuto: "Draw a cover after every finished song, without asking.",
    artDir: "Another folder to search for image checkpoints.",
    setTxDevice: "Where the transcriber runs. GPU: seconds. CPU: leaves the GPU alone and takes about as long as the song.",
    setTxDtype: "The transcriber's number format. bf16: the normal GPU setting. fp32: full precision, slower and twice the memory.",
    // ------------------------------------------------------------ engine (C++ console)
    setMaxSeq: null,      // has its own (i)
    setVaeCore: "The VAE decodes the song in tiles of this many frames (512 by default). Smaller tiles need less GPU memory " +
      "at about the same speed, and give the same audio.",
    setKeepLoaded: null,  // has its own (i)
    chatUrl: "The /v1 address of a chat server that is already running, for the idea writer. The page uses whatever model it has loaded; " +
      "it never loads, switches or unloads a model there.",
    logFollow: "Keep the log scrolled to the newest line."
  };
  HELP.memPresetCpp = "Fills model, context rows, keep loaded and VAE tiles for a card of that size; press Save to apply. " +
    "Auto reads this GPU's memory.";

  // The sampler knobs, per stage: the score planner (abc) and the music tokens (semantic).
  var KNOBS = {
    abc: {
      temperature: "Randomness of the score planner (default 0.7). Lower: safer, more predictable melodies and chords; " +
        "0 always picks the most likely note. 0.8–0.9: more varied. Well above 1 the score can fall apart.",
      top_p: "Only the most likely next notes, up to this share of the total chance, are kept (default 0.9). Lower is safer.",
      top_k: "Only this many of the most likely next notes are kept (default 30). Lower is safer; 1 is greedy.",
      repetition_penalty: "Makes notes used in the recent window less likely (default 1.005, almost off). " +
        "The planner rarely loops, so leave it.",
      penalty_window: "How many recent tokens the repetition penalty looks back over (default 100).",
      min_tokens: "The score cannot end before this many tokens (default 32).",
      max_tokens: "The longest score, in tokens (default 4096, ample for a long song). A score cut off here cannot be used."
    },
    semantic: {
      temperature: "Randomness of the music (default 1.0). Lower (0.9–0.95) gives a steadier delivery and helps when words come out garbled; " +
        "higher is looser. 0 is greedy and tends to loop.",
      top_p: "Only the most likely next music tokens, up to this share of the total chance, are kept (default 0.95).",
      top_k: "Only this many of the most likely next music tokens are kept (default 100).",
      repetition_penalty: "Makes tokens used in the recent window less likely (default 1.2). The music needs about this much " +
        "to avoid getting stuck in loops; much higher makes it restless.",
      penalty_window: "How many recent music tokens the repetition penalty looks back over (default 50; the C++ server allows up to 100).",
      min_tokens: "The song cannot end before this many music tokens. There are 25 per second, so the default 200 is 8 seconds.",
      max_tokens: "The longest song, in music tokens: 25 per second, so the default 9000 is 6:00. A song cut off here is marked truncated."
    }
  };

  function makeInfo(text, name) {
    var info = document.createElement("span");
    info.className = "info";
    info.tabIndex = 0;
    info.setAttribute("role", "img");
    info.setAttribute("aria-label", "About " + name);
    info.dataset.tip = text;
    info.dataset.help = "1";
    info.textContent = "i";
    return info;
  }

  // Where the (i) goes: into the control's label text, before its grey hint.
  function place(el, text, name) {
    var host = el.closest("label.knob") ? el.closest("label.knob").querySelector("span") :
      el.closest("label.shape-row") ? el.closest("label.shape-row").querySelector(".shape-name") :
      el.closest("label.check") ? el.closest("label.check") :
      el.closest("label.versions") ? el.closest("label.versions").querySelector("span") :
      el.closest(".field") ? el.closest(".field").querySelector(".label") : null;
    if (el.id === "modes") host = el.closest("fieldset").querySelector(".label");
    if (host && host.querySelector(".info")) return;      // it already has one
    var info = makeInfo(text, name);
    if (!host) {
      if (el.nextElementSibling && el.nextElementSibling.classList.contains("info")) return;
      el.insertAdjacentElement("afterend", info);
      return;
    }
    if (el.closest("label.check")) {
      var span = host.querySelector("span");
      if (span) span.insertAdjacentElement("afterend", info); else host.appendChild(info);
      return;
    }
    var hint = host.querySelector("em");
    if (hint && hint.parentNode === host) host.insertBefore(info, hint); else host.appendChild(info);
  }

  function labelName(el) {
    var field = el.closest(".field, label");
    var label = field && field.querySelector(".label, span, .shape-name");
    return ((label && label.firstChild && label.firstChild.textContent) || el.id).trim() || el.id;
  }

  function decorate() {
    Object.keys(HELP).forEach(function (id) {
      var el = document.getElementById(id);
      if (!el || !HELP[id]) return;
      var text = HELP[id];
      if (id === "memPreset" && document.getElementById("setMaxSeq")) text = HELP.memPresetCpp;
      place(el, text, labelName(el));
    });
    Array.prototype.forEach.call(document.querySelectorAll(".knobs[data-group] input[data-key]"), function (input) {
      var group = KNOBS[input.dataset.group] || {}, text = group[input.dataset.key];
      if (text) place(input, text, input.dataset.key.replace(/_/g, " "));
    });
  }

  function hasHelp(el) {
    if (el.dataset.tip || el.dataset.tipRef) return true;
    var scope = el.closest("label.knob, label.shape-row, label.check, label.versions, .field, fieldset") || el.parentNode;
    if (scope && scope.querySelector(".info")) return true;
    if (el.nextElementSibling && el.nextElementSibling.classList.contains("info")) return true;
    var row = el.closest(".check-row");
    return !!(row && row.querySelector(".info"));
  }

  function missing() {
    var skip = { themePick: 1, volume: 1, openFile: 1 };
    return Array.prototype.filter.call(document.querySelectorAll("input[id], select[id], textarea[id]"), function (el) {
      return !skip[el.id] && el.type !== "radio" && el.type !== "hidden" && !hasHelp(el);
    }).map(function (el) { return el.id; });
  }

  // ------------------------------------------------------------ prompt size
  // What fits: 24,576 context tokens minus the longest score (4,096) and song (9,000) and the
  // instruction and markers; the rest is shared by style and lyrics.
  var PROMPT_BUDGET = 24576 - 4096 - 9000 - 80;

  // An estimate without the tokenizer: English runs about 3.6 characters a token, other scripts ~1
  function estimateTokens(text) {
    var ascii = 0, other = 0;
    for (var i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) < 128) ascii++; else other++;
    }
    return Math.ceil(ascii / 3.6 + other);
  }

  function paintMeter() {
    var style = document.getElementById("style"), lyrics = document.getElementById("lyrics"), out = document.getElementById("styleMeter");
    if (!style || !out) return;
    var s = estimateTokens(style.value), both = s + (lyrics ? estimateTokens(lyrics.value) : 0);
    out.textContent = style.value.length.toLocaleString() + " characters, about " + s.toLocaleString() + " tokens. " +
      "Style and lyrics together: about " + both.toLocaleString() + " of " + PROMPT_BUDGET.toLocaleString() + " tokens" +
      (both > PROMPT_BUDGET ? " \u2014 too long for a full-length song and score." : ".");
    out.classList.toggle("is-warn", both > PROMPT_BUDGET * 0.75 && both <= PROMPT_BUDGET);
    out.classList.toggle("is-over", both > PROMPT_BUDGET);
  }

  function growBox(box) {
    box.style.height = "auto";
    box.style.height = Math.min(Math.round(window.innerHeight * 0.5), Math.max(76, box.scrollHeight + 4)) + "px";
  }

  var watching = false;
  function watchPrompt() {
    var style = document.getElementById("style"), lyrics = document.getElementById("lyrics"), idea = document.getElementById("idea");
    if (watching || !style) return;
    watching = true;
    var sized = window.CSS && CSS.supports && CSS.supports("field-sizing", "content");
    var last = null;
    function tick() {
      // the texts themselves: a new prompt of the same length set by the page must still repaint
      var now = style.value + "\u0000" + (lyrics ? lyrics.value : "");
      if (now === last) return;
      last = now;
      if (!sized) growBox(style);
      paintMeter();
    }
    // browsers without field-sizing: the idea box grows by hand too
    if (!sized && idea) idea.addEventListener("input", function () { growBox(idea); });
    style.addEventListener("input", tick);
    if (lyrics) lyrics.addEventListener("input", tick);
    setInterval(tick, 700);     // values set by the page itself (examples, reuse, the writer) fire no input event
    tick();
  }

  // Pressing an (i) inside a label or a drawer heading must not tick, focus or fold anything.
  document.addEventListener("click", function (event) {
    var info = event.target.closest && event.target.closest(".info");
    if (info && info.closest("label, summary")) event.preventDefault();
  }, true);

  function start() {
    decorate();
    watchPrompt();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  root.YueHelp = { decorate: decorate, missing: missing, text: HELP, knobs: KNOBS, estimateTokens: estimateTokens,
    promptBudget: PROMPT_BUDGET };
})(window);
