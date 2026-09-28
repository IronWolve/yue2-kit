/* YuE2 Console for the C++ server — client. The same page as the PyTorch
   console: runs are followed through the server's own log stream, finished
   songs come from its library on disk. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var all = function (selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); };

  /* ------------------------------------------------------------ JSON + seeds */
  // Seeds are 63-bit integers. A browser number keeps 53 bits, so inside the
  // page they are digit strings, and on the wire they go back to bare integers.
  var SEED_IN = /("(?:lm_seed|seed)"\s*:\s*)(-?\d+)(?=\s*[,}\]])/g;
  var SEED_OUT = /("(?:lm_seed|seed)"\s*:\s*)"(-?\d+)"/g;

  function parseJSON(text) { return JSON.parse(String(text).replace(SEED_IN, '$1"$2"')); }
  function toJSON(value, indent) { return JSON.stringify(value, null, indent).replace(SEED_OUT, "$1$2"); }

  function api(path, options) {
    return fetch(path, options).then(function (r) {
      return r.text().then(function (text) {
        var body = null;
        if (text) { try { body = parseJSON(text); } catch (error) { body = null; } }
        if (!r.ok) {
          var failure = new Error((body && (body.error || body.detail)) || (r.status + " " + r.statusText));
          failure.status = r.status;
          throw failure;
        }
        return body;
      });
    });
  }

  function post(path, value) {
    var options = { method: "POST" };
    if (value !== undefined) {
      options.headers = { "Content-Type": "application/json" };
      options.body = toJSON(value);
    }
    return api(path, options);
  }

  var STATE = {
    props: null,
    defaults: {},
    vaes: [],
    defaultVae: "standard",
    sliderCatalog: [],
    maxBatch: 1,
    transcriber: false,
    library: true,
    online: false,
    takes: [],          // the library, newest first (plus takes kept in this tab)
    session: [],        // takes kept in this tab when the server has no library
    take: null,         // the take being inspected
    requests: {},       // replay requests by take name
    noRequest: {},      // takes whose saved request could not be read
    peakCache: {},      // waveform peaks by audio url
    peakLoading: {},
    peaks: null,
    jobs: [],           // every run this page knows about
    job: null,          // the run shown in the take column
    running: null,      // the live run, even while a finished take is open
    sliderChoice: [],
    codes: null,        // a take's music codes loaded into the form
    favOnly: false,
    abcRendered: ""
  };

  var SAMPLER_KNOBS = [
    ["temperature", "Temperature", 0.05],
    ["top_p", "Top-p", 0.01],
    ["top_k", "Top-k", 1],
    ["repetition_penalty", "Repetition penalty", 0.005],
    ["penalty_window", "Penalty window", 1],
    ["min_tokens", "Min tokens", 1],
    ["max_tokens", "Max tokens", 100]
  ];

  // The fallbacks are the protocol's own values; /props replaces them.
  var PROTOCOL_DEFAULTS = {
    cot: "full", duration: 360, steps: 32, peak_clip: 10, mp3_bitrate: 128, output_format: "mp3",
    abc_sampling: { temperature: 0.7, top_p: 0.9, top_k: 30, repetition_penalty: 1.005, penalty_window: 100, min_tokens: 32, max_tokens: 4096 },
    semantic_sampling: { temperature: 1.0, top_p: 0.95, top_k: 100, repetition_penalty: 1.2, penalty_window: 50, min_tokens: 200, max_tokens: 9000 }
  };

  var FRAME_RATE = 25;    // music tokens per second of audio

  var VAE_NOTES = { standard: "best sound", legacy: "benchmark" };
  // what each VAE is, on hover (the repo follows on its own line)
  var VAE_TIPS = {
    standard: "Standard: the quality choice, and the newer model. The current official decoder and the default, the cleanest sound.",
    legacy: "Legacy: the older official decoder. The published benchmark scores were made with it; less clean than Standard, and some hear it as more musical.",
    blend: "Blend: a mix of the two official decoders, \u2154 Standard and \u2153 Legacy (a community weight mix, not newly trained)."
  };
  var VAE_NOTES_LONG = {
    standard: "stock: current official, best sound",
    legacy: "stock: older official, used for the published scores",
    blend: "add-on: a community mix, \u2154 Standard + \u2153 Legacy"
  };
  var FORMAT_LABELS = { wav24: "WAV 24-bit", wav16: "WAV 16-bit", wav32: "WAV 32-bit float", mp3: "MP3" };
  var MODES = { full: "Full plan", melody: "Melody only", off: "Direct" };

  // Short original examples for "Supply your own score": an eight-bar melody
  // for the City Lights words, the same with chords, and a jazz reharmonization.
  var ABC_HEAD = 'X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=88\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\n' +
                 'V: Ins clef=treble name="Ins Melody" snm="Inst."\nK:C\n';
  function exampleScore(v1, v2, v3, v4, c1, c2, c3, c4) {
    return ABC_HEAD + "% verse\nV: Vocal\n" +
      v1 + "E2G2A2G2E2D2C4|" + v2 + "D2E2G2E2D2C2D4|" + v3 + "E2G2A2c2B2A2G4|" + v4 + "F2E2D2E2G2E2C4|\nV: Ins\nZ4|\n" +
      "% chorus\nV: Vocal\n" +
      c1 + "G2A2c2B2A2G2E4|" + c2 + "F2A2G2E2D2E2G4|" + c3 + "A2c2B2A2G2E2D4|" + c4 + "E2G2A2G2E2D2C4|\nV: Ins\nZ4|\n";
  }
  var EXAMPLE_ABC = {
    melody: exampleScore("", "", "", "", "", "", "", ""),
    score: exampleScore('"C"', '"G"', '"Am"', '"F"', '"C"', '"F"', '"G"', '"C"'),
    jazz: exampleScore('"Cmaj7"', '"G7"', '"Am7"', '"Fmaj7"', '"Cmaj7"', '"Fmaj7"', '"G7"', '"Cmaj7"')
  };

  /* ------------------------------------------------------------ helpers */

  function clock(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    var m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function ago(epoch) {
    var d = (Date.now() / 1000) - epoch;
    if (d < 60) return "just now";
    if (d < 3600) return Math.floor(d / 60) + " min ago";
    if (d < 86400) return Math.floor(d / 3600) + " h ago";
    return new Date(epoch * 1000).toLocaleDateString();
  }

  function toast(message, kind) {
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = message;
    $("toasts").appendChild(el);
    setTimeout(function () {
      el.style.transition = "opacity .3s ease";
      el.style.opacity = "0";
      setTimeout(function () { el.remove(); }, 320);
    }, kind === "bad" ? 8000 : 4200);
  }

  var toasted = {};
  function toastOnce(key, message, kind) {
    if (toasted[key]) return;
    toasted[key] = true;
    toast(message, kind);
  }

  function escape(text) {
    return String(text).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function basename(path) { return String(path || "").split(/[\\/]/).pop(); }
  function round(value, digits) { return Number(Number(value).toFixed(digits)); }

  function slug(text) {
    return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "song";
  }

  function downloadText(name, text, type) {
    var link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: type }));
    link.download = name;
    document.body.appendChild(link);
    link.click();
    setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
  }

  function store(key, value) {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (error) { /* private mode */ }
  }
  function recall(key) {
    try { return localStorage.getItem(key); } catch (error) { return null; }
  }

  function randomSeed63() {
    var words = new Uint32Array(2);
    crypto.getRandomValues(words);
    return ((BigInt(words[0] & 0x7fffffff) << BigInt(32)) | BigInt(words[1])).toString();
  }

  /* --------------------------------------------------------------- views */
  /* Compose and the running take share the screen, so the only thing that
     shows and hides is the engine panel. */

  function show(view) {
    if (view === "engine") {
      $("view-engine").classList.toggle("is-hidden");
      if (!$("view-engine").classList.contains("is-hidden")) scrollLogToEnd();
    } else if (view === "take") {
      $("view-engine").classList.add("is-hidden");
      drawWave();
      if (window.innerWidth <= 1150) $("view-take").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  $("engineToggle").addEventListener("click", function () { show("engine"); });
  $("engineBack").addEventListener("click", function () { $("view-engine").classList.add("is-hidden"); });

  function closeMenus() {
    all(".menu-pop").forEach(function (menu) { menu.classList.add("is-hidden"); });
    all("[aria-haspopup]").forEach(function (button) { button.setAttribute("aria-expanded", "false"); });
  }

  function menuToggle(buttonId, menuId) {
    $(buttonId).addEventListener("click", function (event) {
      event.stopPropagation();
      var menu = $(menuId), opening = menu.classList.contains("is-hidden");
      closeMenus();
      if (opening) {
        menu.classList.remove("is-hidden");
        this.setAttribute("aria-expanded", "true");
        var first = menu.querySelector("button");
        if (first) first.focus();
      }
    });
  }
  menuToggle("savePrompt", "saveMenu");
  menuToggle("libMenuBtn", "libMenu");
  document.addEventListener("click", function (event) {
    if (!event.target.closest(".menu-pop")) closeMenus();
  });

  document.addEventListener("keydown", function (event) {
    if (event.defaultPrevented) return;   // a list card already used the key
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    if (event.key === "Escape") { $("view-engine").classList.add("is-hidden"); closeMenus(); }
    if (event.key === " " && (audio.getAttribute("src") || STATE.take) && !event.target.closest(".menu-pop")) { event.preventDefault(); togglePlay(); }
  });

  /* ------------------------------------------------------------ info tips */
  // One floating tip for the page: [data-tip] shows its text, [data-tip-ref] a
  // <template>. It sits on the body, so a scrolling column cannot clip it.
  var tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  var tipFor = null;

  function showTip(target) {
    var ref = target.dataset.tipRef;
    tip.textContent = "";
    if (ref) tip.appendChild(document.getElementById(ref).content.cloneNode(true));
    else tip.textContent = target.dataset.tip;
    tip.classList.toggle("tip-rich", !!ref);
    tip.classList.add("is-on");
    var box = target.getBoundingClientRect(), width = tip.offsetWidth, height = tip.offsetHeight;
    var top = box.top - height - 8;
    if (top < 60) top = Math.min(box.bottom + 8, window.innerHeight - height - 8);   // no room above: below
    tip.style.left = Math.max(8, Math.min(box.left + box.width / 2 - width / 2, window.innerWidth - width - 8)) + "px";
    tip.style.top = Math.max(8, top) + "px";
    tipFor = target;
  }

  function hideTip() { tip.classList.remove("is-on"); tipFor = null; }

  function tipTarget(node) { return node && node.closest ? node.closest("[data-tip], [data-tip-ref]") : null; }

  document.addEventListener("mouseover", function (event) {
    var target = tipTarget(event.target);
    if (target && target !== tipFor) showTip(target);
    else if (!target && tipFor) hideTip();
  });
  document.addEventListener("focusin", function (event) {
    var target = tipTarget(event.target);
    if (target) showTip(target); else if (tipFor) hideTip();
  });
  document.addEventListener("focusout", hideTip);
  // A scroll moves the target away from its tip; one reached by the keyboard keeps it. A box that scrolls
  // without holding the target (the server log following new lines) leaves the tip alone.
  document.addEventListener("scroll", function (event) {
    if (!tipFor) return;
    var box = event.target;
    if (box !== document && !(box.contains && box.contains(tipFor))) return;
    if (tipFor === document.activeElement) showTip(tipFor); else hideTip();
  }, true);

  // The VAE tip lists what this server actually offers; the versions tip says
  // how many songs one pass holds.
  function fillTips() {
    var list = $("tip-vae").content.querySelector('[data-fill="vaes"]');
    if (list && STATE.vaes.length) {
      list.innerHTML = STATE.vaes.map(function (v) {
        var note = VAE_NOTES_LONG[v.name];
        return "<dt>" + escape(v.label || v.name) + "</dt><dd><code>" + escape(v.repo || v.name) + "</code>" +
          (note ? "<br />" + escape(note) : "") + "</dd>";
      }).join("");
    }
    var batch = $("tip-versions").content.querySelector('[data-fill="max-batch"]');
    if (batch) batch.textContent = String(STATE.maxBatch);
  }

  /* -------------------------------------------------------------- themes */
  // The theme is applied in <head> before first paint; this is the picker.
  // Canvas drawing reads its colours from the active theme's CSS variables.
  var themeCache = {};

  function themeRGB(name) {
    if (!themeCache[name]) {
      var hex = getComputedStyle(document.documentElement).getPropertyValue("--" + name).trim().replace("#", "");
      if (hex.length === 3) hex = hex.replace(/./g, "$&$&");
      themeCache[name] = [parseInt(hex.slice(0, 2), 16) || 0, parseInt(hex.slice(2, 4), 16) || 0, parseInt(hex.slice(4, 6), 16) || 0];
    }
    return themeCache[name];
  }

  function themeRGBA(name, alpha) {
    var c = themeRGB(name);
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + alpha + ")";
  }

  // The theme picker (themes.js, shared with the other console): a preview or a change redraws
  // what the page paints itself from the theme's colours
  YueThemes.mount($("themeButton"), {
    onChange: function () {
      themeCache = {};
      drawWave();
      if (STATE.abcRendered) renderScore(STATE.abcRendered);
    }
  });

  /* ------------------------------------------------------------ sampling */

  // Decimal knobs step fine enough to reach every value the docs and model cards
  // use: temperature 0.70 -> 0.71 (presets 0.55/0.85, cards 0.82/0.88/0.94), top-p
  // by 0.005 (a card uses 0.975), repetition penalty 0.005 in the planner (1.005)
  // and 0.01 for music tokens (cards use 1.18 and 1.24 around the 1.2 default).
  // Anything else uses the step column of SAMPLER_KNOBS (top-k 1, window 1, max
  // tokens 100).
  function knobStep(knob, def) {
    if (knob[0] === "temperature") return 0.01;
    if (knob[0] === "top_p") return 0.005;
    if (knob[0] === "repetition_penalty") return def < 1.05 ? 0.005 : 0.01;
    return knob[2] || 1;
  }
  // the server refuses values past these (protocol bounds)
  var KNOB_MAX = { temperature: 5, top_p: 1, penalty_window: 100 };

  function samplingDefault(group, key) {
    var preset = STATE.defaults[group + "_sampling"] || PROTOCOL_DEFAULTS[group + "_sampling"];
    return preset[key];
  }

  function buildKnobs() {
    ["abc", "semantic"].forEach(function (group) {
      var host = document.querySelector('.knobs[data-group="' + group + '"]');
      host.innerHTML = "";
      SAMPLER_KNOBS.forEach(function (knob) {
        var wrap = document.createElement("label");
        wrap.className = "knob";
        wrap.innerHTML = "<span>" + knob[1] + "</span>";
        var input = document.createElement("input");
        input.type = "number";
        // The default also goes in the value attribute: that makes it the step
        // base, so arrows move 0.7 -> 0.8 / 0.6 and a default like 1.005 stays on
        // the step grid. Never set min: it would override the step base.
        var def = round(samplingDefault(group, knob[0]), 6);
        input.step = String(knobStep(knob, def));
        if (KNOB_MAX[knob[0]] !== undefined) input.max = String(KNOB_MAX[knob[0]]);
        input.dataset.group = group;
        input.dataset.key = knob[0];
        input.setAttribute("value", def);
        input.value = def;
        wrap.appendChild(input);
        host.appendChild(wrap);
      });
    });
    if (window.YueHelp) YueHelp.decorate();   // the knobs were just rebuilt
  }

  function samplingOverrides(group) {
    var out = {};
    all('input[data-group="' + group + '"]').forEach(function (input) {
      var value = parseFloat(input.value);
      if (isFinite(value) && value !== round(samplingDefault(group, input.dataset.key), 6)) {
        out[input.dataset.key] = /_(k|window|tokens)$/.test(input.dataset.key) ? Math.round(value) : value;
      }
    });
    return out;
  }

  // Guidance shows the value the engine actually uses for the chosen planning
  // mode (1.0 for full and melody, 1.01 for direct) until you type your own.
  function defaultCfg(cot) { return cot === "off" ? 1.01 : 1.0; }
  function currentCot() {
    var checked = document.querySelector('input[name="cot"]:checked');
    return checked ? checked.value : "full";
  }
  function setCot(cot) {
    var radio = document.querySelector('input[name="cot"][value="' + cot + '"]');
    if (radio) radio.checked = true;
    fillCfg();
    paintSliders();
    YueLoras.repaint();
  }
  function fillCfg() {
    if ($("cfg").dataset.touched) return;
    var def = currentCot() === "off" ? "1.01" : "1.0";
    $("cfg").setAttribute("value", def);   // step base: arrows go 1.0 -> 1.01 / 0.99
    $("cfg").value = def;
  }
  $("cfg").addEventListener("input", function () { this.dataset.touched = this.value.trim() ? "1" : ""; if (!this.value.trim()) fillCfg(); });
  all('input[name="cot"]').forEach(function (radio) { radio.addEventListener("change", fillCfg); });
  fillCfg();

  $("resetSampling").addEventListener("click", function () {
    all("input[data-group]").forEach(function (input) {
      input.value = round(samplingDefault(input.dataset.group, input.dataset.key), 6);
    });
    $("cfg").dataset.touched = "";
    fillCfg();
    syncShape();
    toast("Sampling reset to defaults");
  });

  /* --------------------------------------------------------- shape sliders */
  // Five-step shortcuts over the sampling knobs, using the reference studio's
  // published mappings. Position 2 is the engine default.
  var SHAPES = {
    shapeComposition: { group: "abc", keys: ["temperature", "top_p", "top_k"],
      steps: [[0.55, 0.82, 16], [0.6, 0.86, 24], [0.7, 0.9, 30], [0.85, 0.94, 45], [1.0, 0.97, 64]] },
    shapePerformance: { group: "semantic", keys: ["temperature", "top_p", "top_k"],
      steps: [[0.8, 0.88, 50], [0.9, 0.92, 75], [1.0, 0.95, 100], [1.1, 0.97, 140], [1.2, 0.99, 200]] },
    shapeStyle: { cfg: [0.85, 0.95, null, 1.05, 1.15] }
  };
  var SHAPE_LABELS = ["lowest", "low", "default", "high", "highest"];

  function knobInput(group, key) {
    return document.querySelector('input[data-group="' + group + '"][data-key="' + key + '"]');
  }

  function applyShape(id) {
    var spec = SHAPES[id], pos = parseInt($(id).value, 10);
    if (spec.cfg) {
      var value = spec.cfg[pos];
      if (value === null) { $("cfg").dataset.touched = ""; fillCfg(); }
      else { $("cfg").value = value; $("cfg").dataset.touched = "1"; }
    } else {
      spec.keys.forEach(function (key, i) {
        var input = knobInput(spec.group, key);
        if (input) input.value = spec.steps[pos][i];
      });
    }
    syncShape();
  }

  // Show where the knobs sit; "custom" when they match no position.
  function syncShape() {
    Object.keys(SHAPES).forEach(function (id) {
      var spec = SHAPES[id], found = -1;
      if (spec.cfg) {
        var auto = !$("cfg").dataset.touched;
        spec.cfg.forEach(function (v, pos) {
          if ((v === null && auto) || (v !== null && !auto && parseFloat($("cfg").value) === v)) found = pos;
        });
      } else {
        spec.steps.forEach(function (values, pos) {
          var every = spec.keys.every(function (key, i) {
            var input = knobInput(spec.group, key);
            return input && parseFloat(input.value) === values[i];
          });
          if (every) found = pos;
        });
      }
      if (found >= 0) $(id).value = found;
      var out = $(id + "Out");
      out.textContent = found >= 0 ? SHAPE_LABELS[found] : "custom";
      out.classList.toggle("custom", found < 0);
    });
  }

  Object.keys(SHAPES).forEach(function (id) {
    $(id).addEventListener("input", function () { applyShape(id); });
  });
  $("shapeReset").addEventListener("click", function () {
    Object.keys(SHAPES).forEach(function (id) { $(id).value = 2; applyShape(id); });
    toast("Sliders reset to the tuned defaults");
  });
  document.querySelector(".sampler-grid").addEventListener("input", syncShape);
  $("cfg").addEventListener("input", syncShape);

  /* ------------------------------------------------------ sound and output */
  // The C++ engine's own settings: ODE steps, the length cap, variations per
  // song, and how the audio file is written.

  function outDefault(key) {
    var value = STATE.defaults[key];
    return value === undefined || value === null ? PROTOCOL_DEFAULTS[key] : value;
  }

  function paintOutputDefaults() {
    [["odeSteps", "steps"], ["maxLength", "duration"], ["peakClip", "peak_clip"]].forEach(function (pair) {
      var def = round(outDefault(pair[1]), 3);
      $(pair[0]).setAttribute("value", def);
      $(pair[0]).value = def;
    });
    var saved = null;
    try { saved = JSON.parse(recall("yue2.output") || "null"); } catch (error) { saved = null; }
    // WAV 24 by default: the fair comparison with the other console's 24-bit files.
    $("outFormat").value = saved && FORMAT_LABELS[saved.format] ? saved.format : "wav24";
    $("mp3Bitrate").value = saved && saved.bitrate ? String(saved.bitrate) : String(outDefault("mp3_bitrate"));
    if (!$("mp3Bitrate").value) $("mp3Bitrate").value = "128";
    paintOutput();
  }

  function paintOutput() {
    var format = $("outFormat").value;
    $("bitrateField").classList.toggle("is-hidden", format !== "mp3");
    var parts = [FORMAT_LABELS[format] + (format === "mp3" ? " " + $("mp3Bitrate").value + " kbps" : "")];
    var steps = parseInt($("odeSteps").value, 10), length = parseFloat($("maxLength").value);
    var variations = parseInt($("variations").value, 10) || 1;
    if (isFinite(steps) && steps !== outDefault("steps")) parts.push(steps + " steps");
    if (isFinite(length) && length !== outDefault("duration")) parts.push("up to " + clock(length));
    if (variations > 1) parts.push(variations + " sounds each");
    $("outSummary").textContent = parts.join(" · ");
    var notes = [];
    notes.push("Songs end on their own; max length only caps them (the music tokens stop at " +
      clock(samplingDefault("semantic", "max_tokens") / FRAME_RATE) + ").");
    if (format === "wav32") notes.push("WAV 32 is raw float: peak clip is ignored.");
    if (variations > 1) notes.push("Each song renders " + variations + " times with sound seeds seed, seed + 1\u2026; the music is written once.");
    $("outHint").textContent = notes.join(" ");
  }

  function saveOutputChoice() {
    store("yue2.output", JSON.stringify({ format: $("outFormat").value, bitrate: parseInt($("mp3Bitrate").value, 10) }));
  }

  $("outFormat").addEventListener("change", function () { saveOutputChoice(); paintOutput(); });
  $("mp3Bitrate").addEventListener("change", function () { saveOutputChoice(); paintOutput(); });
  ["odeSteps", "maxLength", "variations", "peakClip"].forEach(function (id) { $(id).addEventListener("input", paintOutput); });

  $("resetOutput").addEventListener("click", function () {
    $("variations").value = 1;
    store("yue2.output", null);
    paintOutputDefaults();
    toast("Output reset: WAV 24-bit, " + outDefault("steps") + " steps, no length cap below the default");
  });

  function readOutput() {
    var out = {};
    var steps = $("odeSteps").value.trim(), length = $("maxLength").value.trim();
    var variations = $("variations").value.trim(), clip = $("peakClip").value.trim();
    if (steps !== "") {
      var s = Number(steps);
      if (!Number.isInteger(s) || s < 1) throw new Error("ODE steps must be a whole number, 1 or more");
      if (s !== outDefault("steps")) out.steps = s;
    }
    if (length !== "") {
      var d = Number(length);
      if (!isFinite(d) || d <= 0) throw new Error("Max length must be a number of seconds above 0");
      if (d !== outDefault("duration")) out.duration = d;
    }
    if (variations !== "") {
      var v = Number(variations);
      if (!Number.isInteger(v) || v < 1 || v > 9) throw new Error("Sound variations must be between 1 and 9");
      if (v > 1) out.synth_batch_size = v;
    }
    out.output_format = $("outFormat").value;
    if (out.output_format === "mp3") out.mp3_bitrate = parseInt($("mp3Bitrate").value, 10) || 128;
    if (clip !== "") {
      var c = Number(clip);
      if (!Number.isInteger(c) || c < 0) throw new Error("Peak clip must be a whole number, 0 or more");
      if (c !== outDefault("peak_clip")) out.peak_clip = c;
    }
    return out;
  }

  /* ---------------------------------------------------------------- VAEs */

  function vaeInfo(name) { return STATE.vaes.filter(function (v) { return v.name === name; })[0] || null; }
  function vaeLabel(name) { var v = vaeInfo(name); return v ? (v.label || v.name) : (name || "default"); }

  // One VAE per song, kept per browser. A take can gain another VAE version
  // later from its page.
  function paintVaes() {
    var current = selectedVae(true);
    $("decoders").innerHTML = STATE.vaes.map(function (v) {
      var tip = (VAE_TIPS[v.name] ? VAE_TIPS[v.name] + "\n" : "") + (v.repo || v.name);
      return '<label class="toggle" data-tip="' + escape(tip) + '"><input type="radio" name="vae" value="' +
        escape(v.name) + '" /><span><span class="vae-name">' + escape(v.label || v.name) + "</span>" +
        (YueVaes.kindOf(v) === "add-on" ? YueVaes.badge("add-on") : "") + "</span>" +
        (VAE_NOTES[v.name] ? "<small>" + VAE_NOTES[v.name] + "</small>" : "") + "</label>";
    }).join("");
    var want = current || recall("yue2.vae");
    if (!vaeInfo(want)) want = STATE.defaultVae;
    checkVae(want);
  }

  function checkVae(name) {
    all("#decoders input").forEach(function (input) { input.checked = input.value === name; });
    if (!document.querySelector("#decoders input:checked")) {
      var first = document.querySelector("#decoders input");
      if (first) first.checked = true;
    }
    YueVaes.repaint();
  }

  function selectedVae(noFallback) {
    var input = document.querySelector("#decoders input:checked");
    return input ? input.value : (noFallback ? null : STATE.defaultVae);
  }

  $("decoders").addEventListener("change", function () { store("yue2.vae", selectedVae()); YueVaes.repaint(); });

  // The Engine panel's VAE tiles (vaes.js) mark the one the form has picked
  YueVaes.listInto($("vaeCard"), $("vaeCardNote"), { current: function () { return selectedVae(true) || ""; } });

  /* ------------------------------------------------------------- sliders */
  // Voice and genre sliders from the server's catalogue: tap to add, stack any
  // number, each with its own strength. They steer music-token writing only.

  function sliderLabels() {
    var labels = {};
    (STATE.sliderCatalog || []).forEach(function (entry) { labels[entry.id] = entry.label || entry.id; });
    return labels;
  }

  var NO_SLIDERS = "None on this server. Start it with --sliders to add voice and genre sliders.";

  // The Engine panel's Sliders card: where they come from (an add-on) and one tile per slider, the ones
  // in the song form marked. For reading: the form's chips add and remove them.
  function paintSliderCard() {
    var list = STATE.sliderCatalog || [], chosen = {}, src = (STATE.sources || {}).sliders || {};
    var url = /^https?:\/\//i.test(String(src.url || "")) ? String(src.url) : "";   // only web links become links
    STATE.sliderChoice.forEach(function (c) { chosen[c.id] = c; });
    $("sliderSource").innerHTML = (url
      ? '<a class="tile-link" href="' + escape(url) + '" target="_blank" rel="noopener noreferrer" data-tip="' +
        escape("Open its model card (new tab): " + url) + '"><span>' + escape(src.repo || url) + "</span>\u2197</a>" : "") +
      (src.about ? '<span class="info" tabindex="0" role="img" aria-label="About the sliders" data-tip="' + escape(src.about) + '">i</span>' : "");
    $("sliderCard").innerHTML = list.map(function (e) {
      var on = chosen[e.id], ok = e.installed !== false;
      var meta = [e.description || "", ok ? "" : "not downloaded"].filter(Boolean).join(" · ");
      return '<li class="lora-item slider-item' + (on ? " is-on" : "") + (ok ? "" : " is-bad") + '" data-slider-tile="' + escape(e.id) + '">' +
        '<div class="lora-item-head"><span class="lora-item-name">' + escape(e.label || e.id) + "</span>" +
        (on ? '<span class="tile-state">in the song form \u00b7 ' + Number(on.strength).toFixed(2) + "</span>" : "") + "</div>" +
        '<div class="lora-item-meta">' + escape(meta) + "</div></li>";
    }).join("");
    $("sliderCardNote").textContent = list.length
      ? list.length + " voice and genre sliders" + (STATE.sliderChoice.length ? " · " + STATE.sliderChoice.length + " in the song form" : " · none in the song form")
      : NO_SLIDERS;
  }

  function paintSliders() {
    paintSliderCard();
    var catalog = STATE.sliderCatalog || [], labels = sliderLabels(), on = {};
    STATE.sliderChoice.forEach(function (choice) { on[choice.id] = choice; });
    $("sliderChips").innerHTML = catalog.length ? catalog.map(function (entry) {
      return '<button type="button" class="chip' + (on[entry.id] ? " is-on" : "") + '" data-slider="' + escape(entry.id) + '"' +
        ' aria-pressed="' + (on[entry.id] ? "true" : "false") + '" data-tip="' +
        escape((entry.description ? entry.description + "\n" : "") + "Add-on slider (see Engine \u203a Sliders) \u00b7 " + entry.id) + '">' +
        escape(entry.label || entry.id) + "</button>";
    }).join("") : '<span class="row-hint">No sliders on this server (start it with --sliders).</span>';
    $("sliderActive").innerHTML = STATE.sliderChoice.map(function (choice) {
      var name = labels[choice.id] || choice.id;
      return '<div class="slider-row"><span class="slider-name">' + escape(name) + "</span>" +
        '<input type="range" min="0" max="1" step="0.05" value="' + choice.strength + '" data-strength="' + escape(choice.id) +
        '" aria-label="' + escape(name) + ' strength" /><output>' + choice.strength.toFixed(2) + "</output>" +
        '<button type="button" class="icon-btn" data-remove="' + escape(choice.id) + '" aria-label="Remove ' + escape(name) + '">✕</button></div>';
    }).join("");
    var notes = [];
    if (!STATE.sliderChoice.length) {
      if (catalog.length) notes.push("None active. Tap any slider to add it, and stack as many as you like.");
    } else {
      notes.push(STATE.sliderChoice.length + " active; experimental, and stacking is untested by the authors.");
      if (currentCot() !== "off") notes.push("They were trained in Direct mode; here they steer the music, not the score.");
      if (on.female && on.male) notes.push("Female and Male together pull in opposite directions.");
      if (STATE.codes) notes.push("Ignored while music codes are loaded: that music is already written.");
    }
    $("sliderHint").textContent = notes.join(" ");
  }

  $("sliderChips").addEventListener("click", function (event) {
    var chip = event.target.closest("[data-slider]");
    if (!chip || chip.disabled) return;
    var id = chip.dataset.slider, at = -1;
    STATE.sliderChoice.forEach(function (choice, index) { if (choice.id === id) at = index; });
    if (at >= 0) STATE.sliderChoice.splice(at, 1);
    else STATE.sliderChoice.push({ id: id, strength: 1 });
    paintSliders();
  });

  $("sliderActive").addEventListener("change", paintSliderCard);
  $("sliderActive").addEventListener("input", function (event) {
    var id = event.target.dataset.strength;
    if (!id) return;
    STATE.sliderChoice.forEach(function (choice) {
      if (choice.id === id) choice.strength = parseFloat(event.target.value);
    });
    event.target.nextElementSibling.textContent = parseFloat(event.target.value).toFixed(2);
  });

  $("sliderActive").addEventListener("click", function (event) {
    var button = event.target.closest("[data-remove]");
    if (!button) return;
    STATE.sliderChoice = STATE.sliderChoice.filter(function (choice) { return choice.id !== button.dataset.remove; });
    paintSliders();
  });

  all('input[name="cot"]').forEach(function (radio) { radio.addEventListener("change", paintSliders); });

  /* ---------------------------------------------------------------- LoRAs */
  // The picker is shared with the other console (loras.js); the catalog comes with /props.
  YueLoras.mount($("loraPicker"), {
    cot: function () { return currentCot(); },
    addToStyle: function (word) {
      var style = $("style").value;
      if (new RegExp("(^|[^\\w])" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^\\w]|$)", "i").test(style)) {
        return toast("The style already has \u201c" + word + "\u201d");
      }
      $("style").value = word + (style.trim() ? ", " + style.trim() : "");
      toast("Added \u201c" + word + "\u201d to the style");
    }
  });
  all('input[name="cot"]').forEach(function (radio) { radio.addEventListener("change", function () { YueLoras.repaint(); }); });
  YueLoras.listInto($("loraCard"), $("loraCardNote"));   // the Engine panel's list, under the VAEs

  /* ------------------------------------------------------- reused codes */
  // A take's music codes in the form: Generate renders exactly that music
  // again, with whatever sound settings the form now holds.

  function setCodes(codes) {
    STATE.codes = codes;
    $("codesNote").classList.toggle("is-hidden", !codes);
    if (codes) {
      $("codesNoteText").textContent = (codes.title ? "From \u201c" + codes.title + "\u201d. " : "") +
        "Generate renders that same music (" + clock(codes.frames / FRAME_RATE) + ") again; the VAE, the sound seed " +
        "and the sound settings decide how it sounds. Versions and sliders do not apply.";
    }
    paintSliders();
    paintSubmitNote();
  }

  function countCodes(tokens) {
    var text = String(tokens || "").trim();
    return text ? text.split(",").length : 0;
  }

  $("dropCodes").addEventListener("click", function () {
    setCodes(null);
    toast("Codes dropped: Generate writes new music from the prompt");
  });

  /* -------------------------------------------------------------- compose */

  // Verse, Chorus, Bridge and Interlude are the tags YuE2's own score vocabulary
  // documents; the rest are passed through as written, so say so plainly.
  var STRUCTURE_NOTES = {
    simple: "Verse and Chorus only.",
    bridge: "Verse, Chorus and Bridge — the tags YuE2's score vocabulary documents.",
    prechorus: "Adds [Pre-Chorus], which is not one of YuE2's documented tags: it is passed " +
               "through as written and may be sung as an ordinary section.",
    full: "Adds [Intro], [Pre-Chorus] and [Outro]. Only Verse, Chorus, Bridge and Interlude are " +
          "documented tags; the others are passed through as written, and instrumental sections " +
          "carry no lyrics, so the model may or may not leave them wordless."
  };

  // the chosen structure's note rides in the Structure (i), after its help text
  function paintStructureHint() {
    var info = $("structure").closest(".field").querySelector(".info");
    if (!info) return;
    info.dataset.base = info.dataset.base || info.dataset.tip;
    info.dataset.tip = info.dataset.base + " Now: " + (STRUCTURE_NOTES[$("structure").value] || "");
  }
  $("structure").addEventListener("change", paintStructureHint);
  paintStructureHint();

  // A 10-row box hides the bridge below the fold, which reads as truncated lyrics.
  function growLyrics() {
    var box = $("lyrics");
    box.style.height = "auto";
    box.style.height = Math.min(760, Math.max(180, box.scrollHeight + 4)) + "px";
  }
  $("lyrics").addEventListener("input", growLyrics);

  // Each dice toggles: an empty box (random each run) gets a seed to keep or edit; a seed is cleared
  var DICE = [["lmSeed", "rollLmSeed", "music seed"], ["soundSeed", "rollSoundSeed", "sound seed"]];
  function paintDice() {
    DICE.forEach(function (d) {
      var set = !!$(d[0]).value.trim(), dice = $(d[1]);
      var tip = set ? "Clear the " + d[2] + ": every run picks a random one again"
                    : "Put in a random " + d[2] + ", to keep or edit (press again to clear it)";
      dice.classList.toggle("is-set", set);
      dice.dataset.tip = tip;
      dice.setAttribute("aria-label", tip);
    });
  }
  DICE.forEach(function (d) {
    $(d[1]).addEventListener("click", function () {
      $(d[0]).value = $(d[0]).value.trim() ? "" : Math.floor(Math.random() * 2147483647);
      paintDice();
    });
    $(d[0]).addEventListener("input", paintDice);
    $(d[1]).addEventListener("mouseover", paintDice);   // seeds the page fills in (Retake, a plan) fire no input
  });
  paintDice();

  // A new song: everything about the song back to its default; the VAE, output and theme choices stay
  function newSong() {
    ["title", "style", "lyrics", "abc", "lmSeed", "soundSeed", "cfg"].forEach(function (id) { $(id).value = ""; });
    setCot("full");
    $("instrumental").checked = false;
    all("input[data-group]").forEach(function (input) {
      input.value = round(samplingDefault(input.dataset.group, input.dataset.key), 6);
    });
    $("cfg").dataset.touched = "";
    fillCfg();
    syncShape();
    $("versions").value = 1;
    $("variations").value = 1;
    STATE.sliderChoice = [];
    paintSliders();
    YueLoras.set([]);
    setCodes(null);
    $("scoreDrawer").open = false;
    growLyrics();
    paintDice();
    show("compose");
    $("view-compose").scrollTop = 0;
    $("title").focus();
    toast("New song: the form is back to its defaults (your VAE, output and theme choices stay)");
  }
  $("newSong").addEventListener("click", newSong);
  $("clearForm").addEventListener("click", newSong);

  $("loadExample").addEventListener("click", function () {
    var examples = window.YUE2_EXAMPLES || [];
    if (!examples.length) return toast("No examples were built into this page", "bad");
    var ex = examples[Math.floor(Math.random() * examples.length)];
    $("title").value = ex.title || "";
    $("style").value = String(ex.style || "").trim();
    $("lyrics").value = ex.lyrics || "";
    $("abc").value = ex.abc || "";
    $("lmSeed").value = ex.seed !== undefined && ex.seed !== null && /^\d+$/.test(String(ex.seed)) ? String(ex.seed) : "";
    $("soundSeed").value = "";
    paintDice();
    setCodes(null);
    setCot(ex.cot || "full");
    if (ex.abc) $("scoreDrawer").open = true;
    growLyrics();
    toast("Example loaded: " + (ex.title || "untitled") + (ex.abc ? " (with its score)" : ""));
  });

  all("[data-abc]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var key = btn.dataset.abc;
      if (!key) { $("abc").value = ""; return toast("Score removed"); }
      $("abc").value = EXAMPLE_ABC[key];
      toast("Score loaded — melody mode suits covers best");
    });
  });

  function readSeed(id, label) {
    var raw = $(id).value.trim();
    if (!raw) return null;
    if (!/^\d+$/.test(raw)) throw new Error(label + " must be a whole number, or blank for random");
    if (BigInt(raw) >= (BigInt(1) << BigInt(63))) throw new Error(label + " must be below 2^63");
    return BigInt(raw).toString();
  }

  // What the take is called when no title was typed: the hook line, or the style.
  function songTitle() {
    var title = $("title").value.trim();
    if (title) return title;
    var sung = $("lyrics").value.split(/\r?\n/).map(function (l) { return l.trim(); })
      .filter(function (l) { return l && l.charAt(0) !== "[" && l.charAt(0) !== "("; })[0];
    if (sung) return sung.replace(/[,.!?;:]+$/, "").slice(0, 48);
    var style = $("style").value.trim().split(/[,\n]/)[0];
    return style ? style.slice(0, 48) : "Untitled";
  }

  // One request for a full render or a score-only plan, in the server's own
  // field names. Blank seeds stay out, and the server rolls them.
  function buildRequest(plan, instrumental) {
    var cot = currentCot();
    var abc = $("abc").value.trim();
    // an instrumental picks its own mode from the score
    if (abc && cot === "off" && !instrumental) throw new Error("Direct mode ignores a supplied score — pick full or melody");
    var style = $("style").value.trim(), lyrics = $("lyrics").value;
    if (!style && !lyrics.trim() && !STATE.codes) throw new Error("Write a style prompt or lyrics first");
    var body = { title: songTitle(), style: style, lyrics: lyrics, cot: cot };
    if (abc) body.abc = abc;
    var lm = readSeed("lmSeed", "Music seed"), sound = readSeed("soundSeed", "Sound seed");
    if (lm !== null) body.lm_seed = lm;
    if (sound !== null) body.seed = sound;
    var cfgRaw = $("cfg").value.trim();
    // the mode default goes out as nothing, exactly as a blank field did
    if (cfgRaw !== "" && parseFloat(cfgRaw) !== defaultCfg(cot)) {
      var cfg = parseFloat(cfgRaw);
      if (!isFinite(cfg) || cfg < 0) throw new Error("Guidance must be a number, 0 or more");
      body.cfg_scale = cfg;
    }
    var abcSampling = samplingOverrides("abc"), semanticSampling = samplingOverrides("semantic");
    if (Object.keys(abcSampling).length) body.abc_sampling = abcSampling;
    if (Object.keys(semanticSampling).length) body.semantic_sampling = semanticSampling;
    body.vae = selectedVae();
    if (STATE.sliderChoice.length) {
      body.sliders = STATE.sliderChoice.map(function (c) { return { id: c.id, strength: c.strength }; });
    }
    var loras = YueLoras.value();
    if (loras.length) {
      body.loras = loras;
    }
    var out = readOutput();
    Object.keys(out).forEach(function (key) { body[key] = out[key]; });
    if (plan) {
      body.plan_only = true;
    } else if (STATE.codes) {
      body.semantic_tokens = STATE.codes.tokens;
      if (STATE.codes.from) body.parent = STATE.codes.from;
    }
    return body;
  }

  function paintSubmitNote() {
    var live = STATE.jobs.filter(function (j) { return isLive(j) && j.kind !== "transcribe"; });
    var note;
    if (!STATE.online) note = "The server is not answering; runs cannot start.";
    else if (live.length) note = "A run is in progress; the next song is queued behind it.";
    else if (STATE.codes) note = "Codes loaded: Generate renders that music again, in seconds.";
    else if (STATE.hardware && STATE.hardware.loaded_modules > 0) note = "Model is resident — generation starts immediately.";
    else if (STATE.settings && STATE.settings.keep_loaded) note = "Model loads on the first run and stays resident.";
    else note = "Models load stage by stage and leave GPU memory after each run. Up to " + STATE.maxBatch +
      (STATE.maxBatch === 1 ? " song" : " songs") + " per pass.";
    $("submitNote").textContent = note;
  }

  /* ----------------------------------------------------------- instrumental */
  // The official recipe (instrumental.js): the score's vocal notes move to the
  // instrument voice, the lyrics become the section tags alone, the style gains
  // "Instrumental ... no vocals", and the mode follows the score (chords: full).
  function instrumentalBody(body) {
    var result = YueInstrumental.convert(body.abc);
    $("abc").value = result.abc;
    var cot = YueInstrumental.mode(result.abc);
    var out = Object.assign({}, body, { abc: result.abc, cot: cot, style: YueInstrumental.style(body.style),
      lyrics: YueInstrumental.lyricTags(result.abc) });
    if (out.cfg_scale !== undefined && out.cfg_scale === defaultCfg(cot)) delete out.cfg_scale;
    return { body: out, check: result.check,
      note: result.check.vocalNotes + " vocal notes moved to the instrument, " + (cot === "full" ? "Full plan" : "Melody only") + " mode" };
  }

  // No score yet: plan one (the form's lyrics, or a bare section skeleton), then convert and render it.
  function planForInstrumental(body, versions) {
    if (!body.style) return toast("A style prompt is required", "bad");
    var plan = Object.assign({}, body, { plan_only: true, cot: body.cot === "off" ? "full" : body.cot,
      lyrics: body.lyrics.trim() ? body.lyrics : YueInstrumental.planningLyrics });
    $("generateBtn").disabled = true;
    submitJob(plan, { kind: "plan", title: plan.title }).then(function (job) {
      STATE.instrumentalPlan = { job: job.id, versions: versions, body: body };
      watchJob(job);
      show("take");
      toast("Instrumental: planning the score first, then the vocal line moves to the instrument and it renders");
    }).catch(function (error) { toast(error.message, "bad"); })
      .then(function () { $("generateBtn").disabled = false; });
  }

  function instrumentalAfterPlan(job, abc) {
    var pending = STATE.instrumentalPlan;
    if (!pending || pending.job !== job.id) return false;
    STATE.instrumentalPlan = null;
    var seed = job.resolved.lm_seed || job.request.lm_seed, made;
    try {
      made = instrumentalBody(Object.assign({}, pending.body, { abc: abc }, seed && /^\d+$/.test(String(seed)) ? { lm_seed: String(seed) } : {}));
    } catch (error) {
      toast("The planned score could not be made instrumental: " + error.message, "bad");
      return true;
    }
    toast("Score planned; " + made.note + ". Rendering the instrumental.", "good");
    queueVersions(made.body, pending.versions);
    return true;
  }

  $("abcInstrumental").addEventListener("click", function () {
    var abc = $("abc").value.trim();
    if (!abc) return toast("Plan or paste a score first; this moves its vocal melody to the instrument", "bad");
    try {
      var result = YueInstrumental.convert(abc);
      $("abc").value = result.abc;
      $("instrumental").checked = true;
      toast(result.check.vocalNotes + " vocal notes moved to the instrument; Instrumental is on for Generate", "good");
    } catch (error) {
      toast("Cannot convert this score: " + error.message, "bad");
    }
  });

  $("composeForm").addEventListener("submit", function (event) {
    event.preventDefault();
    var body, instrumental = $("instrumental").checked;
    try { body = buildRequest(false, instrumental); } catch (error) { return toast(error.message, "bad"); }
    var versions = Math.max(1, Math.min(10, parseInt($("versions").value, 10) || 1));
    if (instrumental) {
      if (body.semantic_tokens) return toast("Loaded codes already fix the music; clear them to make an instrumental", "bad");
      if (!body.abc) return planForInstrumental(body, versions);
      try {
        var made = instrumentalBody(body);
        body = made.body;
        toast("Instrumental: " + made.note);
      } catch (error) {
        return toast("Cannot make this score instrumental: " + error.message, "bad");
      }
    }
    queueVersions(body, versions);
  });

  function queueVersions(body, versions) {
    if (body.semantic_tokens && versions > 1) {
      versions = 1;
      toast("Loaded codes render one song; use Sound variations for more takes of it");
    }
    var batch = Math.min(versions, Math.max(1, STATE.maxBatch)), passes = Math.ceil(versions / batch);
    var group = "g" + Date.now(), baseTitle = body.title, first = null, chain = Promise.resolve();
    var variations = body.synth_batch_size || 1;
    $("generateBtn").disabled = true;
    for (var i = 0; i < passes; i++) {
      (function (index) {
        chain = chain.then(function () {
          var each = Object.assign({}, body);
          var count = Math.min(batch, versions - index * batch);
          if (count > 1) each.lm_batch_size = count;
          // every pass continues the music seeds where the last one stopped
          if (body.lm_seed !== undefined && index > 0) each.lm_seed = (BigInt(body.lm_seed) + BigInt(index * batch)).toString();
          return submitJob(each, {
            kind: "song", title: baseTitle, group: group, index: index * batch, count: count,
            versioned: versions > 1, variations: variations, baseTitle: baseTitle
          }).then(function (job) {
            if (!first) { first = job; watchJob(job); show("take"); }
          });
        });
      })(i);
    }
    chain.then(function () {
      toast(versions > 1
        ? "Queued " + versions + " versions of " + baseTitle + (passes > 1 ? " in " + passes + " passes of up to " + batch : "")
        : "Queued: " + baseTitle);
    }).catch(function (error) {
      toast(error.message, "bad");
    }).then(function () {
      // Runs queue server-side, so the button only stays down for the requests
      // themselves. It must never depend on a later event to come back to life.
      $("generateBtn").disabled = false;
    });
  }

  $("planBtn").addEventListener("click", function () {
    var body;
    try { body = buildRequest(true); } catch (error) { return toast(error.message, "bad"); }
    if (body.cot === "off") return toast("Planning writes a score: choose Full plan or Melody only", "bad");
    if (body.abc) return toast("A score is already supplied — remove it (Supply your own score) to plan a new one", "bad");
    if (!body.style || !body.lyrics.trim()) return toast("A style prompt and lyrics are both required", "bad");
    var button = this;
    button.disabled = true;
    submitJob(body, { kind: "plan", title: body.title }).then(function (job) {
      watchJob(job);
      show("take");
      toast("Planning the score for " + job.title);
    }).catch(function (error) { toast(error.message, "bad"); })
      .then(function () { button.disabled = false; });
  });

  /* ------------------------------------------------- prompt files (open/save) */

  function seedText(value) {
    var text = value === undefined || value === null ? "" : String(value).trim();
    return /^\d+$/.test(text) ? text : "";
  }

  // Fill the form from a request (a saved prompt, or a take's replay request).
  function loadRequestIntoForm(req, opts) {
    opts = opts || {};
    $("title").value = opts.title !== undefined ? opts.title : String(req.title || "");
    $("style").value = String(req.style || "");
    $("lyrics").value = String(req.lyrics || "");
    $("abc").value = String(req.abc || "");
    if (req.abc) $("scoreDrawer").open = true;
    $("lmSeed").value = seedText(req.lm_seed);
    $("soundSeed").value = seedText(req.seed);
    paintDice();
    var cot = MODES[req.cot] ? req.cot : "full";
    document.querySelector('input[name="cot"][value="' + cot + '"]').checked = true;
    if (typeof req.cfg_scale === "number" && req.cfg_scale >= 0 && round(req.cfg_scale, 4) !== defaultCfg(cot)) {
      $("cfg").value = round(req.cfg_scale, 4);
      $("cfg").dataset.touched = "1";
    } else {
      $("cfg").dataset.touched = "";
    }
    fillCfg();
    ["abc", "semantic"].forEach(function (group) {
      var preset = req[group + "_sampling"] || {};
      all('input[data-group="' + group + '"]').forEach(function (input) {
        var value = preset[input.dataset.key];
        input.value = typeof value === "number" && isFinite(value) ? round(value, 6) : round(samplingDefault(group, input.dataset.key), 6);
      });
    });
    if (req.vae && vaeInfo(req.vae)) { checkVae(req.vae); store("yue2.vae", req.vae); }
    var known = sliderLabels();
    STATE.sliderChoice = (Array.isArray(req.sliders) ? req.sliders : []).filter(function (c) {
      return c && known[c.id] !== undefined;
    }).map(function (c) {
      var strength = typeof c.strength === "number" ? c.strength : 1;
      return { id: String(c.id), strength: round(Math.min(1, Math.max(0, strength)), 2) };
    });
    YueLoras.set(Array.isArray(req.loras) ? req.loras : []);
    if (typeof req.steps === "number") $("odeSteps").value = req.steps;
    if (typeof req.duration === "number") $("maxLength").value = round(req.duration, 3);
    $("variations").value = typeof req.synth_batch_size === "number" ? Math.max(1, Math.min(9, req.synth_batch_size)) : 1;
    if (FORMAT_LABELS[req.output_format]) $("outFormat").value = req.output_format;
    if (typeof req.mp3_bitrate === "number" && $("mp3Bitrate").querySelector('option[value="' + req.mp3_bitrate + '"]')) {
      $("mp3Bitrate").value = String(req.mp3_bitrate);
    }
    if (typeof req.peak_clip === "number") $("peakClip").value = req.peak_clip;
    $("versions").value = typeof req.lm_batch_size === "number" ? Math.max(1, Math.min(10, req.lm_batch_size)) : 1;
    var tokens = typeof req.semantic_tokens === "string" ? req.semantic_tokens.trim() : "";
    setCodes(tokens ? { tokens: tokens, from: opts.fromTake || null, title: opts.codesTitle || $("title").value,
                        frames: countCodes(tokens) } : null);
    syncShape();
    paintOutput();
    growLyrics();
  }

  $("openPrompt").addEventListener("click", function () { $("openFile").click(); });

  $("openFile").addEventListener("change", function () {
    var file = this.files[0];
    this.value = "";
    if (!file) return;
    var ext = (file.name.split(".").pop() || "").toLowerCase();
    file.text().then(function (text) {
      var req = ext === "json" ? parseJSON(text) : parseYAML(text);
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("not a prompt");
      loadRequestIntoForm(req, { title: String(req.title || file.name.replace(/\.(json|ya?ml)$/i, "")),
                                 codesTitle: file.name });
      toast("Prompt loaded from " + file.name, "good");
    }).catch(function (error) {
      toast("Could not read " + file.name + " as a prompt (" + error.message + ")", "bad");
    });
  });

  $("saveMenu").addEventListener("click", function (event) {
    var button = event.target.closest("[data-save]");
    if (!button) return;
    closeMenus();
    var body;
    try { body = buildRequest(false); } catch (error) { return toast(error.message, "bad"); }
    var versions = Math.max(1, Math.min(STATE.maxBatch, parseInt($("versions").value, 10) || 1));
    if (versions > 1 && !body.semantic_tokens) body.lm_batch_size = versions;
    var name = slug(body.title);
    if (button.dataset.save === "json") downloadText(name + ".json", toJSON(body, 2) + "\n", "application/json");
    else downloadText(name + ".yaml", toYAML(body), "application/x-yaml");
  });

  /* ------------------------------------------------------ YAML, small subset */
  // Enough YAML for request files: maps, lists, block text, plain and quoted
  // scalars. Written the same way it is read. Long integers stay digit strings.

  function yamlScalar(value, key) {
    if (value === null || value === undefined) return "null";
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    var text = String(value);
    if ((key === "lm_seed" || key === "seed") && /^-?\d+$/.test(text)) return text;   // an integer, however long
    if (/^[A-Za-z_][\w .\/+-]*$/.test(text) && !/^(true|false|null|yes|no|on|off|~)$/i.test(text) &&
        !/\s$/.test(text) && !/: |\s#/.test(text)) return text;
    return JSON.stringify(text);
  }

  function toYAML(obj, indent) {
    indent = indent || "";
    var out = "";
    Object.keys(obj).forEach(function (key) {
      var value = obj[key];
      if (value === undefined) return;
      if (Array.isArray(value)) {
        if (!value.length) { out += indent + key + ": []\n"; return; }
        out += indent + key + ":\n";
        value.forEach(function (item) {
          if (item && typeof item === "object") {
            var inner = toYAML(item, indent + "    ");
            out += indent + "  - " + inner.slice(indent.length + 4);
          } else {
            out += indent + "  - " + yamlScalar(item) + "\n";
          }
        });
      } else if (value && typeof value === "object") {
        out += indent + key + ":\n" + toYAML(value, indent + "  ");
      } else if (typeof value === "string" && value.indexOf("\n") >= 0 && /^\S/.test(value) &&
                 !/\r/.test(value) && !/\n\n$/.test(value) && !/[ \t]\n/.test(value)) {
        var keep = /\n$/.test(value);
        out += indent + key + ": |" + (keep ? "" : "-") + "\n" +
          value.replace(/\n$/, "").split("\n").map(function (line) { return line ? indent + "  " + line : ""; }).join("\n") + "\n";
      } else {
        out += indent + key + ": " + yamlScalar(value, key) + "\n";
      }
    });
    return out;
  }

  function parseYAML(text) {
    var lines = String(text).replace(/\r\n?/g, "\n").split("\n"), i = 0;
    var indentOf = function (line) { return line.match(/^ */)[0].length; };
    var blank = function (line) { return /^\s*(#.*)?$/.test(line); };
    var skip = function () { while (i < lines.length && blank(lines[i])) i++; };

    function scalar(raw) {
      var text = raw.trim();
      if (text.charAt(0) === '"') return JSON.parse(text.replace(/\s+#.*$/, "").trim());
      if (text.charAt(0) === "'") return text.replace(/\s+#.*$/, "").trim().slice(1, -1).replace(/''/g, "'");
      text = text.replace(/\s+#.*$/, "");
      if (text === "" || text === "~" || text === "null") return null;
      if (text === "true") return true;
      if (text === "false") return false;
      if (/^-?\d+$/.test(text)) return text.replace("-", "").length > 15 ? text : Number(text);
      if (/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return Number(text);
      if (/^[\[{]/.test(text)) { try { return JSON.parse(text); } catch (error) { return text; } }
      return text;
    }

    function block(parentIndent, style) {
      var chomp = /-/.test(style) ? "strip" : (/\+/.test(style) ? "keep" : "clip");
      var folded = style.charAt(0) === ">", body = [], width = null;
      while (i < lines.length) {
        var line = lines[i];
        if (line.trim() === "") { body.push(""); i++; continue; }
        var ind = indentOf(line);
        if (ind <= parentIndent) break;
        if (width === null) width = ind;
        body.push(line.slice(Math.min(width, ind)));
        i++;
      }
      var trailing = 0;
      while (body.length && body[body.length - 1] === "") { body.pop(); trailing++; }
      var textOut;
      if (folded) {
        textOut = body.reduce(function (acc, line, n) {
          if (n === 0) return line;
          if (line === "") return acc + "\n";
          return acc + (/\n$/.test(acc) ? "" : " ") + line;
        }, "");
      } else {
        textOut = body.join("\n");
      }
      if (chomp === "clip" && body.length) textOut += "\n";
      if (chomp === "keep") textOut += "\n" + new Array(trailing + 1).join("\n");
      return textOut;
    }

    function value(rest, ownIndent) {
      rest = rest === undefined ? "" : rest;
      var trimmed = rest.trim();
      if (/^[|>][-+0-9]*\s*(#.*)?$/.test(trimmed)) { i++; return block(ownIndent, trimmed.split(/\s/)[0]); }
      if (trimmed === "" || /^#/.test(trimmed)) {
        i++;
        skip();
        if (i >= lines.length) return null;
        var next = lines[i], ind = indentOf(next);
        if (ind > ownIndent) return node(ind);
        if (ind === ownIndent && /^-(\s|$)/.test(next.slice(ind))) return list(ind);
        return null;
      }
      i++;
      return scalar(trimmed);
    }

    function map(indent) {
      var obj = {};
      for (;;) {
        skip();
        if (i >= lines.length) break;
        var line = lines[i], ind = indentOf(line);
        if (ind < indent) break;
        if (ind > indent) throw new Error("unexpected indentation on line " + (i + 1));
        var m = line.slice(ind).match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:#'"][^:#]*?)\s*:(?:\s+(.*)|\s*)$/);
        if (!m) break;
        var key = m[1].charAt(0) === '"' ? JSON.parse(m[1]) : (m[1].charAt(0) === "'" ? m[1].slice(1, -1) : m[1]);
        obj[key] = value(m[2], ind);
      }
      return obj;
    }

    function list(indent) {
      var arr = [];
      for (;;) {
        skip();
        if (i >= lines.length) break;
        var line = lines[i], ind = indentOf(line);
        if (ind !== indent || !/^-(\s|$)/.test(line.slice(ind))) break;
        var rest = line.slice(ind + 1).replace(/^\s+/, "");
        var inner = ind + 1 + (line.slice(ind + 1).length - rest.length);
        if (!rest) { arr.push(value("", ind)); continue; }
        if (/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:#'"\[{][^:#]*?)\s*:(\s|$)/.test(rest)) {
          lines[i] = new Array(inner + 1).join(" ") + rest;   // a map item: read it in place
          arr.push(map(inner));
        } else {
          arr.push(value(rest, ind));
        }
      }
      return arr;
    }

    function node(indent) {
      skip();
      if (i >= lines.length) return null;
      return /^-(\s|$)/.test(lines[i].slice(indentOf(lines[i]))) ? list(indent) : map(indent);
    }

    skip();
    if (i < lines.length && /^---/.test(lines[i])) i++;
    skip();
    var result = node(i < lines.length ? indentOf(lines[i]) : 0);
    skip();
    if (i < lines.length && !/^(---|\.\.\.)/.test(lines[i])) throw new Error("could not read line " + (i + 1));
    return result;
  }

  /* ------------------------------------------------------------------ jobs */
  /* The server queues runs and answers /job?id= for their state. Progress
     comes from its log stream: each run starts with a "[Server] Job <id>" line
     and every later line belongs to it until the next one. */

  var JOB_KEY = "yue2.jobs";

  function jobById(id) { return STATE.jobs.filter(function (j) { return j.id === id; })[0] || null; }
  function isLive(job) { return job && (job.status === "queued" || job.status === "running" || job.status === "saving"); }

  function stageSkeleton(job) {
    var r = job.request, cot = r.cot || "full";
    var scoreNote = cot === "melody" ? "Melody only, written as ABC" : "Melody and chords, written as ABC";
    var stages = [
      { key: "score", label: "Score", note: scoreNote },
      { key: "tokens", label: "Music tokens", note: "25 per second of music" + (r.songs > 1 ? " · " + r.songs + " songs side by side" : "") },
      { key: "sound", label: "Sound", note: "Flow matching, " + r.steps + " steps" + (r.variations > 1 ? " · " + r.variations + " variations" : "") },
      { key: "decode", label: "Decode", note: "VAE: " + vaeLabel(r.vae || STATE.defaultVae) }
    ];
    stages.forEach(function (s) { s.state = "waiting"; s.done = 0; s.total = 0; s.skipNote = ""; });
    var skip = function (key, note) {
      stages.forEach(function (s) { if (s.key === key) { s.state = "skipped"; s.skipNote = note; } });
    };
    if (r.replay) { skip("score", "Codes supplied: the music is already written"); skip("tokens", "Codes supplied"); }
    else if (cot === "off") skip("score", "Direct mode writes no score");
    else if (r.hasAbc) skip("score", "Supplied score");
    if (r.plan) { skip("tokens", "Plan only: no music"); skip("sound", "Plan only: no audio"); skip("decode", "Plan only: no audio"); }
    return stages;
  }

  function summarize(body) {
    return {
      cot: body.cot || outDefault("cot") || "full",
      hasAbc: !!(body.abc && String(body.abc).trim()),
      replay: !!(body.semantic_tokens && String(body.semantic_tokens).trim()),
      plan: !!body.plan_only,
      steps: body.steps || outDefault("steps"),
      songs: body.lm_batch_size || 1,
      variations: body.synth_batch_size || 1,
      vae: body.vae || STATE.defaultVae,
      format: body.output_format || outDefault("output_format"),
      sliders: body.sliders || [],
      lm_seed: body.lm_seed !== undefined ? String(body.lm_seed) : null,
      seed: body.seed !== undefined ? String(body.seed) : null,
      title: body.title || ""
    };
  }

  function makeJob(id, meta, body) {
    var job = {
      id: id, kind: meta.kind, title: meta.title || body.title || "Untitled", group: meta.group || null,
      index: meta.index || 0, count: meta.count || 1, versioned: !!meta.versioned, baseTitle: meta.baseTitle || null,
      variations: meta.variations || body.synth_batch_size || 1, parent: meta.parent || null, what: meta.what || "",
      task: meta.task || null, fileName: meta.fileName || null,
      request: summarize(body), status: "queued", submitted: Date.now(), started: 0, finished: 0,
      takes: [], saved: [], error: "", resolved: {}, notes: {}
    };
    job.stages = stageSkeleton(job);
    return job;
  }

  // A job line can arrive before the POST that queued it has answered; the
  // record the log made then becomes this page's own.
  function registerJob(id, meta, body) {
    var job = jobById(id), fresh = makeJob(id, meta, body);
    if (job) {
      ["kind", "title", "group", "index", "count", "versioned", "baseTitle", "variations", "parent", "what", "task", "fileName"]
        .forEach(function (key) { job[key] = fresh[key]; });
      job.request = fresh.request;
      job.submitted = fresh.submitted;
      job.provisional = false;
      var progress = job.stages;
      job.stages = stageSkeleton(job);
      job.stages.forEach(function (s, n) { if (s.state !== "skipped" && progress[n]) Object.assign(s, progress[n], { note: s.note }); });
    } else {
      job = fresh;
      STATE.jobs.push(job);
    }
    saveJobs();
    ensurePolling();
    return job;
  }

  function submitJob(body, meta) {
    return post("/synth", body).then(function (data) {
      var job = registerJob(data.id, meta, body);
      paintAllRuns();
      return job;
    });
  }

  function saveJobs() {
    // Finished runs are only history; keep the newest few in memory.
    var settled = STATE.jobs.filter(function (j) { return !isLive(j) && j !== STATE.job; });
    if (settled.length > 40) {
      var drop = settled.slice(0, settled.length - 40);
      STATE.jobs = STATE.jobs.filter(function (j) { return drop.indexOf(j) < 0; });
    }
    var keep = STATE.jobs.filter(function (j) { return isLive(j) && !j.provisional && j.kind !== "external"; }).map(function (j) {
      return { id: j.id, kind: j.kind, title: j.title, group: j.group, index: j.index, count: j.count, versioned: j.versioned,
               baseTitle: j.baseTitle, variations: j.variations, parent: j.parent, what: j.what, task: j.task,
               fileName: j.fileName, request: j.request, submitted: j.submitted };
    });
    store(JOB_KEY, keep.length ? JSON.stringify(keep) : null);
  }

  // After a reload, pick up the runs this browser had queued.
  function restoreJobs() {
    var saved = [];
    try { saved = JSON.parse(recall(JOB_KEY) || "[]"); } catch (error) { saved = []; }
    saved.forEach(function (s) {
      if (jobById(s.id)) return;
      var job = {
        id: s.id, kind: s.kind, title: s.title, group: s.group, index: s.index || 0, count: s.count || 1,
        versioned: !!s.versioned, baseTitle: s.baseTitle, variations: s.variations || 1, parent: s.parent, what: s.what || "",
        task: s.task, fileName: s.fileName, request: s.request, status: "queued", submitted: s.submitted || Date.now(),
        started: 0, finished: 0, takes: [], saved: [], error: "", resolved: {}, notes: {}, restored: true
      };
      job.stages = stageSkeleton(job);
      STATE.jobs.push(job);
    });
    if (saved.length) ensurePolling();
  }

  var pollTimer = null;
  function ensurePolling() {
    if (!pollTimer) pollTimer = setInterval(pollJobs, 1000);
    pollJobs();
  }

  function pollJobs() {
    var open = STATE.jobs.filter(function (j) { return isLive(j) && !j.provisional; });
    if (!open.length) { clearInterval(pollTimer); pollTimer = null; return; }
    open.forEach(function (job) {
      if (job.polling) return;
      job.polling = true;
      api("/job?id=" + encodeURIComponent(job.id)).then(function (data) {
        job.polling = false;
        applyStatus(job, data || {});
      }).catch(function (error) {
        job.polling = false;
        if (error.status === 404) failJob(job, "The server no longer knows this run: it was restarted, or the run was dropped from its memory.");
      });
    });
  }

  function applyStatus(job, data) {
    var status = data.status;
    // Synth jobs report the seeds the server resolved, from the moment they are queued.
    if (data.lm_seed !== undefined && data.lm_seed !== null) {
      STATE.statusKnowsQueue = true;
      job.resolved.lm_seed = String(data.lm_seed);
      if (data.seed !== undefined && data.seed !== null) job.resolved.seed = String(data.seed);
    }
    if (status === "queued") {
      STATE.statusKnowsQueue = true;
      paintAllRuns();
      return;
    }
    if (status === "running") {
      // A server that reports "queued" means "running" literally; an older one says
      // "running" for both, and then only the log line tells them apart.
      if (job.status === "queued" && (STATE.statusKnowsQueue || !LOG.connected)) {
        job.status = "running";
        job.started = job.started || Date.now();
        paintAllRuns();
      }
      if (job.restored && !job.rewatched && !STATE.job && !STATE.take && job.kind !== "transcribe" && job.kind !== "replay") {
        job.rewatched = true;
        watchJob(job);
      }
      return;
    }
    if (status === "done") return finishJob(job, data);
    if (status === "failed") return failJob(job, data.error || job.lastFatal || "The run failed; the server log (Engine) has the reason.");
    if (status === "cancelled") return cancelledJob(job);
  }

  function settle(job, status) {
    setTimeout(refreshHardware, 300);
    job.status = status;
    job.finished = job.finished || Date.now();
    if (!job.started) job.started = job.finished;
    job.stages.forEach(function (s) {
      if (status === "done" && s.state !== "skipped") s.state = "completed";
      if (status !== "done" && s.state === "running") s.state = "failed";
    });
    saveJobs();
    paintAllRuns();
  }

  function failJob(job, message) {
    if (!isLive(job)) return;
    job.error = message;
    settle(job, "failed");
    toastOnce(job.id, message, "bad");
    if (job.kind === "transcribe") transcriptionFailed(job, message);
  }

  function cancelledJob(job) {
    if (!isLive(job)) return;
    job.error = "";
    settle(job, "cancelled");
    toastOnce(job.id, "Cancelled: " + job.title);
    if (job.kind === "transcribe") transcriptionFailed(job, "Transcription cancelled.");
  }

  function finishJob(job, data) {
    if (!isLive(job) || job.finishing) return;
    job.finishing = true;
    if (job.kind === "transcribe") { settle(job, "done"); return finishTranscription(job); }
    if (job.request.plan) { settle(job, "done"); return finishPlan(job, data); }
    var names = data.takes || [];
    var land = names.length || STATE.library ? Promise.resolve(names) : sessionTakes(job);
    land.then(function (takes) {
      job.takes = takes;
      settle(job, "done");
      return refreshLibrary().catch(function () {}).then(function () { return nameVersions(job); });
    }).then(function () {
      paintAllRuns();
      if (job.kind === "replay") return replayLanded(job);
      var count = job.takes.length;
      if (job.restored) return;
      var watching = STATE.job === job && !STATE.take && count, playing = isPlaying();
      toastOnce(job.id, "Song complete — " + job.title + (count > 1 ? " (" + count + " takes)" : "") +
                (watching && playing ? ". What you are playing keeps playing; ▶ Play this song when you are ready." : ""), "good");
      // Only jump to the new song if the run is what you were looking at;
      // opening it never cuts off a song that is playing.
      if (watching) openTake(job.takes[0]);
    }).catch(function (error) {
      job.error = error.message;
      settle(job, "failed");
      toast(error.message, "bad");
    });
  }

  // Versions and sound variations get titles of their own ("· v2", "· sound 3"),
  // written into the library so every page sees the same names.
  function nameVersions(job) {
    if (job.kind !== "song" || (!job.versioned && job.variations < 2)) return Promise.resolve();
    var chain = Promise.resolve();
    job.takes.forEach(function (name) {
      var take = findTake(name);
      if (!take) return;
      var title = job.baseTitle || job.title;
      if (job.versioned) title += " · v" + (job.index + (take.song || 0) + 1);
      if (job.variations > 1) title += " · sound " + ((take.variation || 0) + 1);
      if (take.title === title) return;
      chain = chain.then(function () { return updateTake(take, { title: title }).catch(function () {}); });
    });
    return chain;
  }

  function finishPlan(job, data) {
    var got = data.abc ? Promise.resolve(data.abc)
      : api("/job?id=" + encodeURIComponent(job.id) + "&result=1").then(function (r) { return (r && r.abc) || ""; });
    got.then(function (abc) {
      job.abc = abc;
      if (job.restored) return;
      if (!abc) return toast("The plan finished without a score", "bad");
      if (!toasted["plan" + job.id]) {
        toasted["plan" + job.id] = true;
        if (instrumentalAfterPlan(job, abc)) return;
        $("abc").value = abc;
        var seed = job.resolved.lm_seed || job.request.lm_seed;
        if (seed && /^\d+$/.test(String(seed))) { $("lmSeed").value = String(seed); paintDice(); }
        $("scoreDrawer").open = true;
        toast("Score planned. Check its sections under Supply your own score; Generate now renders exactly this score.", "good");
      }
      if (STATE.job === job && !STATE.take) showPlanScore(job);
    }).catch(function (error) { toast("Could not fetch the planned score: " + error.message, "bad"); });
  }

  // The plan's score stands in the take column under the finished run.
  function showPlanScore(job) {
    if (!job.abc) return;
    $("takeEmpty").classList.add("is-hidden");
    $("takeBody").classList.remove("is-hidden");
    $("takeBody").classList.add("is-running");
    $("scorePanel").classList.remove("is-hidden");
    $("scorePanel").open = true;
    renderScore(job.abc);
  }

  function replayLanded(job) {
    var name = job.takes[0];
    toastOnce(job.id, (job.what || "New version") + " ready — " + job.title, "good");
    // Only switch if you are still listening to the take it came from.
    if (name && STATE.take && STATE.take.name === job.parent && !isPlaying()) openTake(name, { keep: true });
    else if (STATE.take) { paintDecodeSwitch(); paintSoundSwitch(); }
  }

  // With no library on the server, the finished songs are fetched once and
  // kept in this tab: audio and replay request, for as long as it stays open.
  function sessionTakes(job) {
    return fetch("/job?id=" + encodeURIComponent(job.id) + "&result=1").then(function (r) {
      if (!r.ok) throw new Error("Could not fetch the finished song (" + r.status + ")");
      var type = r.headers.get("Content-Type") || "";
      return r.arrayBuffer().then(function (buffer) { return { type: type, buffer: buffer }; });
    }).then(function (res) {
      var match = res.type.match(/boundary=([^\s;]+)/), pairs = [];
      if (match) {
        var pending = null;
        splitMultipart(new Uint8Array(res.buffer), match[1].replace(/"/g, "")).forEach(function (part) {
          if (/json/.test(part.type)) pending = parseJSON(new TextDecoder().decode(part.body));
          else if (pending) { pairs.push({ request: pending, audio: new Blob([part.body], { type: part.type }) }); pending = null; }
        });
      } else {
        pairs.push({ request: {}, audio: new Blob([res.buffer], { type: res.type || "audio/mpeg" }) });
      }
      var now = Date.now() / 1000, variations = job.request.variations || 1;
      return pairs.map(function (pair, n) {
        var req = pair.request, name = "session-" + job.id + "-" + (n + 1);
        STATE.requests[name] = req;
        var take = {
          name: name, session: true, url: URL.createObjectURL(pair.audio), title: req.title || job.title, created: now,
          seconds: 0, format: req.output_format || job.request.format, favorite: false, style: req.style || "",
          lyrics: req.lyrics || "", cot: req.cot || job.request.cot, lm_seed: req.lm_seed, seed: req.seed,
          vae: req.vae || job.request.vae, sliders: req.sliders || [], steps: req.steps || job.request.steps,
          cfg_scale: typeof req.cfg_scale === "number" ? req.cfg_scale : -1, duration: req.duration,
          truncated: false, render_seconds: job.finished ? (job.finished - job.started) / 1000 : 0,
          song: Math.floor(n / variations), variation: n % variations, parent: req.parent || "", has_score: !!req.abc
        };
        STATE.session.unshift(take);
        return name;
      });
    });
  }

  function splitMultipart(bytes, boundary) {
    var marker = new TextEncoder().encode("--" + boundary), parts = [], positions = [];
    for (var i = 0; i <= bytes.length - marker.length; i++) {
      var hit = true;
      for (var j = 0; j < marker.length; j++) { if (bytes[i + j] !== marker[j]) { hit = false; break; } }
      if (hit) { positions.push(i); i += marker.length - 1; }
    }
    for (var p = 0; p < positions.length - 1; p++) {
      var start = positions[p] + marker.length + 2, end = positions[p + 1] - 2, split = -1;
      for (var k = start; k < end - 3; k++) {
        if (bytes[k] === 13 && bytes[k + 1] === 10 && bytes[k + 2] === 13 && bytes[k + 3] === 10) { split = k; break; }
      }
      if (split < 0) continue;
      var head = new TextDecoder().decode(bytes.slice(start, split)), type = "application/octet-stream";
      head.split(/\r\n/).forEach(function (line) { var m = line.match(/^Content-Type:\s*(.+)$/i); if (m) type = m[1].trim(); });
      parts.push({ type: type, body: bytes.slice(split + 4, end) });
    }
    return parts;
  }

  /* ------------------------------------------------------------ log stream */

  var LOG = { source: null, connected: false, lines: [], pending: [], active: null, capture: null,
              backlog: true, backlogTimer: 0, lastJobId: null, retry: 0 };
  var LOG_KEEP = 400, LOG_WIDTH = 320;

  function connectLogs() {
    if (LOG.source) LOG.source.close();
    var source = new EventSource("/logs");
    LOG.source = source;
    source.onopen = function () {
      LOG.connected = true;
      LOG.backlog = true;
      LOG.active = null;
      LOG.capture = null;
      LOG.lines = [];
      LOG.pending = [];
      $("logBody").textContent = "";
      // The stream replays its backlog first, so progress is rebuilt from it.
      STATE.jobs.forEach(function (job) {
        if (!isLive(job)) return;
        var fresh = stageSkeleton(job);
        job.stages.forEach(function (s, n) { if (s.state !== "skipped") Object.assign(s, fresh[n]); });
      });
      clearTimeout(LOG.backlogTimer);
      LOG.backlogTimer = setTimeout(endBacklog, 900);
      paintLogState();
    };
    source.onmessage = function (event) { onLogLine(event.data); };
    source.onerror = function () {
      source.close();
      if (LOG.source !== source) return;
      LOG.source = null;
      LOG.connected = false;
      addLogLine("[Client] Server unavailable", true);
      paintLogState();
      clearTimeout(LOG.retry);
      LOG.retry = setTimeout(connectLogs, 2000);
    };
  }

  function paintLogState() {
    var pill = $("logState");
    pill.textContent = LOG.connected ? "live" : "reconnecting";
    pill.dataset.s = LOG.connected ? "ready" : "bad";
  }

  // A run found still going when the backlog ends is shown as if started here.
  function endBacklog() {
    LOG.backlog = false;
    var id = LOG.lastJobId, job = id ? jobById(id) : null;
    if (!job || !job.provisional) return;
    api("/job?id=" + encodeURIComponent(id)).then(function (data) {
      if (data && data.status === "running" && job.provisional) promoteExternal(job);
      else dropProvisional(job);
    }).catch(function () { dropProvisional(job); });
  }

  function dropProvisional(job) {
    if (!job.provisional) return;
    STATE.jobs = STATE.jobs.filter(function (j) { return j !== job; });
  }

  function promoteExternal(job) {
    if (!job.provisional) return;
    job.provisional = false;
    job.kind = job.request.plan ? "plan" : "external";
    job.status = job.status === "queued" ? "running" : job.status;
    ensurePolling();
    if (!STATE.job && !STATE.take) watchJob(job);
    paintAllRuns();
  }

  function onLogLine(text) {
    addLogLine(text, false);
    if (LOG.backlog) { clearTimeout(LOG.backlogTimer); LOG.backlogTimer = setTimeout(endBacklog, 250); }
    // The request after a job line is printed over many lines; collect it.
    if (LOG.capture) {
      if (/^(\s|\}|\])/.test(text)) {
        LOG.capture.text += "\n" + text;
        if (text === "}") finishCapture();
        return;
      }
      finishCapture();
    }
    var m;
    if ((m = text.match(/^\[Server\] Transcribe job (\S+) failed: (.*)$/))) {
      var failed = jobById(m[1]);
      if (failed) { failed.lastFatal = m[2]; }
      return;
    }
    if ((m = text.match(/^\[Server\] Job (\S+): (.*)$/))) return jobLine(m[1], m[2], false);
    if ((m = text.match(/^\[Server\] Transcribe job (\S+): (.*)$/))) return jobLine(m[1], "", true);
    var job = LOG.active ? jobById(LOG.active) : null;
    if (job) progressLine(job, text);
  }

  function jobLine(id, rest, transcribe) {
    LOG.active = id;
    LOG.lastJobId = id;
    var job = jobById(id);
    if (!job) {
      // Someone else's run, or ours before its POST has answered: keep a
      // quiet record and decide what it is in a moment.
      job = makeJob(id, { kind: transcribe ? "transcribe" : "external", title: "A run from elsewhere" }, {});
      job.provisional = true;
      STATE.jobs = STATE.jobs.filter(function (j) { return !(j.provisional && j !== job && !isLiveVisible(j)); });
      STATE.jobs.push(job);
      if (!LOG.backlog && !transcribe) {
        setTimeout(function () { if (job.provisional) promoteExternal(job); }, 700);
      }
    }
    if (job.status === "queued") {
      job.status = "running";
      job.started = Date.now();
      job.approx = LOG.backlog;
    }
    var body = rest.trim();
    if (body === "{") LOG.capture = { id: id, text: "{" };
    else if (body.charAt(0) === "{") applyJobRequest(id, body);
    scheduleRunPaint();
  }

  function isLiveVisible(job) { return !job.provisional && isLive(job); }

  function finishCapture() {
    var capture = LOG.capture;
    LOG.capture = null;
    if (capture) applyJobRequest(capture.id, capture.text);
  }

  function applyJobRequest(id, text) {
    var job = jobById(id), req;
    if (!job) return;
    try { req = parseJSON(text); } catch (error) { return; }
    if (req.lm_seed !== undefined) job.resolved.lm_seed = String(req.lm_seed);
    if (req.seed !== undefined) job.resolved.seed = String(req.seed);
    if (job.provisional || job.kind === "external") {
      job.title = req.title || job.title;
      job.request = summarize(req);
      var progress = job.stages;
      job.stages = stageSkeleton(job);
      job.stages.forEach(function (s, n) { if (s.state !== "skipped" && progress[n] && progress[n].state !== "waiting") Object.assign(s, progress[n], { note: s.note }); });
    }
    scheduleRunPaint();
  }

  function stageOf(job, key) { return job.stages.filter(function (s) { return s.key === key; })[0]; }

  // Mark a stage running; any stage before it that was still running is done.
  function runStage(job, key) {
    var reached = false;
    job.stages.forEach(function (s) {
      if (s.key === key) {
        reached = true;
        if (s.state === "waiting" || s.state === "completed") { s.state = "running"; s.t0 = s.t0 || Date.now(); }
      } else if (!reached && s.state === "running") {
        s.state = "completed";
        s.t1 = s.t1 || Date.now();
      }
    });
    return stageOf(job, key);
  }

  function completeStage(job, key, seconds) {
    var s = stageOf(job, key);
    if (!s || s.state === "skipped") return;
    s.state = "completed";
    s.t1 = s.t1 || Date.now();
    if (seconds !== undefined) s.seconds = seconds;
  }

  function currentStage(job) {
    return job.stages.filter(function (s) { return s.state === "running"; })[0] || null;
  }

  var AR_KEY = { Score: "score", Semantic: "tokens" };

  function progressLine(job, text) {
    var m, s;
    if ((m = text.match(/^\[Prompt\] cot=(\w+), songs=(\d+), variations=(\d+)/))) {
      job.request.songs = +m[2];
      job.request.variations = +m[3];
    } else if (/^\[Pipeline\] Replay: /.test(text)) {
      ["score", "tokens"].forEach(function (key) {
        var st = stageOf(job, key);
        if (st.state !== "skipped") { st.state = "skipped"; st.skipNote = "Codes supplied: the music is already written"; }
      });
    } else if ((m = text.match(/^\[AR\] Frame budget clamped to (\d+)/))) {
      stageOf(job, "tokens").total = +m[1];
    } else if ((m = text.match(/^\[AR\] (Score|Semantic) prefill: .*?(?:budget=(\d+))?(?:,|$)/))) {
      s = runStage(job, AR_KEY[m[1]]);
      var budget = text.match(/budget=(\d+)/);
      if (budget) s.total = +budget[1];
    } else if ((m = text.match(/^\[AR\] (Score|Semantic) (\d+)\/(\d+)\s*$/))) {
      s = runStage(job, AR_KEY[m[1]]);
      s.done = Math.max(s.done, +m[2]);
      s.total = +m[3];
    } else if ((m = text.match(/^\[AR\] (Score|Semantic) song (\d+): end token at step (\d+)/))) {
      s = runStage(job, AR_KEY[m[1]]);
      s.ended = (s.ended || 0) + 1;
      s.done = Math.max(s.done, +m[3]);
    } else if ((m = text.match(/^\[AR\] (Score|Semantic) song \d+: \d+ tokens (prefilled|copied)/))) {
      runStage(job, AR_KEY[m[1]]);
    } else if ((m = text.match(/^\[AR\] (Score|Semantic) song (\d+): (\d+) tokens( \(truncated\))?\s*$/))) {
      s = stageOf(job, AR_KEY[m[1]]);
      s.longest = Math.max(s.longest || 0, +m[3]);
      if (m[4]) s.truncated = true;
    } else if ((m = text.match(/^\[AR\] (Score|Semantic): (\d+) tokens over (\d+) songs?, (\d+) steps, ([\d.]+) s/))) {
      s = stageOf(job, AR_KEY[m[1]]);
      s.done = Math.max(s.done, +m[4]);
      s.tokens = +m[2];
      completeStage(job, AR_KEY[m[1]], +m[5]);
    } else if ((m = text.match(/^\[Sliders\] (.*)$/))) {
      // one "<id> at gain <g>" line per slider; the "Detached" line only closes them
      if (!/^Detached/.test(m[1])) {
        var seen = job.notes.sliders ? job.notes.sliders.split(", ") : [];
        if (seen.indexOf(m[1]) < 0) seen.push(m[1]);
        job.notes.sliders = seen.join(", ");
      }
    } else if ((m = text.match(/^\[NAR\] Song (\d+): (\d+) frames \(([\d.]+) s\).*?(\d+) chunks? of (\d+), (\d+) variations?/))) {
      s = runStage(job, "sound");
      s.chunks = +m[4];
      s.song = +m[1];
      s.music = Math.max(s.music || 0, +m[3]);
      job.request.variations = +m[6];
      if (!s.stepsPer) s.stepsPer = job.request.steps;
    } else if ((m = text.match(/^\[NAR\] Step (\d+)\/(\d+)/))) {
      s = runStage(job, "sound");
      s.stepsPer = +m[2];
      s.done += 1;
    } else if (/^\[NAR\] Song \d+ chunk \d+\/\d+:/.test(text)) {
      s = stageOf(job, "sound");
      s.chunksDone = (s.chunksDone || 0) + 1;
    } else if ((m = text.match(/^\[VAE\] Track (\d+)\/(\d+)/))) {
      s = runStage(job, "decode");
      s.done = +m[1] - 1;
      s.total = +m[2];
    } else if ((m = text.match(/^\[VAE\] Tiled decode: (\d+) tiles/))) {
      s = runStage(job, "decode");
      s.tiles = +m[1];
      s.tilesDone = 0;
    } else if (/^\[VAE\] Decoded: /.test(text)) {
      // one line per tile in a tiled decode, one per track otherwise
      s = stageOf(job, "decode");
      if (s.tiles) s.tilesDone = Math.min(s.tiles, (s.tilesDone || 0) + 1);
      else if (s.state === "running") s.done = Math.min(s.total || 1, s.done + 1);
    } else if (/^\[VAE\] Tiled decode done/.test(text)) {
      s = stageOf(job, "decode");
      s.tiles = 0;
      s.tilesDone = 0;
      if (s.state === "running") s.done = Math.min(s.total || 1, s.done + 1);
    } else if ((m = text.match(/^\[Pipeline\] Done: (.*)$/))) {
      job.summary = m[1];
      job.stages.forEach(function (st) {
        if (st.state === "running" || st.state === "waiting") { st.state = "completed"; st.t1 = st.t1 || Date.now(); st.t0 = st.t0 || st.t1; }
      });
      if (job.status === "running") job.status = "saving";
      if (!job.provisional && !LOG.backlog) setTimeout(pollJobs, 150);
    } else if ((m = text.match(/^\[Library\] Saved (\S+)/))) {
      job.saved.push(m[1]);
      // a run from another page lands in the library too
      if (!LOG.backlog && (job.kind === "external" || job.provisional)) libraryRefreshSoon();
    } else if ((m = text.match(/^\[Store\] Load (\w+): (\d+) ms/))) {
      job.notes.load = { LM: "language model", NAR: "sound model", VAE: "VAE", SS2: "transcriber" }[m[1]] + " loaded in " + (+m[2] / 1000).toFixed(1) + " s";
    } else if (/Cancelled at /.test(text)) {
      job.lastFatal = "Cancelled";
    } else if (/FATAL/.test(text)) {
      job.lastFatal = text.replace(/^\[\w+\]\s*/, "");
    }
    scheduleRunPaint();
  }

  var libraryTimer = 0;
  function libraryRefreshSoon() {
    clearTimeout(libraryTimer);
    libraryTimer = setTimeout(function () { refreshLibrary().catch(function () {}); }, 600);
  }

  var runPaintQueued = false;
  function scheduleRunPaint() {
    if (runPaintQueued) return;
    runPaintQueued = true;
    requestAnimationFrame(function () { runPaintQueued = false; paintAllRuns(); });
  }

  function addLogLine(text, client) {
    LOG.lines.push({ text: text, client: client });
    if (LOG.lines.length > LOG_KEEP) LOG.lines.splice(0, LOG.lines.length - LOG_KEEP);
    LOG.pending.push({ text: text, client: client });
    if (LOG.pending.length === 1) requestAnimationFrame(flushLog);
  }

  function logClass(text, client) {
    if (client) return "dim";
    if (/FATAL|failed|Cancel|error/i.test(text)) return "bad";
    if (/^\[Pipeline\] Done|^\[Library\] Saved/.test(text)) return "good";
    if (/^\[Server\]/.test(text)) return "srv";
    return "";
  }

  function flushLog() {
    var body = $("logBody"), pending = LOG.pending;
    LOG.pending = [];
    if (!pending.length) return;
    var follow = $("logFollow").checked, fragment = document.createDocumentFragment();
    pending.slice(-LOG_KEEP).forEach(function (line) {
      var row = document.createElement("div");
      row.className = "log-line " + logClass(line.text, line.client);
      if (line.text.length > LOG_WIDTH) {
        row.textContent = line.text.slice(0, LOG_WIDTH);
        var cut = document.createElement("span");
        cut.className = "cut";
        cut.textContent = " \u2026 (+" + (line.text.length - LOG_WIDTH).toLocaleString() + " characters)";
        row.appendChild(cut);
      } else {
        row.textContent = line.text || " ";
      }
      fragment.appendChild(row);
    });
    body.appendChild(fragment);
    while (body.childElementCount > LOG_KEEP) body.removeChild(body.firstChild);
    if (follow) body.scrollTop = body.scrollHeight;
  }

  function scrollLogToEnd() { if ($("logFollow").checked) $("logBody").scrollTop = $("logBody").scrollHeight; }

  $("logCopy").addEventListener("click", function () {
    navigator.clipboard.writeText(LOG.lines.map(function (l) { return l.text; }).join("\n"))
      .then(function () { toast("Server log copied (" + LOG.lines.length + " lines)"); })
      .catch(function () { toast("The browser refused clipboard access", "bad"); });
  });
  $("logClear").addEventListener("click", function () { LOG.lines = []; $("logBody").textContent = ""; });
  $("logFollow").addEventListener("change", scrollLogToEnd);

  /* ------------------------------------------------------------ run chain */

  var STATE_LABELS = { queued: "Queued", running: "Running", saving: "Saving", done: "Complete", failed: "Failed", cancelled: "Cancelled" };

  function watchJob(job) {
    STATE.job = job;
    STATE.take = null;
    $("takeBody").classList.add("is-hidden");
    $("takeBody").classList.remove("is-running");
    $("takeEmpty").classList.add("is-hidden");
    $("chain").hidden = false;
    $("takeActions").innerHTML = "";
    $("stages").innerHTML = "";
    STATE.stageRows = null;
    paintAllRuns();
    if (job.abc) showPlanScore(job);
  }

  function paintAllRuns() {
    STATE.running = STATE.job && isLive(STATE.job) && !STATE.job.provisional ? STATE.job : liveMainJobs()[0] || null;
    paintRun();
    paintRunReturn();
    paintStatus();
    paintEngine();
    paintSubmitNote();
    // The library and the VAE row only change when the set of runs does; a
    // rebuild on every log line would flicker under the pointer.
    var signature = STATE.jobs.filter(function (j) { return isLive(j) && !j.provisional; }).map(function (j) {
      var stage = currentStage(j);
      return j.id + ":" + j.status + ":" + (stage ? stage.key : "") + ":" + j.title;
    }).join("|");
    if (signature !== STATE.runSignature) {
      STATE.runSignature = signature;
      paintLibrary();
      if (STATE.take) { paintDecodeSwitch(); paintSoundSwitch(); }
      if (tipFor && !tipFor.isConnected) hideTip();
    }
  }

  function liveMainJobs() {
    return STATE.jobs.filter(function (j) { return isLive(j) && !j.provisional && j.kind !== "transcribe" && j.kind !== "replay"; });
  }

  // The way back only makes sense while a run is live and you are elsewhere.
  function paintRunReturn() {
    var away = !!(STATE.running && STATE.take);
    $("backToRun").classList.toggle("is-hidden", !away);
    if (away) $("backToRunLabel").textContent = "Back to " + STATE.running.title;
  }

  function activeJob() {
    return STATE.jobs.filter(function (j) { return (j.status === "running" || j.status === "saving") && !j.provisional; })[0] || null;
  }

  function runDescription(job) {
    var r = job.request, parts = [];
    if (job.kind === "replay") return job.what || "same music, rendered again";
    if (job.kind === "external") parts.push("started elsewhere");
    if (r.plan) return (job.kind === "external" ? "started elsewhere · " : "") + "score only";
    if (r.replay) parts.push("from saved codes");
    if (r.songs > 1) parts.push(r.songs + " songs");
    if (r.variations > 1) parts.push(r.variations + " sounds each");
    parts.push(vaeLabel(r.vae) + " VAE");
    if (FORMAT_LABELS[r.format]) parts.push(FORMAT_LABELS[r.format]);
    if (job.versioned && job.count) parts.push("versions " + (job.index + 1) + (job.count > 1 ? "\u2013" + (job.index + job.count) : ""));
    return parts.join(" · ");
  }

  function runSeeds(job) {
    var lm = job.resolved.lm_seed || job.request.lm_seed, sound = job.resolved.seed || job.request.seed, parts = [];
    var songs = job.request.songs || 1, variations = job.request.variations || 1;
    if (job.kind === "transcribe") return "";
    if (lm && /^\d+$/.test(lm)) parts.push("music seed " + lm + (songs > 1 ? " \u2026 +" + (songs - 1) : ""));
    if (sound && /^\d+$/.test(sound) && !job.request.plan) parts.push("sound seed " + sound + (variations > 1 ? " \u2026 +" + (variations - 1) : ""));
    return parts.join(" · ");
  }

  function stageRead(job, s) {
    var now = Date.now(), read = "";
    if (s.state === "skipped" || s.state === "waiting") return "";
    var elapsed = s.t0 ? Math.max(0, ((s.t1 || now) - s.t0) / 1000) : 0;
    if (s.key === "score" || s.key === "tokens") {
      var count = s.tokens || s.done;
      if (!count && s.state === "running") return elapsed > 0.5 ? clock(elapsed) : "";
      read = "<b>" + count.toLocaleString() + "</b> tokens";
      if (s.key === "tokens") read += " · " + clock((s.state === "completed" && s.longest ? s.longest : s.done) / FRAME_RATE);
      if (s.state === "running") {
        var songs = job.request.songs || 1;
        if (songs > 1 && s.ended) read += "<br>" + s.ended + " / " + songs + " ended";
        else if (elapsed > 0.5 && s.done) read += "<br>" + (s.done / elapsed).toFixed(0) + "/s";
      } else if (s.seconds || elapsed > 0.05) {
        read += "<br>" + (s.seconds || elapsed).toFixed(1) + "s";
      }
    } else if (s.key === "sound") {
      var total = soundTotal(job, s);
      read = "<b>" + s.done + "</b>" + (total ? " / " + total : "") + " steps";
      if (s.state === "running" && total && s.done > 0) {
        // A long song's sound runs for minutes at full tilt; without a
        // countdown that is indistinguishable from a hang.
        read += "<br>" + clock((total - s.done) * (elapsed / s.done)) + " left";
      } else if (s.state === "completed" && elapsed > 0.05) {
        read += "<br>" + elapsed.toFixed(1) + "s";
      }
    } else if (s.key === "decode") {
      read = "<b>" + s.done + "</b>" + (s.total ? " / " + s.total : "") + (s.total === 1 ? " track" : " tracks");
      if (s.state === "completed" && elapsed > 0.05) read += "<br>" + elapsed.toFixed(1) + "s";
    }
    return read;
  }

  function soundTotal(job, s) {
    var per = s.stepsPer || job.request.steps || 0;
    return (job.request.songs || 1) * (s.chunks || 1) * per;
  }

  function stagePercent(job, s) {
    if (s.key === "sound") { var t = soundTotal(job, s); return t ? Math.min(100, (s.done / t) * 100) : 0; }
    if (s.key === "decode") {
      var part = s.tiles ? (s.tilesDone || 0) / s.tiles : 0;
      return s.total ? Math.min(100, ((s.done + part) / s.total) * 100) : 0;
    }
    return -1;   // the token stages end when the model says so: open-ended
  }

  function stageNote(job, s) {
    if (s.state === "skipped") return s.skipNote || "Skipped in this mode";
    var extra = [];
    if (s.key === "tokens" && job.notes.sliders && s.state !== "waiting") extra.push("sliders: " + job.notes.sliders);
    if (s.state === "running" && job.notes.load) extra.push(job.notes.load);
    if (s.key === "sound" && s.music) extra.push(clock(s.music) + " of music" + (s.chunks > 1 ? " in " + s.chunks + " chunks" : ""));
    if (s.truncated) extra.push("hit the token cap");
    return s.note + (extra.length ? " · " + extra.join(" · ") : "");
  }

  function paintRun() {
    var job = STATE.job;
    if (!job) return;
    var label = STATE_LABELS[job.status] || job.status;
    var active = activeJob();
    $("runState").textContent = label;
    $("runState").dataset.s = job.status === "saving" ? "running" : job.status;
    $("cancelRun").classList.toggle("is-hidden", !isLive(job));
    $("runWhat").textContent = runDescription(job);
    $("runSeeds").textContent = runSeeds(job);
    if (!STATE.take) {
      var eyebrow = label;
      if (job.status === "queued") eyebrow = active && active !== job ? "waiting behind " + active.title : "waiting for the server";
      else if (job.status === "saving") eyebrow = "writing the files";
      $("takeEyebrow").textContent = eyebrow;
      $("takeTitle").textContent = job.title;
    }
    var error = job.status === "failed" ? job.error : "";
    $("runError").classList.toggle("is-hidden", !error);
    $("runError").textContent = error || "";
    paintClock();

    if (!STATE.stageRows || STATE.stageRows.job !== job) {
      $("stages").innerHTML = job.stages.map(function (s, n) {
        return '<li class="stage" data-key="' + s.key + '"><span class="stage-num">' + (n + 1) + "</span>" +
          '<div class="stage-main"><div class="stage-label">' + escape(s.label) + "</div>" +
          '<div class="stage-note"></div><div class="meter"><i></i></div></div><div class="stage-read"></div></li>';
      }).join("");
      STATE.stageRows = { job: job, rows: all("#stages .stage") };
    }
    // Rows are updated in place, so a running meter keeps its animation.
    job.stages.forEach(function (s, n) {
      var row = STATE.stageRows.rows[n];
      if (!row) return;
      var shown = s.state, finished = !isLive(job);
      if (finished && s.state === "waiting") shown = "skipped";
      row.dataset.s = shown;
      row.querySelector(".stage-note").textContent = shown === "skipped" && s.state === "waiting" ? "Not reached" : stageNote(job, s);
      row.querySelector(".stage-read").innerHTML = stageRead(job, s);
      var meter = row.querySelector(".meter"), bar = meter.firstChild, pct = stagePercent(job, s);
      meter.classList.toggle("is-hidden", shown !== "running" && shown !== "completed");
      if (shown === "running") {
        meter.classList.toggle("indeterminate", pct < 0);
        bar.style.transform = pct < 0 ? "" : "scaleX(" + (pct / 100).toFixed(4) + ")";   // the indeterminate slide is CSS
        bar.style.background = "";
      } else if (shown === "completed") {
        meter.classList.remove("indeterminate");
        bar.style.transform = "scaleX(1)";
        bar.style.background = "var(--patina-dim)";
      }
    });
  }

  function paintClock() {
    var job = STATE.job;
    if (!job) return;
    var text = "0:00";
    if (job.started) text = (job.approx ? "~" : "") + clock(((job.finished || Date.now()) - job.started) / 1000);
    else if (job.status === "queued") text = clock((Date.now() - job.submitted) / 1000);
    $("runClock").textContent = text;
  }

  setInterval(function () {
    if (document.hidden) return;
    if (tipFor && !tipFor.isConnected) hideTip();
    paintClock();
    var job = STATE.job;
    if (job && isLive(job)) paintRun();
    if (activeJob()) paintEngine();
  }, 500);

  $("backToRun").addEventListener("click", function () {
    if (!STATE.running) return;
    STATE.take = null;
    $("takeBody").classList.add("is-hidden");
    watchJob(STATE.running);
    show("take");
  });

  $("cancelRun").addEventListener("click", function () {
    var job = STATE.job;
    if (!job || !isLive(job)) return;
    // Queued versions of the same song go with it.
    var doomed = STATE.jobs.filter(function (j) {
      return j === job || (job.group && j.group === job.group && j.status === "queued");
    });
    Promise.all(doomed.map(function (j) {
      return post("/job?id=" + encodeURIComponent(j.id) + "&cancel=1").catch(function (error) { toast(error.message, "bad"); });
    })).then(function () {
      toast(doomed.length > 1 ? "Cancelling this run and " + (doomed.length - 1) + " queued version" + (doomed.length > 2 ? "s" : "")
                              : "Cancelling after the current step");
      pollJobs();
    });
  });

  /* --------------------------------------------------------------- engine */

  function paintEngine() {
    var lamp = $("engineLamp"), state, detail, s;
    var live = activeJob();
    var queued = STATE.jobs.filter(function (j) { return j.status === "queued" && !j.provisional; }).length;
    if (!STATE.online) {
      s = "error"; state = "Server offline"; detail = "retrying every few seconds";
    } else if (live) {
      s = "busy";
      state = live.kind === "transcribe" ? "Transcribing" : (live.request.plan ? "Planning" : "Generating");
      var stage = currentStage(live);
      detail = (stage ? stage.label : (live.status === "saving" ? "Saving" : "Starting")) +
        (live.started ? " · " + clock((Date.now() - live.started) / 1000) : "") + (queued ? " · " + queued + " queued" : "");
    } else if (queued) {
      s = "loading"; state = "Queued"; detail = queued + (queued === 1 ? " run" : " runs") + " waiting";
    } else if (STATE.hardware && STATE.hardware.busy) {
      s = "busy"; state = "Busy"; detail = "a run from another page";
    } else {
      s = "idle"; state = "Ready";
      var backbone = STATE.settings && STATE.settings.model ? STATE.settings.model : basename(STATE.props && STATE.props.model).replace(/\.gguf$/i, "");
      detail = STATE.hardware && STATE.hardware.loaded_modules > 0 ? backbone + " resident" : (STATE.props ? "model not loaded yet" : "");
    }
    lamp.dataset.s = s;
    $("engineState").textContent = state;
    $("engineDetail").textContent = detail;
  }

  function paintServer() {
    var p = STATE.props || {};
    var rows = [
      ["Version", p.version || "—", ""],
      ["Backbone", basename(p.model) || "—", ""],
      ["Default VAE", vaeLabel(STATE.defaultVae), ""],
      ["Sample rate", p.sample_rate ? (p.sample_rate / 1000) + " kHz" : "—", ""],
      ["Context", p.context ? p.context.toLocaleString() + " tokens" : "—", ""],
      ["Songs per pass", String(STATE.maxBatch), ""],
      ["Transcriber", STATE.transcriber ? "loaded" : "not started with one", STATE.transcriber ? "ok" : "no"],
      ["Library", STATE.library ? "saved on disk" : "off (no --outputs)", STATE.library ? "ok" : "no"]
    ];
    $("serverCard").innerHTML = rows.map(function (row) {
      return "<div><dt>" + row[0] + '</dt><dd class="' + row[2] + '" title="' + escape(row[1]) + '">' + escape(row[1]) + "</dd></div>";
    }).join("");
    YueVaes.set(STATE.vaes, STATE.defaultVae);
    paintSliderCard();
    paintStrip();
    // Transcription needs the server's transcriber.
    $("coverFromAudio").disabled = !STATE.transcriber;
    $("coverFile").disabled = !STATE.transcriber;
    $("coverTask").disabled = !STATE.transcriber;
    if (!STATE.transcriber) {
      $("coverAudioStatus").textContent = "The server runs without a transcriber: start it with --transcriber to cover a recording.";
    } else if (!$("coverAudioStatus").dataset.busy) {
      $("coverAudioStatus").textContent = "Ready. Runs on the server, in its queue like a song.";
    }
    paintEngine();
  }

  function applyProps(props) {
    var first = !STATE.props;
    STATE.props = props;
    STATE.defaults = props.defaults || {};
    STATE.vaes = Array.isArray(props.vaes) && props.vaes.length ? props.vaes
      : [{ name: "standard", label: "Standard", repo: "m-a-p/YuE2-Vae" }];
    STATE.defaultVae = props.default_vae || STATE.vaes[0].name;
    STATE.sliderCatalog = Array.isArray(props.sliders) ? props.sliders : [];
    YueLoras.setCatalog(Array.isArray(props.loras) ? props.loras : []);
    STATE.sources = props.sources || {};
    paintAbout();
    YueLoras.setSources(STATE.sources.loras);
    YueVaes.setSources(STATE.sources.vaes);
    STATE.maxBatch = Math.max(1, parseInt(props.max_batch, 10) || 1);
    STATE.transcriber = !!props.transcriber;
    STATE.library = props.outputs !== false;
    if (props.frame_rate) FRAME_RATE = props.frame_rate;
    $("versions").max = "10";
    if (first) {
      buildKnobs();
      syncShape();
      paintOutputDefaults();
    }
    paintVaes();
    // drop sliders the server no longer offers
    var known = sliderLabels();
    STATE.sliderChoice = STATE.sliderChoice.filter(function (c) { return known[c.id] !== undefined; });
    paintSliders();
    fillTips();
    paintServer();
    paintSubmitNote();
  }


  /* ------------------------------------------- engine settings + hardware */
  // The server's own engine knobs: which backbone file, whether models stay in
  // GPU memory between songs, the context (key/value cache) size and the VAE
  // tile size. Presets only fill the form; Save applies.

  var MEM_PRESETS = {
    "8":  { model: "Q8_0", max_seq: 12288, keep_loaded: false, vae_core: 256 },
    "12": { model: "BF16", max_seq: 16384, keep_loaded: false, vae_core: 512 },
    "16": { model: "BF16", max_seq: 0, keep_loaded: false, vae_core: 512 },
    "24": { model: "BF16", max_seq: 0, keep_loaded: false, vae_core: 1024 },
    "32": { model: "BF16", max_seq: 0, keep_loaded: true, vae_core: 1024 }
  };
  var SETTING_KEYS = ["model", "keep_loaded", "max_seq", "vae_core"];
  var GIB = 1073741824;

  function fullContext() { return (STATE.settings && STATE.settings.max_seq_full) || (STATE.props && STATE.props.context) || 24576; }

  function presetFits(preset) {
    var models = (STATE.settings && STATE.settings.models) || [];
    return models.indexOf(preset.model) >= 0;
  }

  function matchPreset(settings) {
    var found = "";
    Object.keys(MEM_PRESETS).forEach(function (size) {
      var p = MEM_PRESETS[size];
      if (p.max_seq === settings.max_seq && p.keep_loaded === !!settings.keep_loaded && p.vae_core === settings.vae_core &&
          (!presetFits(p) || p.model === settings.model)) found = size;
    });
    return found;
  }

  // Top-bar model choice: the backbone files the server was started with.
  var MODEL_SIZES = { BF16: "7.2 GB", Q8_0: "3.8 GB", Q6_K: "2.9 GB", Q5_K_M: "2.6 GB" };

  function paintModelPick(settings) {
    var pick = $("modelPick"), models = (settings && settings.models) || [];
    pick.innerHTML = models.length ? models.map(function (m) {
      return '<option value="' + escape(m) + '">Model: ' + escape(m) + (MODEL_SIZES[m] ? " (" + MODEL_SIZES[m] + ")" : "") + "</option>";
    }).join("") : '<option value="">Model: as started</option>';
    pick.value = (settings && settings.model) || "";
    pick.disabled = models.length < 2;
  }

  $("modelPick").addEventListener("change", function () {
    var name = this.value;
    post("/settings", { model: name }).then(function (data) {
      paintSettings(data, true);
      toast("Model " + name + (data.applied ? " — it loads with the next song" : " — it applies before the next song"), "good");
    }).catch(function (error) {
      toast(error.message, "bad");
      paintModelPick(STATE.settings);
    });
  });

  function paintSettings(settings, force) {
    STATE.settings = settings;
    paintModelPick(settings);
    // A background refresh must not wipe fields you are still editing; Save repaints them.
    if (STATE.settingsDirty && !force) {
      paintStrip();
      paintSubmitNote();
      return;
    }
    STATE.settingsDirty = false;
    var models = settings.models || [];
    $("setModel").innerHTML = models.length ? models.map(function (m) {
      return '<option value="' + escape(m) + '">' + escape(m) + (m === "BF16" ? " (release weights)" : " (quantized)") + "</option>";
    }).join("") : '<option value="">as started</option>';
    $("setModel").value = settings.model || "";
    [["setMaxSeq", settings.max_seq], ["setVaeCore", settings.vae_core]].forEach(function (pair) {
      $(pair[0]).setAttribute("value", pair[1]);   // the step base, as with the sampling knobs
      $(pair[0]).value = pair[1];
    });
    $("setKeepLoaded").checked = !!settings.keep_loaded;
    $("memPreset").value = matchPreset(settings);
    paintComputeHint();
    paintStrip();
    paintSubmitNote();
  }

  function paintComputeHint() {
    var rows = parseInt($("setMaxSeq").value, 10), notes = [];
    if (rows === 0 || isNaN(rows)) notes.push("Context: the whole " + fullContext().toLocaleString() + " rows, room for any song.");
    else notes.push("Context " + rows.toLocaleString() + " rows: songs up to about " + clock(Math.max(0, rows - 2500) / FRAME_RATE) +
                    " with a typical prompt; longer ones will not fit.");
    notes.push($("setKeepLoaded").checked ? "Models stay in GPU memory between songs." : "Each stage leaves GPU memory when it is done.");
    $("computeHint").textContent = notes.join(" ");
  }

  function readSettingsForm() {
    var maxSeq = Number($("setMaxSeq").value), vaeCore = Number($("setVaeCore").value), full = fullContext();
    if (!Number.isInteger(maxSeq) || (maxSeq !== 0 && (maxSeq < 4096 || maxSeq > full))) {
      throw new Error("Context size must be 0 (the whole " + full.toLocaleString() + ") or between 4,096 and " + full.toLocaleString());
    }
    if (!Number.isInteger(vaeCore) || vaeCore < 64 || vaeCore > 4096) throw new Error("VAE tile frames must be between 64 and 4,096");
    var out = { keep_loaded: $("setKeepLoaded").checked, max_seq: maxSeq, vae_core: vaeCore };
    if ($("setModel").value) out.model = $("setModel").value;
    return out;
  }

  function refreshSettings() {
    return api("/settings").then(function (settings) {
      $("computeCard").classList.remove("is-off");
      paintSettings(settings);
    }).catch(function (error) {
      if (error.status !== 404) return;
      // An older server without engine settings: the card says so and stays still.
      $("computeCard").classList.add("is-off");
      all("#computeCard select, #computeCard input, #computeCard button").forEach(function (el) { el.disabled = true; });
      $("computeHint").textContent = "This server has no engine settings; its start-up flags decide.";
    });
  }

  ["setMaxSeq", "setVaeCore", "setKeepLoaded", "setModel"].forEach(function (id) {
    $(id).addEventListener("input", function () { STATE.settingsDirty = true; paintComputeHint(); $("memPreset").value = ""; });
    $(id).addEventListener("change", function () { STATE.settingsDirty = true; paintComputeHint(); });
  });

  $("memPreset").addEventListener("change", function () {
    var size = this.value;
    if (!size) return;
    STATE.settingsDirty = true;
    if (size === "auto") {
      var gpu = STATE.hardware && (STATE.hardware.gpus || [])[0], gib = gpu ? gpu.total_bytes / GIB : 0, pick = "";
      Object.keys(MEM_PRESETS).forEach(function (c) { if (gib + 0.6 >= +c) pick = c; });
      if (!pick) { this.value = ""; return toast("No GPU size detected — choose one", "bad"); }
      size = pick;
      this.value = size;
    }
    var p = MEM_PRESETS[size], models = (STATE.settings && STATE.settings.models) || [];
    if (models.indexOf(p.model) >= 0) $("setModel").value = p.model;
    $("setMaxSeq").value = p.max_seq;
    $("setKeepLoaded").checked = p.keep_loaded;
    $("setVaeCore").value = p.vae_core;
    paintComputeHint();
    toast(size + " GB preset: " + (models.indexOf(p.model) >= 0 ? p.model + ", " : "") +
          (p.max_seq ? "context " + p.max_seq.toLocaleString() : "whole context") + ", models " +
          (p.keep_loaded ? "kept loaded" : "unloaded after each song") + ", VAE tiles " + p.vae_core + ". Press Save to apply.");
  });

  $("saveSettings").addEventListener("click", function () {
    var next;
    try { next = readSettingsForm(); } catch (error) { return toast(error.message, "bad"); }
    var current = STATE.settings || {}, changed = {};
    SETTING_KEYS.forEach(function (key) { if (next[key] !== undefined && next[key] !== current[key]) changed[key] = next[key]; });
    if (!Object.keys(changed).length) return toast("No changes to save");
    var button = this;
    button.disabled = true;
    post("/settings", changed).then(function (data) {
      paintSettings(data, true);
      var loads = changed.model ? "the " + changed.model + " backbone" : "";
      var note = loads ? " — the next song loads " + loads : "";
      toast(data.applied ? "Saved and applied" + note : "Saved — the server is busy; it applies before the next song", "good");
      pollProps();
      return refreshHardware();
    }).catch(function (error) { toast(error.message, "bad"); })
      .then(function () { button.disabled = false; });
  });

  function refreshHardware() {
    return api("/hardware").then(function (hw) {
      STATE.hardware = hw || {};
      STATE.noHardware = false;
      paintHardware();
    }).catch(function (error) {
      if (error.status === 404) { STATE.noHardware = true; STATE.hardware = null; paintHardware(); }
    });
  }

  function gpuOf() { return STATE.hardware && (STATE.hardware.gpus || [])[0] || null; }
  function gib(bytes) { return (bytes / GIB).toFixed(1); }

  function paintHardware() {
    var hw = STATE.hardware || {}, gpu = gpuOf(), loaded = hw.loaded_modules || 0;
    var rows = [
      ["GPU", gpu ? (gpu.description || gpu.name) : (STATE.noHardware ? "not reported" : "none: runs on the CPU"), gpu ? "ok" : "no"],
      ["VRAM", gpu ? gib(gpu.total_bytes - gpu.free_bytes) + " / " + gib(gpu.total_bytes) + " GiB" : "—", ""],
      ["Loaded", loaded ? gib(hw.loaded_bytes || 0) + " GiB · " + loaded + (loaded === 1 ? " module" : " modules") : "nothing", loaded ? "amber" : ""],
      ["Busy", hw.busy ? "running a job" : "idle", hw.busy ? "amber" : ""]
    ];
    $("hwCard").innerHTML = rows.map(function (row) {
      return "<div><dt>" + row[0] + '</dt><dd class="' + row[2] + '" title="' + escape(row[1]) + '">' + escape(row[1]) + "</dd></div>";
    }).join("");
    $("hwNote").textContent = STATE.noHardware ? "This server does not report its hardware."
      : (loaded && !hw.busy ? "Unload model frees it now; the next song loads it again." : "");
    // Unload only makes sense with a model loaded and nothing running on it.
    var canUnload = !STATE.noHardware && loaded > 0 && !hw.busy;
    $("unloadModel").disabled = !canUnload;
    $("unloadNow").disabled = !canUnload;
    paintStrip();
    paintEngine();
    paintSubmitNote();
  }

  function paintStrip() {
    var p = STATE.props || {}, s = STATE.settings, gpu = gpuOf();
    var strip = [];
    if (gpu) {
      strip.push(["GPU", gpu.description || gpu.name]);
      strip.push(["VRAM", gib(gpu.total_bytes - gpu.free_bytes) + " / " + gib(gpu.total_bytes) + " GiB"]);
    } else if (STATE.hardware) {
      strip.push(["GPU", "none"]);
    }
    strip.push(["Backbone", s && s.model ? s.model : (basename(p.model).replace(/\.gguf$/i, "") || "—")]);
    strip.push(["Context", s ? (s.max_seq ? s.max_seq.toLocaleString() : "whole") : (p.context ? p.context.toLocaleString() : "—")]);
    strip.push(["Batch", String(STATE.maxBatch)]);
    $("hwStats").innerHTML = strip.map(function (row) {
      return "<div><dt>" + row[0] + '</dt><dd title="' + escape(row[1]) + '">' + escape(row[1]) + "</dd></div>";
    }).join("");
  }

  function unloadModels() {
    var gpu = gpuOf(), before = gpu ? gib(gpu.total_bytes - gpu.free_bytes) : null;
    $("unloadModel").disabled = true;
    $("unloadNow").disabled = true;
    post("/unload").then(function (data) {
      if (!data || !data.applied) {
        toast("The server is busy; it unloads when the running song is done");
        return refreshHardware();
      }
      return refreshHardware().then(function () {
        var now = gpuOf(), after = now ? gib(now.total_bytes - now.free_bytes) : null;
        toast("Model unloaded — " + Math.round(data.freed_mb || 0).toLocaleString() + " MB freed" +
              (before !== null && after !== null ? " (VRAM " + before + " GiB -> " + after + " GiB)" : ""), "good");
      });
    }).catch(function (error) { toast(error.message, "bad"); refreshHardware(); });
  }

  $("unloadModel").addEventListener("click", unloadModels);
  $("unloadNow").addEventListener("click", unloadModels);

  /* ---------------------------------------------------------------- take */

  function findTake(name) {
    return STATE.takes.filter(function (t) { return t.name === name; })[0] || null;
  }

  // The name a take is shown under: its title, or the folder's slug.
  function displayTitle(take) {
    if (!take) return "";
    if (take.title) return take.title;
    var bare = String(take.name || "").replace(/^\d{8}-\d{6}-/, "").replace(/^session-/, "").replace(/-/g, " ");
    return bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : "Untitled";
  }

  function takeAudioUrl(take) {
    return take.session ? take.url : "/library/audio?name=" + encodeURIComponent(take.name);
  }

  function formatExt(format) { return format === "mp3" ? "mp3" : "wav"; }

  // Downloads are named after the song ("Last Train Home.wav"), as the server names them: the title without
  // the characters Windows refuses in a file name. The Takes menu can put the date back (the library name,
  // "20260927-183418-last-train-home"); the server is told too, since its name beats the page's.
  function libraryNames() { return recall("yue2.dlNames") === "library"; }
  function fileTitle(take) {
    if (libraryNames()) return take.name;
    return displayTitle(take).replace(/[\u0000-\u001f\u007f\\/:*?"<>|\s]+/g, " ").replace(/[\s.]+$/, "").trim() || take.name;
  }
  function namesParam() { return libraryNames() ? "&names=library" : ""; }
  function audioFileName(take) { return fileTitle(take) + "." + formatExt(take.format); }
  function downloadUrl(take) { return take.session ? take.url : takeAudioUrl(take) + namesParam(); }

  // MP3 copies for sharing: made on the server at the bitrate chosen on the song page
  function mp3Rate() {
    var saved = 320;
    saved = parseInt(recall("yue2.mp3kbps") || "320", 10);
    return [128, 192, 256, 320].indexOf(saved) >= 0 ? saved : 320;
  }

  function mp3Url(take) {
    return "/library/mp3?name=" + encodeURIComponent(take.name) + "&kbps=" + mp3Rate() + namesParam();
  }

  // Conversions need a saved WAV: a song still being made (session) has no library copy yet,
  // and a take made as MP3 is already the MP3 (its own download).
  function convertible(take) { return !!take && !take.session && take.format !== "mp3"; }

  function paintMp3Link(link, take, label) {
    link.classList.toggle("is-hidden", !convertible(take));
    if (!convertible(take)) return;
    link.href = mp3Url(take);
    link.setAttribute("download", fileTitle(take) + ".mp3");
    link.textContent = label;
  }

  // the song page's download buttons: named after the song (or with the date), the server told the same
  function paintTakeDownloads() {
    var take = STATE.take;
    if (!take) return;
    $("dlTakeAudio").href = downloadUrl(take);
    $("dlTakeAudio").textContent = formatExt(take.format).toUpperCase();
    $("dlTakeAudio").setAttribute("download", audioFileName(take));
    paintMp3();
  }

  function paintMp3() {
    var take = STATE.take, flac = $("dlTakeFlac");
    $("mp3Rate").value = String(mp3Rate());
    $("mp3Rate").classList.toggle("is-hidden", !convertible(take));
    paintMp3Link($("dlTakeMp3"), take, "MP3");
    flac.classList.toggle("is-hidden", !convertible(take));
    if (convertible(take)) {
      flac.href = "/library/flac?name=" + encodeURIComponent(take.name) + namesParam();
      flac.setAttribute("download", fileTitle(take) + ".flac");
    }
  }

  $("mp3Rate").addEventListener("change", function () {
    store("yue2.mp3kbps", $("mp3Rate").value);
    paintMp3();
    paintLibrary();
    toast("MP3 downloads now at " + mp3Rate() + " kbps");
  });

  // True while a song is audibly playing; finished runs must not replace it.
  function isPlaying() { return !!audio.getAttribute("src") && !audio.paused && !audio.ended; }

  var requestsPending = {};
  function getRequest(take) {
    if (STATE.requests[take.name]) return Promise.resolve(STATE.requests[take.name]);
    if (take.session) return Promise.reject(new Error("This take's request is gone with the page reload"));
    if (requestsPending[take.name]) return requestsPending[take.name];   // one fetch for overlapping asks
    var name = take.name, pending = fetch("/library/request?name=" + encodeURIComponent(name)).then(function (r) {
      return r.text().then(function (text) {
        if (!r.ok) throw new Error("Could not read the take's request (" + r.status + ")");
        var req = parseJSON(text);
        STATE.requests[name] = req;
        return req;
      });
    });
    var done = function () { delete requestsPending[name]; };
    pending.then(done, done);
    requestsPending[name] = pending;
    return pending;
  }

  function openTake(name, opts) {
    var take = findTake(name);
    if (!take) return;
    opts = opts || {};
    STATE.take = take;
    STATE.job = null;
    STATE.stageRows = null;
    $("chain").hidden = true;
    $("takeEmpty").classList.add("is-hidden");
    $("takeBody").classList.remove("is-hidden", "is-running");
    $("scoreAbc").classList.remove("paper-live");
    paintTakeHead();

    // Looking at a song never cuts off the one that is playing. The player follows
    // the page only while it is idle; a version chip (keep) is an explicit switch.
    var inPlayer = STATE.playerTake && STATE.playerTake.name === take.name;
    if (opts.keep) {
      var sameMusic = !!(STATE.playerTake && familyOf(take).some(function (t) { return t.name === STATE.playerTake.name; }));
      var wasPlaying = isPlaying();
      loadPlayer(take, sameMusic);
      if (!sameMusic && wasPlaying) audio.play().catch(function () {});
    } else if (inPlayer) {
      STATE.playerTake = take;
    } else if (!isPlaying()) {
      loadPlayer(take, false);
    }
    paintTakeDownloads();

    paintTakeMeta();
    $("metaStyle").textContent = take.style;
    var parent = take.parent ? findTake(take.parent) : null;
    $("metaCover").textContent = take.parent ? "Re-rendered from \u201c" + (parent ? displayTitle(parent) : take.parent) + "\u201d" : "";
    // Section tags carry the structure, so they are marked rather than escaped flat.
    $("metaLyrics").innerHTML = (take.lyrics || "").split(/\r?\n/).map(function (line) {
      return line.trim().charAt(0) === "[" ? "<b>" + escape(line) + "</b>" : escape(line);
    }).join("\n");

    $("scorePanel").classList.toggle("is-hidden", !take.has_score);
    $("dlScore").disabled = !take.has_score;
    $("scoreAbc").textContent = "";
    $("scoreStaff").textContent = "";
    STATE.abcRendered = "";
    if (take.has_score) {
      getRequest(take).then(function (req) {
        if (STATE.take === take) renderScore(req.abc || "");
      }).catch(function () {});
    }

    paintDecodeSwitch();
    paintPlayHere();
    paintSoundSwitch();
    markActive();
    paintRunReturn();
    show("take");
  }

  function paintTakeHead() {
    var take = STATE.take;
    if (!take) return;
    // how old, how long, how long it took (the seeds are in the details below)
    var eyebrow = [ago(take.created)];
    if (take.seconds) eyebrow.push(clock(take.seconds) + " long");
    if (take.render_seconds) eyebrow.push("made in " + clock(take.render_seconds));
    $("takeEyebrow").textContent = eyebrow.join(" · ");
    $("takeTitle").textContent = displayTitle(take);
    // Favourite, Rename and Delete as small icons on the title line (Delete asks first)
    $("takeActions").innerHTML =
      '<button type="button" class="btn ghost small icon-act' + (take.favorite ? " is-on" : "") + '" id="favTake" aria-pressed="' +
      (take.favorite ? "true" : "false") + '" aria-label="Favourite" data-tip="' + (take.favorite ? "Remove from favourites" : "Keep as a favourite") + '">' +
      (take.favorite ? "★" : "☆") + "</button>" +
      '<button type="button" class="btn ghost small icon-act" id="renameTake" aria-label="Rename" data-tip="Rename this take">✎</button>' +
      '<button type="button" class="btn ghost small icon-act danger" id="deleteTake" aria-label="Delete take" data-tip="Delete this take (asks first)">' +
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5"/></svg></button>';
    paintPlayHere();
  }

  // Where a song's sampling sat on the three shape sliders: the position (0 lowest .. 4 highest, -1
  // custom), a note, and the same as plain text. Keys a saved request leaves out are the defaults.
  function shapeInfo(id, sampling) {
    var spec = SHAPES[id], pos = -1;
    var value = function (key) {
      return sampling && sampling[key] !== undefined ? round(Number(sampling[key]), 6) : round(samplingDefault(spec.group, key), 6);
    };
    spec.steps.forEach(function (v, i) { if (spec.keys.every(function (k, j) { return value(k) === v[j]; })) pos = i; });
    var values = "temperature " + value("temperature") + " · top-p " + value("top_p") + " · top-k " + value("top_k");
    return pos >= 0 ? { pos: pos, note: "", text: SHAPE_LABELS[pos] } : { pos: -1, note: values, text: "custom: " + values };
  }

  function styleInfo(take) {
    var auto = !(typeof take.cfg_scale === "number" && take.cfg_scale >= 0), fallback = take.cot === "off" ? 1.01 : 1.0;
    var value = auto ? fallback : round(take.cfg_scale, 3);
    var pos = value === fallback ? 2 : SHAPES.shapeStyle.cfg.indexOf(value);
    // the guidance value only shows when it matches no position (a hover says it either way)
    var note = "guidance " + (auto ? "default " + (take.cot === "off" ? "1.01" : "1.0") : value);
    return { pos: pos, note: note, text: pos >= 0 ? SHAPE_LABELS[pos] : "custom " + value };
  }

  // The song's details: one compact card. Row one: Song | Sound | Shape side by side; row two: Sliders |
  // LoRAs; row three: the two seeds. Length and render time are on the line under the title. Every field
  // also carries its value as plain text (data-value), which the tests read.
  function paintTakeMeta() {
    var take = STATE.take;
    if (!take) return;
    var labels = sliderLabels();
    // Composition and Performance come from the saved request: fetched once, then painted again
    var req = STATE.requests[take.name], shapes = req ? true : (STATE.noRequest[take.name] ? false : null);
    if (shapes === null) {
      getRequest(take).then(function () { if (STATE.take === take) paintTakeMeta(); })
        .catch(function () { STATE.noRequest[take.name] = true; if (STATE.take === take) paintTakeMeta(); });
    }
    var field = function (label, html, text, key, cls, tip) {
      return '<div data-field="' + escape(key || label) + '" data-value="' + escape(text) + '"><dt>' + escape(label) + "</dt><dd" +
        (cls ? ' class="' + cls + '"' : "") + (tip ? ' title="' + escape(tip) + '"' : "") + ">" + html + "</dd></div>";
    };
    var plain = function (label, text, cls) { return field(label, escape(String(text)), String(text), "", cls); };
    var column = function (title, body, attrs) {
      return '<section class="meta-col"' + (attrs || "") + "><h4>" + title + "</h4>" + body + "</section>";
    };
    var scale = function (label, key, info) {
      var dots = "";
      for (var i = 0; i < 5; i++) dots += "<i" + (i === info.pos ? ' class="on"' : "") + "></i>";
      var shown = info.pos >= 0 ? SHAPE_LABELS[info.pos] : info.text.replace(/:.*$/, "");
      return field(label, '<span class="dots' + (info.pos < 0 ? " custom" : "") + '" aria-hidden="true">' + dots + "</span>" + escape(shown),
        info.text, key, "", info.note);
    };
    var addonList = function (key, text, items) {   // items: [name, amount html]
      var rows = items.length ? items.map(function (it) {
        return '<span class="name">' + escape(it[0]) + '</span><span class="amt">' + it[1] + "</span>";
      }).join("") : '<span class="none">none</span>';
      return column(key, '<div class="meta-rows addons">' + rows + "</div>", ' data-field="' + key + '" data-value="' + escape(text) + '"');
    };
    var seed = function (label, key, value) {
      return '<div data-field="' + key + '" data-value="' + escape(value || "—") + '"><dt>' + label + '</dt><dd class="num">' + escape(value || "—") +
        '</dd><dd class="copy-cell">' + (value ? '<button type="button" class="seed-copy" data-copy="' + escape(value) + '" data-what="' +
        label.toLowerCase() + ' seed" aria-label="Copy the ' + label.toLowerCase() + ' seed" data-tip="Copy the ' + label.toLowerCase() + ' seed">⧉</button>' : "") +
        "</dd></div>";
    };

    var song = plain("Mode", MODES[take.cot] || take.cot || "—") + plain("Format", FORMAT_LABELS[take.format] || take.format || "—");
    if (take.truncated) song += plain("Limit", "hit token cap", "warn");
    if (take.provided_score) song += plain("Score", "supplied");
    // made while the F32 option existed (removed 2026-09-26): kept so those songs can still be compared
    if (take.precision === "f32") song += plain("Precision", "F32 (option since removed)");
    if (take.song > 0 || take.variation > 0) {
      song += plain("Batch", "song " + ((take.song || 0) + 1) + (take.variation > 0 ? ", sound " + (take.variation + 1) : ""));
    }
    if (take.session) song += plain("Kept", "this tab only");
    var sound = plain("VAE", vaeLabel(take.vae)) + plain("Model", take.model || "—") + plain("Steps", take.steps || "—", "num");
    var shape = (shapes ? scale("Composition", "", shapeInfo("shapeComposition", req.abc_sampling)) +
                          scale("Performance", "", shapeInfo("shapePerformance", req.semantic_sampling))
                        : plain("Composition", shapes === null ? "…" : "—") + plain("Performance", shapes === null ? "…" : "—")) +
                scale("Style", "Style influence", styleInfo(take));

    var sliders = take.sliders || [];
    var slidersText = sliders.length ? sliders.map(function (c) { return (labels[c.id] || c.id) + " " + round(c.strength, 2); }).join(", ") : "none";
    var sliderItems = sliders.map(function (c) {
      var strength = Math.max(0, Math.min(1, Number(c.strength) || 0));
      return [labels[c.id] || c.id, '<span class="bar"><b style="width:' + Math.round(strength * 100) + '%"></b></span>' + (Number(c.strength) || 0).toFixed(2)];
    });
    var loraItems = YueLoras.lines(take.loras).map(function (l) { return [l.name, escape(l.amounts)]; });
    var lorasText = (take.loras || []).length ? YueLoras.describe(take.loras) : "none";

    $("metaGrid").innerHTML =
      '<div class="meta-row trio">' + column("Song", '<dl class="meta-rows">' + song + "</dl>") +
        column("Sound", '<dl class="meta-rows">' + sound + "</dl>") + column("Shape", '<dl class="meta-rows">' + shape + "</dl>") + "</div>" +
      '<div class="meta-row duo">' + addonList("Sliders", slidersText, sliderItems) + addonList("LoRAs", lorasText, loraItems) + "</div>" +
      '<div class="meta-row seeds"><dl class="meta-rows seeds">' + seed("Music", "Music seed", seedText(take.lm_seed)) +
        seed("Sound", "Sound seed", seedText(take.seed)) + "</dl></div>";
  }

  // About (bottom of the Engine page): the add-ons' own pages, from loras/sources.json. Only web links
  // become links; a LoRA split into two files (music half, sound half) appears once.
  function paintAbout() {
    var src = STATE.sources || {};
    var web = function (u) { return /^https?:\/\//i.test(String(u || "")) ? String(u) : ""; };
    var where = function (u) {
      var m = u.match(/^https?:\/\/[^/]+\/([^/?#]+\/[^/?#]+)/);
      return m ? m[1] : u.replace(/^https?:\/\//, "");
    };
    var item = function (name, url) {
      var u = web(url);
      return "<li>" + (u ? '<a href="' + escape(u) + '" target="_blank" rel="noopener noreferrer">' + escape(name) + '</a><span class="about-where">' +
        escape(where(u)) + "</span>" : '<span class="about-name">' + escape(name) + "</span>") + "</li>";
    };
    var list = function (title, items) {
      return "<section><h4>" + title + '</h4><ul class="about-links">' + (items.length ? items.join("") : '<li class="about-none">none listed</li>') + "</ul></section>";
    };
    var vaeNames = { standard: "Standard VAE", legacy: "Legacy VAE", blend: "Blend VAE" };
    var vaes = Object.keys(src.vaes || {}).map(function (k) { return item(vaeNames[k] || k + " VAE", (src.vaes[k] || {}).url); });
    var sliders = src.sliders && src.sliders.url ? [item("Voice and genre sliders", src.sliders.url)] : [];
    var byUrl = {}, order = [];
    Object.keys(src.loras || {}).forEach(function (k) {
      var e = src.loras[k] || {}, key = web(e.url) || "~" + k, name = e.title || k.replace(/\/+$/, "");
      if (!byUrl[key]) { byUrl[key] = { names: [], url: e.url }; order.push(key); }
      if (byUrl[key].names.indexOf(name) < 0) byUrl[key].names.push(name);
    });
    var loras = order.map(function (k) { return item(byUrl[k].names.join(" / "), byUrl[k].url); });
    $("aboutAddons").innerHTML = list("Sound decoders", vaes) + list("Sliders", sliders) + list("LoRAs", loras);
  }

  $("metaGrid").addEventListener("click", function (event) {
    var button = event.target.closest("[data-copy]");
    if (!button) return;
    navigator.clipboard.writeText(button.dataset.copy)
      .then(function () { toast("The " + button.dataset.what + " is copied"); })
      .catch(function () { toast("The browser refused clipboard access", "bad"); });
  });

  function renderScore(abc) {
    $("scoreAbc").textContent = abc || "";
    STATE.abcRendered = abc || "";
    if (!abc) { $("scoreStaff").textContent = ""; return; }
    if (!window.__abcjsFailed && typeof window.ABCJS === "undefined") {
      // the engraver is still on its way: the ABC tab has the score now, the staff is drawn when it lands
      window.__abcjsLanded = function () { window.__abcjsLanded = null; if (STATE.abcRendered) renderScore(STATE.abcRendered); };
      $("scoreStaff").textContent = "";   // not the last song's staff
      return;
    }
    if (window.__abcjsFailed) {
      // No renderer available: the ABC text is the score.
      $("scoreStaff").classList.add("is-hidden");
      $("scoreAbc").classList.remove("is-hidden");
      document.querySelector('.stab[data-score="staff"]').disabled = true;
      all(".stab").forEach(function (t) { t.classList.toggle("is-active", t.dataset.score === "abc"); });
      return;
    }
    try {
      window.ABCJS.renderAbc("scoreStaff", abc, {
        responsive: "resize",
        staffwidth: 700,
        paddingtop: 4,
        paddingbottom: 10,
        foregroundColor: getComputedStyle(document.documentElement).getPropertyValue("--paper-ink").trim() || "#2a2318"
      });
    } catch (error) {
      $("scoreStaff").textContent = "This score could not be engraved; read it as ABC.";
    }
  }

  all(".stab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      all(".stab").forEach(function (t) { t.classList.toggle("is-active", t === tab); });
      var staff = tab.dataset.score === "staff";
      $("scoreStaff").classList.toggle("is-hidden", !staff);
      $("scoreAbc").classList.toggle("is-hidden", staff);
    });
  });

  // the prompt exactly as the song page shows it
  $("copyPrompt").addEventListener("click", function () {
    var text = $("metaStyle").textContent;
    if (!text) return toast("This take has no prompt", "bad");
    navigator.clipboard.writeText(text)
      .then(function () { toast("Prompt copied"); })
      .catch(function () { toast("The browser refused clipboard access", "bad"); });
  });

  $("copyLyrics").addEventListener("click", function () {
    var text = STATE.take ? STATE.take.lyrics : "";
    if (!text) return;
    navigator.clipboard.writeText(text)
      .then(function () { toast("Lyrics copied"); })
      .catch(function () { toast("The browser refused clipboard access", "bad"); });
  });

  $("reuseScore").addEventListener("click", function () {
    var take = STATE.take;
    if (!take || !take.has_score) return;
    getRequest(take).then(function (req) {
      $("abc").value = req.abc || "";
      $("style").value = take.style;
      $("lyrics").value = take.lyrics;
      $("title").value = displayTitle(take) + " (edit)";
      if (MODES[take.cot] && take.cot !== "off") setCot(take.cot);
      setCodes(null);
      growLyrics();
      $("scoreDrawer").open = true;
      show("compose");
      $("abc").focus();
      toast("Score copied into the form — edit it, then generate");
    }).catch(function (error) { toast(error.message, "bad"); });
  });

  // Retake: this exact take again (score, seeds and music codes); Reuse: the same prompt,
  // lyrics and settings for a new song (no score, no seeds, no codes)
  $("retakeTake").addEventListener("click", function () {
    var take = STATE.take;
    if (!take) return;
    getRequest(take).then(function (req) {
      loadRequestIntoForm(req, { title: displayTitle(take), fromTake: take.session ? null : take.name, codesTitle: displayTitle(take) });
      toast("Retake: this take is in the form with its music codes, so Generate renders that music again. Drop the codes to write new music.", "good");
    }).catch(function (error) { toast(error.message, "bad"); });
  });

  $("reuseTake").addEventListener("click", function () {
    var take = STATE.take;
    if (!take) return;
    getRequest(take).then(function (req) {
      var fresh = Object.assign({}, req, { abc: "", lm_seed: -1, seed: -1, semantic_tokens: "" });
      loadRequestIntoForm(fresh, { title: displayTitle(take) });
      $("scoreDrawer").open = false;
      show("compose");
      toast("Reuse: prompt, lyrics and settings are in the form, with no score, seeds or music codes. Generate writes a new song from them.", "good");
    }).catch(function (error) { toast(error.message, "bad"); });
  });

  $("dlRequest").addEventListener("click", function () {
    var take = STATE.take;
    if (!take) return;
    getRequest(take).then(function (req) {
      downloadText(slug(displayTitle(take)) + ".request.json", toJSON(req, 2) + "\n", "application/json");
    }).catch(function (error) { toast(error.message, "bad"); });
  });

  $("dlScore").addEventListener("click", function () {
    var take = STATE.take;
    if (!take || !take.has_score) return;
    getRequest(take).then(function (req) {
      downloadText(slug(displayTitle(take)) + ".abc", (req.abc || "").replace(/\n?$/, "\n"), "text/plain;charset=utf-8");
    }).catch(function (error) { toast(error.message, "bad"); });
  });

  $("rerenderSound").addEventListener("click", function () {
    var take = STATE.take;
    if (!take) return;
    var button = this;
    button.disabled = true;
    replayTake(take, { seed: randomSeed63() }, "New sound").then(function () {
      toast("Rendering " + displayTitle(take) + " again with a new sound seed…");
    }).catch(function (error) { toast(error.message, "bad"); })
      .then(function () { button.disabled = false; });
  });


  $("takeActions").addEventListener("click", function (event) {
    var take = STATE.take;
    if (!take) return;
    if (event.target.closest("#favTake")) toggleFavorite(take);
    if (event.target.closest("#renameTake")) startRename();
    if (event.target.closest("#deleteTake")) deleteTake(take);
  });

  /* ------------------------------------------------------- lyrics export */

  // Sections keep their tag line; joining every section's text gives back the
  // lyrics exactly. No timing is invented: the words are what was supplied.
  function lyricSections(lyrics) {
    var sections = [], current = null;
    lyrics.split(/(?<=\n)/).forEach(function (line) {
      var tag = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (tag || !current) {
        current = { index: sections.length, tag: tag ? tag[1].trim() : null, text: "", lyrics: "" };
        sections.push(current);
      }
      current.text += line;
      if (!tag) current.lyrics += line;
    });
    sections.forEach(function (sec) { sec.lyrics = sec.lyrics.replace(/^\s+|\s+$/g, ""); });
    return sections;
  }

  $("lyricsTxt").addEventListener("click", function () {
    var take = STATE.take;
    if (!take || !take.lyrics) return toast("Open a take first", "bad");
    downloadText(slug(displayTitle(take)) + ".lyrics.txt", take.lyrics, "text/plain;charset=utf-8");
  });

  $("lyricsJson").addEventListener("click", function () {
    var take = STATE.take;
    if (!take || !take.lyrics) return toast("Open a take first", "bad");
    var doc = { schema: "song-lyrics-v1", title: displayTitle(take), style: take.style, lyrics: take.lyrics,
                take: take.name, seed: seedText(take.lm_seed), sound_seed: seedText(take.seed),
                sections: lyricSections(take.lyrics), timing: null };
    downloadText(slug(displayTitle(take)) + ".song.json", JSON.stringify(doc, null, 2) + "\n", "application/json");
  });

  /* ------------------------------------------- take family: VAEs and sounds */
  // A re-render names the take it came from (parent), so every take knows its
  // family: the same music under other VAEs and other sound seeds.

  function familyOf(take) {
    var byName = {};
    STATE.takes.forEach(function (t) { byName[t.name] = t; });
    var rootCache = {};
    function root(t) {
      if (rootCache[t.name]) return rootCache[t.name];
      var e = t, guard = 0;
      while (e.parent && byName[e.parent] && guard++ < 64) e = byName[e.parent];
      rootCache[t.name] = e.name;
      return e.name;
    }
    var mine = root(take);
    return STATE.takes.filter(function (t) { return root(t) === mine; });
  }

  function liveReplays(take) {
    var names = {};
    familyOf(take).forEach(function (t) { names[t.name] = true; });
    return STATE.jobs.filter(function (j) { return j.kind === "replay" && isLive(j) && names[j.parent]; });
  }

  function paintDecodeSwitch() {
    var take = STATE.take;
    if (!take || STATE.vaes.length < 2) { $("decodeSwitch").innerHTML = ""; return; }
    var family = familyOf(take), pending = liveReplays(take);
    $("decodeSwitch").innerHTML = '<span class="label">VAE</span>' + STATE.vaes.map(function (v) {
      var label = escape(v.label || v.name), repo = v.repo || v.name;
      if (v.name === take.vae) {
        var held = STATE.playerTake && STATE.playerTake.name === take.name;
        return '<button type="button" class="chip is-on" aria-pressed="true" data-tip="' + escape((held ? "Playing this version\n" : "This version\n") + repo) + '">' + label + "</button>";
      }
      var twin = family.filter(function (t) { return t.vae === v.name && String(t.seed) === String(take.seed); })[0];
      if (twin) {
        return '<button type="button" class="chip" data-play-take="' + escape(twin.name) + '" aria-pressed="false" data-tip="' +
          escape("Play this version\n" + repo) + '">' + label + "</button>";
      }
      var busy = pending.some(function (j) { return j.request.vae === v.name && String(j.request.seed) === String(take.seed); });
      if (busy) return '<button type="button" class="chip ghosted" disabled>Rendering ' + label + "\u2026</button>";
      return '<button type="button" class="chip ghosted" data-add-vae="' + escape(v.name) + '" data-tip="' +
        escape("Render this take again with this VAE (seconds, same music)\n" + repo) + '">+ ' + label + "</button>";
    }).join("");
  }

  function paintSoundSwitch() {
    var take = STATE.take;
    if (!take) { $("soundSwitch").innerHTML = ""; return; }
    var seen = {}, versions = [];
    familyOf(take).filter(function (t) { return t.vae === take.vae; })
      .sort(function (a, b) { return a.created - b.created || (a.name < b.name ? -1 : 1); })
      .forEach(function (t) {
        var key = String(t.seed);
        if (seen[key]) { if (t.name === take.name) seen[key].name = t.name; return; }
        seen[key] = { seed: key, name: t.name };
        versions.push(seen[key]);
      });
    var pending = liveReplays(take).filter(function (j) { return j.request.vae === take.vae && String(j.request.seed) !== String(take.seed); });
    if (versions.length < 2 && !pending.length) { $("soundSwitch").innerHTML = ""; return; }
    $("soundSwitch").innerHTML = '<span class="label">Sound</span>' + versions.map(function (v, n) {
      var current = v.seed === String(take.seed);
      return '<button type="button" class="chip' + (current ? " is-on" : "") + '"' + (current ? "" : ' data-play-take="' + escape(v.name) + '"') +
        ' aria-pressed="' + current + '" data-tip="' + escape("Sound seed " + v.seed + "\nsame music, another grain") + '">' + (n + 1) + "</button>";
    }).join("") + (pending.length ? '<button type="button" class="chip ghosted" disabled>Rendering\u2026</button>' : "");
  }

  function onSwitchClick(event) {
    hideTip();
    var play = event.target.closest("[data-play-take]"), add = event.target.closest("[data-add-vae]");
    // Switching keeps the playback position, so A/B listening compares the same bar.
    if (play) openTake(play.dataset.playTake, { keep: true });
    if (add && STATE.take) {
      var take = STATE.take, vae = add.dataset.addVae;
      add.disabled = true;
      replayTake(take, { vae: vae }, vaeLabel(vae) + " VAE version").then(function () {
        toast("Rendering " + displayTitle(take) + " with the " + vaeLabel(vae) + " VAE…");
      }).catch(function (error) { toast(error.message, "bad"); add.disabled = false; });
    }
  }
  $("decodeSwitch").addEventListener("click", onSwitchClick);
  $("soundSwitch").addEventListener("click", onSwitchClick);

  // The same music again: the take's own replay request (codes, score, both
  // seeds) with one thing changed, and parent pointing back at the take.
  function replayTake(take, change, what) {
    return getRequest(take).then(function (req) {
      if (!req.semantic_tokens || !String(req.semantic_tokens).trim()) {
        throw new Error("This take's request carries no music codes, so it cannot be re-rendered");
      }
      var body = Object.assign({}, req);
      delete body.plan_only;
      body.lm_batch_size = 1;
      body.synth_batch_size = 1;
      Object.keys(change).forEach(function (key) { body[key] = change[key]; });
      body.parent = take.session ? "" : take.name;
      body.title = displayTitle(take);
      return submitJob(body, { kind: "replay", title: body.title, parent: take.name, what: what });
    }).then(function (job) {
      paintDecodeSwitch();
      paintSoundSwitch();
      return job;
    });
  }

  /* ------------------------------------------------------ library actions */

  function replaceTake(entry) {
    STATE.takes = STATE.takes.map(function (t) { return t.name === entry.name ? entry : t; });
    STATE.session = STATE.session.map(function (t) { return t.name === entry.name ? entry : t; });
    if (STATE.take && STATE.take.name === entry.name) {
      STATE.take = entry;
      paintTakeHead();
      paintTakeDownloads();   // named after the song: a rename renames them
    }
    if (STATE.playerTake && STATE.playerTake.name === entry.name) {
      STATE.playerTake = entry;
      $("playbarTitle").textContent = displayTitle(entry);
    }
    paintLibrary();
    paintCoverTakes();
  }

  function updateTake(take, change) {
    if (take.session) {
      var copy = Object.assign({}, take, change);
      replaceTake(copy);
      return Promise.resolve(copy);
    }
    return post("/library/update?name=" + encodeURIComponent(take.name), change).then(function (entry) {
      var fresh = entry && entry.name ? entry : Object.assign({}, take, change);
      replaceTake(fresh);
      return fresh;
    });
  }

  function toggleFavorite(take) {
    return updateTake(take, { favorite: !take.favorite }).then(function (entry) {
      toast(entry.favorite ? "Kept as a favourite: " + displayTitle(entry) : "Removed from favourites: " + displayTitle(entry));
    }).catch(function (error) { toast(error.message, "bad"); });
  }

  function startRename() {
    var take = STATE.take;
    if (!take || $("renameInput")) return;
    var heading = $("takeTitle"), input = document.createElement("input");
    input.type = "text";
    input.id = "renameInput";
    input.className = "title-edit";
    input.value = displayTitle(take);
    input.setAttribute("aria-label", "New title");
    heading.classList.add("is-hidden");
    heading.parentNode.insertBefore(input, heading.nextSibling);
    input.focus();
    input.select();
    var finished = false;
    function finish(save) {
      if (finished) return;
      finished = true;
      var value = input.value.trim();
      input.remove();
      heading.classList.remove("is-hidden");
      if (!save || !value || value === displayTitle(take)) return;
      updateTake(take, { title: value }).then(function () { toast("Renamed to " + value); })
        .catch(function (error) { toast(error.message, "bad"); });
    }
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      if (event.key === "Escape") { event.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", function () { finish(true); });
  }

  function clearTakeView() {
    STATE.take = null;
    $("takeBody").classList.add("is-hidden");
    $("takeEmpty").classList.remove("is-hidden");
    $("takeTitle").textContent = "Nothing playing";
    $("takeEyebrow").textContent = "no run yet";
    $("takeActions").innerHTML = "";
    paintRunReturn();
  }

  function clearPlayer() {
    STATE.playerTake = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    STATE.peaks = null;
    $("playbar").classList.add("is-empty");
    $("playbarTitle").textContent = "Nothing loaded";
    $("playbarTitle").dataset.tip = "Pick a take on the right";
    $("timeNow").textContent = "0:00";
    $("timeTotal").textContent = "0:00";
    drawWave();
    paintPlayHere();
    paintMp3();
  }

  function removeTake(take) {
    STATE.takes = STATE.takes.filter(function (t) { return t.name !== take.name; });
    STATE.session = STATE.session.filter(function (t) { return t.name !== take.name; });
    delete STATE.requests[take.name];
    delete STATE.peakCache[takeAudioUrl(take)];
    if (take.session && take.url) URL.revokeObjectURL(take.url);
    if (STATE.playerTake && STATE.playerTake.name === take.name) clearPlayer();
    if (STATE.take && STATE.take.name === take.name) clearTakeView();
  }

  function deleteTake(take, confirmed, quiet) {
    if (!confirmed && !window.confirm("Delete \u201c" + displayTitle(take) + "\u201d and its files?")) return Promise.resolve(false);
    var gone = take.session ? Promise.resolve() : post("/library/delete?name=" + encodeURIComponent(take.name));
    return gone.then(function () {
      removeTake(take);
      if (!quiet) { paintLibrary(); paintCoverTakes(); }
      if (!confirmed) toast("Take deleted");
      return true;
    }).catch(function (error) { toast(error.message, "bad"); return false; });
  }

  function paintDlNames() { $("dlNamesDate").setAttribute("aria-checked", libraryNames() ? "true" : "false"); }
  $("dlNamesDate").addEventListener("click", function () {
    store("yue2.dlNames", libraryNames() ? null : "library");
    paintDlNames();
    closeMenus();
    paintTakeDownloads();
    paintLibrary();
    toast(libraryNames() ? "Downloads carry the date: 20260927-183418-song-title.wav" : "Downloads are named after the song: Song Title.wav");
  });
  paintDlNames();

  $("deleteNonFav").addEventListener("click", function () {
    closeMenus();
    var doomed = STATE.takes.filter(function (t) { return !t.favorite; });
    var kept = STATE.takes.length - doomed.length;
    if (!doomed.length) return toast(STATE.takes.length ? "Every take is a favourite; nothing to delete" : "The library is empty");
    if (!window.confirm("Delete " + doomed.length + (doomed.length === 1 ? " take that is" : " takes that are") +
                        " not a favourite, with their files? " + kept + (kept === 1 ? " favourite stays." : " favourites stay."))) return;
    var chain = Promise.resolve(), count = 0;
    doomed.forEach(function (take) {
      chain = chain.then(function () { return deleteTake(take, true, true).then(function (ok) { if (ok) count++; }); });
    });
    chain.then(function () {
      paintLibrary();
      paintCoverTakes();
      toast("Deleted " + count + (count === 1 ? " take; " : " takes; ") + kept + (kept === 1 ? " favourite kept" : " favourites kept"), "good");
    });
  });

  $("refreshLib").addEventListener("click", function () {
    closeMenus();
    refreshLibrary().then(function () { toast("Library read again: " + STATE.takes.length + " takes"); })
      .catch(function (error) { toast(error.message, "bad"); });
  });

  $("favFilter").addEventListener("click", function () {
    STATE.favOnly = !STATE.favOnly;
    store("yue2.favOnly", STATE.favOnly ? "1" : null);
    paintLibrary();
  });

  /* -------------------------------------------------------------- player */

  var audio = $("audio");
  var pendingSeek = null;   // the A/B switch's "same bar" handler, while its file loads

  // The player holds its own song, apart from the song page on screen.
  STATE.playerTake = null;

  function loadPlayer(take, keepTime) {
    var at = audio.currentTime, wasPlaying = !audio.paused;
    var url = takeAudioUrl(take);
    STATE.playerTake = take;
    if (audio.getAttribute("src") !== url) {
      audio.src = url;
      if (pendingSeek) { audio.removeEventListener("loadedmetadata", pendingSeek); pendingSeek = null; }
      if (keepTime) {
        // A/B between versions of the same music: same bar, same play state
        pendingSeek = function () {
          audio.removeEventListener("loadedmetadata", pendingSeek);
          pendingSeek = null;
          try { audio.currentTime = Math.min(at, audio.duration || at); } catch (error) { /* not seekable yet */ }
          if (wasPlaying) audio.play().catch(function () {});
        };
        audio.addEventListener("loadedmetadata", pendingSeek);
      } else {
        $("timeNow").textContent = "0:00";
        paintPlayButton(false);
      }
    }
    $("playbar").classList.remove("is-empty");
    // just the name; its style prompt on hover (downloads are on the song page)
    $("playbarTitle").textContent = displayTitle(take);
    if (take.style) $("playbarTitle").dataset.tip = take.style; else $("playbarTitle").removeAttribute("data-tip");
    paintMp3();
    $("timeTotal").textContent = clock(take.seconds);
    loadPeaks(take);
    paintDecodeSwitch();
    paintPlayHere();
  }

  // "Play this song" shows when the page and the player hold different songs.
  function paintPlayHere() {
    var button = $("playHere");
    if (button) button.classList.toggle("is-hidden", !STATE.take || !!(STATE.playerTake && STATE.playerTake.name === STATE.take.name));
  }

  // Put a song in the player and start it: "Play this song" (right after the title, on the left)
  // and a double-click in the list
  function playNow(take) {
    if (!take) return;
    loadPlayer(take, false);
    audio.play().catch(function () { toast("Your browser would not play this file", "bad"); });
    paintPlayHere();
  }
  $("playHere").addEventListener("click", function () { playNow(STATE.take); });

  function togglePlay() {
    if (!audio.getAttribute("src") && STATE.take) loadPlayer(STATE.take, false);
    if (!audio.getAttribute("src")) return;
    if (audio.paused) audio.play().catch(function () { toast("Your browser would not play this file", "bad"); });
    else audio.pause();
  }

  $("playBtn").addEventListener("click", togglePlay);

  // Volume survives reloads; a browser remembering nothing is a small annoyance
  // people notice every single time.
  var storedVolume = recall("yue2.volume");
  audio.volume = storedVolume === null ? 1 : Math.min(1, Math.max(0, parseFloat(storedVolume) || 0));
  $("volume").value = audio.volume;

  function paintVolume() {
    var level = audio.muted ? 0 : audio.volume;
    $("muteGlyph").textContent = level === 0 ? "🔇" : (level < 0.5 ? "🔉" : "🔊");
    $("volume").value = level;
  }

  $("volume").addEventListener("input", function () {
    audio.volume = parseFloat(this.value);
    audio.muted = audio.volume === 0;
    store("yue2.volume", String(audio.volume));
    paintVolume();
  });

  $("muteBtn").addEventListener("click", function () {
    audio.muted = !audio.muted;
    if (!audio.muted && audio.volume === 0) audio.volume = 0.7;
    paintVolume();
  });

  paintVolume();
  // The play button's glyph, its state (the DMM theme draws icons from it) and its label for screen readers
  function paintPlayButton(playing) {
    $("playGlyph").textContent = playing ? "❚❚" : "▶";
    $("playBtn").classList.toggle("is-playing", playing);
    $("playBtn").setAttribute("aria-label", playing ? "Pause" : "Play");
  }
  audio.addEventListener("play", function () { paintPlayButton(true); markPlaying(); });
  audio.addEventListener("pause", function () { paintPlayButton(false); markPlaying(); });
  audio.addEventListener("ended", function () { paintPlayButton(false); markPlaying(); });
  audio.addEventListener("emptied", markPlaying);

  // The card of the song that is playing says so (the list redraws often, so this runs after it too)
  function markPlaying() {
    var name = isPlaying() && STATE.playerTake ? STATE.playerTake.name : "";
    all("#libList .take[data-name]").forEach(function (card) {
      card.classList.toggle("is-playing", !!name && card.dataset.name === name);
    });
    paintStatus();
  }

  // The player bar's status: Rendering or Queued while a song is being made (a click shows the run),
  // Playing or Paused for the song in the player (a click opens it), else Idle.
  function paintStatus() {
    var job = STATE.running, pill = $("statusPill"), s = "idle", text = "Idle", tip = "Nothing is being made or played";
    if (job && job.status === "queued") { s = "queued"; text = "Queued"; tip = "Waiting to start: " + job.title + ". Click to watch it"; }
    else if (job) { s = "rendering"; text = "Rendering"; tip = "Making " + job.title + ". Click to watch it"; }
    else if (isPlaying() && STATE.playerTake) { s = "playing"; text = "Playing"; tip = "Playing " + displayTitle(STATE.playerTake) + ". Click to open it"; }
    else if (STATE.playerTake && audio.getAttribute("src")) { s = "paused"; text = "Paused"; tip = displayTitle(STATE.playerTake) + " is paused. Click to open it"; }
    pill.dataset.s = s;
    pill.dataset.tip = tip;
    $("statusText").textContent = text;
  }
  $("statusPill").addEventListener("click", function () {
    var s = this.dataset.s;
    if ((s === "rendering" || s === "queued") && STATE.running) $("backToRun").click();
    else if ((s === "playing" || s === "paused") && STATE.playerTake) openTake(STATE.playerTake.name);
  });
  audio.addEventListener("timeupdate", function () {
    $("timeNow").textContent = clock(audio.currentTime);
    drawWave();
  });
  audio.addEventListener("loadedmetadata", function () {
    if (!isFinite(audio.duration)) return;
    $("timeTotal").textContent = clock(audio.duration);
    if (STATE.take && !STATE.take.seconds) { STATE.take.seconds = audio.duration; paintTakeMeta(); }
  });

  $("wave").addEventListener("click", function (event) {
    var rect = this.getBoundingClientRect();
    var ratio = (event.clientX - rect.left) / rect.width;
    if (isFinite(audio.duration)) audio.currentTime = ratio * audio.duration;
  });

  // The server reads the audio once and caches 900 peak values per take. The
  // browser decode below is only the fallback: a take kept in this tab, or a
  // server without the peaks route.
  function loadPeaks(take) {
    var url = takeAudioUrl(take);
    STATE.peaks = STATE.peakCache[url] || null;
    drawWave();
    if (STATE.peaks || STATE.peakLoading[url]) return;
    STATE.peakLoading[url] = true;
    var fromServer = take.session ? Promise.reject(new Error("kept in this tab"))
      : api("/library/peaks?name=" + encodeURIComponent(take.name)).then(function (data) {
          if (!data || !Array.isArray(data.peaks) || !data.peaks.length) throw new Error("no peaks");
          return Float32Array.from(data.peaks);
        });
    fromServer.catch(function () {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error(r.status + "");
        return r.arrayBuffer();
      }).then(decodePeaks);
    }).then(function (peaks) {
      STATE.peakCache[url] = peaks;
      var keys = Object.keys(STATE.peakCache);
      if (keys.length > 80) delete STATE.peakCache[keys[0]];
      if (STATE.playerTake && takeAudioUrl(STATE.playerTake) === url) { STATE.peaks = peaks; drawWave(); }
    }).catch(function () {
      if (STATE.playerTake && takeAudioUrl(STATE.playerTake) === url) { STATE.peaks = "none"; drawWave(); }
    }).then(function () { delete STATE.peakLoading[url]; });
  }

  function decodePeaks(buffer) {
    var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return Promise.reject(new Error("no decoder"));
    var context = new Offline(2, 1, 48000);
    return context.decodeAudioData(buffer).then(function (decoded) {
      var left = decoded.getChannelData(0), right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;
      var buckets = 900, size = Math.max(1, Math.floor(left.length / buckets)), peaks = new Float32Array(buckets);
      for (var i = 0; i < buckets; i++) {
        var max = 0, start = i * size, end = Math.min(left.length, start + size);
        for (var j = start; j < end; j += 2) {
          var value = Math.max(Math.abs(left[j]), Math.abs(right[j]));
          if (value > max) max = value;
        }
        peaks[i] = max;
      }
      return peaks;
    });
  }

  function drawWave() {
    var canvas = $("wave");
    if (!canvas.clientWidth) return;
    var dpr = window.devicePixelRatio || 1;
    var width = canvas.clientWidth, height = canvas.clientHeight || 40;
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    var middle = height / 2;
    ctx.strokeStyle = themeRGBA("ink", 0.08);
    ctx.beginPath();
    ctx.moveTo(0, middle + 0.5);
    ctx.lineTo(width, middle + 0.5);
    ctx.stroke();

    // the waveform belongs to the song in the player, whatever the page is showing (a run, another take)
    if (!STATE.playerTake) return;
    var progress = (isFinite(audio.duration) && audio.duration > 0) ? audio.currentTime / audio.duration : 0;

    if (!STATE.peaks || STATE.peaks === "none") {
      ctx.fillStyle = themeRGBA("ink", 0.22);
      ctx.font = '11px "IBM Plex Mono", monospace';
      ctx.fillText(STATE.peaks === "none" ? "no waveform for this file" : "reading waveform…", 12, middle + 4);
    } else {
      var peaks = STATE.peaks, bars = Math.min(peaks.length, Math.floor(width / 3));
      var step = peaks.length / bars;
      for (var i = 0; i < bars; i++) {
        var value = peaks[Math.floor(i * step)];
        var barHeight = Math.max(1.5, value * (height - 10));
        var x = i * (width / bars);
        ctx.fillStyle = (i / bars) <= progress ? themeRGBA("amber", 1) : themeRGBA("ink", 0.24);
        ctx.fillRect(x, middle - barHeight / 2, Math.max(1, width / bars - 1), barHeight);
      }
    }

    if (progress > 0) {
      ctx.fillStyle = themeRGBA("ink", 1);
      ctx.fillRect(progress * width - 0.5, 4, 1.5, height - 8);
    }
  }

  window.addEventListener("resize", drawWave);

  /* -------------------------------------------------------------- library */

  var libraryAsk = 0;
  function refreshLibrary() {
    if (!STATE.library) {
      STATE.takes = STATE.session.slice();
      paintLibrary();
      paintCoverTakes();
      return Promise.resolve();
    }
    var ask = ++libraryAsk;
    return api("/library").then(function (data) {
      if (ask !== libraryAsk) return;   // an older reply landing after a newer one
      STATE.takes = STATE.session.concat((data && data.takes) || []);
      if (STATE.take) {
        var fresh = findTake(STATE.take.name);
        if (fresh) { STATE.take = fresh; paintTakeHead(); paintTakeMeta(); }
      }
      paintLibrary();
      paintCoverTakes();
      if (STATE.take) { paintDecodeSwitch(); paintSoundSwitch(); }
    });
  }

  function markActive() {
    var name = STATE.take ? STATE.take.name : null;
    all("#libList .take[data-name]").forEach(function (card) { card.classList.toggle("is-active", card.dataset.name === name); });
  }

  function paintLibrary() {
    var list = $("libList");
    var shown = STATE.favOnly ? STATE.takes.filter(function (t) { return t.favorite; }) : STATE.takes;
    $("libCount").textContent = STATE.favOnly ? shown.length + " / " + STATE.takes.length : String(STATE.takes.length);
    $("favFilter").setAttribute("aria-pressed", STATE.favOnly ? "true" : "false");

    // A run in progress sits at the top of the list, so it is never lost.
    var running = STATE.jobs.filter(function (j) { return isLive(j) && !j.provisional && j.kind !== "transcribe"; }).map(function (job) {
      var stage = currentStage(job);
      var what = job.kind === "replay" ? (job.what || "re-rendering") + " — click for the take"
        : (job.status === "queued" ? "queued — click to watch" : "generating now — click to watch");
      return '<article class="take is-running-row" data-run="' + escape(job.id) + '" tabindex="0">' +
        '<div class="take-title">' + escape(job.title) + "</div>" +
        '<div class="take-style">' + escape(what) + "</div>" +
        '<div class="take-foot"><span class="tag full">' + (job.status === "queued" ? "queued" : "running") + "</span>" +
        (stage ? "<span>" + escape(stage.label) + "</span>" : "") + "</div></article>";
    }).join("");

    if (!shown.length) {
      var empty = STATE.favOnly ? "No favourites yet.<br>Tap ☆ on a take to keep it here."
        : (STATE.library ? "No takes yet.<br>Every finished song lands here."
                         : "The server keeps no library (start it with --outputs).<br>Songs made in this tab stay until it reloads.");
      list.innerHTML = running + '<div class="lib-empty">' + empty + "</div>";
      return;
    }
    list.innerHTML = running + shown.map(function (take) {
      var active = STATE.take && STATE.take.name === take.name ? " is-active" : "";
      var title = displayTitle(take), tags = '<span class="tag ' + escape(take.cot || "off") + '">' + escape(take.cot || "?") + "</span>";
      if (take.vae && take.vae !== STATE.defaultVae) tags += '<span class="tag vae">' + escape(vaeLabel(take.vae)) + "</span>";
      if (take.song > 0 && !/ · v\d+/.test(title)) tags += '<span class="tag">v' + (take.song + 1) + "</span>";
      if (take.variation > 0 && !/ · sound \d+/.test(title)) tags += '<span class="tag">sound ' + (take.variation + 1) + "</span>";
      if (take.format === "mp3") tags += '<span class="tag">mp3</span>';
      if (take.parent) tags += '<span class="tag re" title="Re-rendered from another take: same music">re-render</span>';
      return '<article class="take' + active + (take.favorite ? " is-fav" : "") + '" data-name="' + escape(take.name) + '" tabindex="0">' +
        '<button type="button" class="take-fav" data-fav="' + escape(take.name) + '" aria-pressed="' + (take.favorite ? "true" : "false") +
        '" title="' + (take.favorite ? "Remove from favourites" : "Keep as a favourite") + '" aria-label="Favourite">' + (take.favorite ? "★" : "☆") + "</button>" +
        '<button type="button" class="take-del" data-del="' + escape(take.name) + '" title="Delete take" aria-label="Delete take">✕</button>' +
        '<a class="take-dl" data-dl="1" href="' + escape(downloadUrl(take)) + '" download="' + escape(audioFileName(take)) +
        '" title="Download ' + formatExt(take.format).toUpperCase() + '" aria-label="Download">⤓</a>' +
        (!convertible(take) ? "" : '<a class="take-mp3" data-dl="1" href="' + escape(mp3Url(take)) + '" download="' + escape(fileTitle(take)) +
        '.mp3" title="Download MP3 (' + mp3Rate() + ' kbps)" aria-label="Download MP3">mp3</a>') +
        '<div class="take-title">' + escape(title) + "</div>" +
        '<div class="take-style">' + escape(take.style || "") + "</div>" +
        '<div class="take-foot"><span class="tag playing-tag">playing</span>' + tags + "<span>" + clock(take.seconds) + "</span><span>" +
        ago(take.created) + "</span></div></article>";
    }).join("");
    markPlaying();
  }

  $("libList").addEventListener("click", function (event) {
    if (event.target.closest("[data-dl]")) { event.stopPropagation(); return; }   // download, do not open
    var fav = event.target.closest("[data-fav]"), del = event.target.closest("[data-del]");
    if (fav) {
      event.stopPropagation();
      var favTake = findTake(fav.dataset.fav);
      if (favTake) toggleFavorite(favTake);
      return;
    }
    if (del) {
      event.stopPropagation();
      var take = findTake(del.dataset.del);
      if (take) deleteTake(take);
      return;
    }
    var card = event.target.closest(".take");
    if (!card) return;
    if (card.dataset.run) return openRunRow(card.dataset.run);
    openTake(card.dataset.name);
    // A double-click plays the song (renaming is the song page's Rename button). It is read from the
    // second click itself: the first click redraws the list, and the browser then sends no dblclick.
    if (event.detail === 2) playNow(findTake(card.dataset.name));
  });

  $("libList").addEventListener("keydown", function (event) {
    var card = event.target.closest(".take");
    if (!card || event.target.closest("button")) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (card.dataset.run) openRunRow(card.dataset.run); else openTake(card.dataset.name);
    }
  });

  function openRunRow(id) {
    var job = jobById(id);
    if (!job) return;
    if (job.kind === "replay") {
      if (findTake(job.parent)) openTake(job.parent);
      return;
    }
    watchJob(job);
    show("take");
  }

  /* ---------------------------------------------------------------- cover */

  function paintCoverTakes() {
    var scored = STATE.takes.filter(function (t) { return t.has_score; });
    var current = $("coverTake").value;
    $("coverTake").innerHTML = scored.length
      ? scored.map(function (t) { return '<option value="' + escape(t.name) + '">' + escape(displayTitle(t)) + "</option>"; }).join("")
      : '<option value="">no take has a score yet</option>';
    if (current && scored.some(function (t) { return t.name === current; })) $("coverTake").value = current;
    $("coverFromTake").disabled = !scored.length;
    if (!$("coverStatus").dataset.note) {
      $("coverStatus").textContent = scored.length
        ? scored.length + (scored.length === 1 ? " take carries" : " takes carry") + " a score you can remix."
        : "Make a song in Full plan or Melody only mode first; Direct mode keeps no score.";
    }
  }

  // "Dm"-style chord symbols go, so a cover's accompaniment can be rebuilt.
  // Information fields quote things too -- V: lines carry name="Vocal Melody" --
  // so only music lines are touched, or the header would lose its voice names.
  function stripChordSymbols(abc) {
    return abc.split("\n").map(function (line) {
      if (/^\s*[A-Za-z]:/.test(line) || /^\s*%/.test(line)) return line;
      return line.replace(/"[^"\n]*"/g, "");
    }).join("\n");
  }

  // Keep one voice of a score: its declaration in the header and its lines
  // in the body. Section comments stay, since they belong to every voice.
  function keepVoice(abc, keep) {
    var out = [], inHeader = true, current = null;
    abc.split("\n").forEach(function (line) {
      var voice = line.match(/^\s*V:\s*([^\s]+)/);
      if (inHeader) {
        if (/^\s*K:/.test(line)) { inHeader = false; out.push(line); return; }
        if (voice && voice[1] !== keep) return;
        out.push(line);
        return;
      }
      if (voice) { current = voice[1]; if (current === keep) out.push(line); return; }
      if (/^\s*%/.test(line)) { out.push(line); return; }
      if (current !== null && current !== keep) return;
      out.push(line);
    });
    return out.join("\n");
  }

  function applyCoverScore(abc, note, cot) {
    $("abc").value = abc;
    setCodes(null);
    setCot(cot || "melody");
    $("scoreDrawer").open = true;
    $("coverStatus").textContent = note;
    $("coverStatus").dataset.note = "1";
    toast(note, "good");
  }

  $("coverFromTake").addEventListener("click", function () {
    var take = findTake($("coverTake").value);
    if (!take) return toast("No take has a score to cover yet", "bad");
    getRequest(take).then(function (req) {
      var abc = req.abc || "";
      if (!abc) throw new Error("That take carries no score");
      if ($("coverMelodyOnly").checked) abc = stripChordSymbols(abc);
      if (!$("lyrics").value.trim()) { $("lyrics").value = take.lyrics || ""; growLyrics(); }
      applyCoverScore(abc, "Melody loaded from \u201c" + displayTitle(take) + "\u201d. Now write the new style and generate.");
    }).catch(function (error) { toast(error.message, "bad"); });
  });

  // WAV and MP3 go up as they are. Anything else the browser can play is
  // decoded here and sent as mono 24 kHz WAV, the rate the transcriber uses.
  function prepareAudio(file) {
    var ext = (file.name.split(".").pop() || "").toLowerCase();
    if (ext === "wav" || ext === "mp3") return Promise.resolve(file);
    var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return Promise.reject(new Error("This browser cannot convert ." + ext + "; use WAV or MP3"));
    return file.arrayBuffer().then(function (buffer) {
      return new Offline(1, 1, 24000).decodeAudioData(buffer);
    }).then(function (decoded) {
      var length = decoded.length, mono = new Float32Array(length);
      for (var c = 0; c < decoded.numberOfChannels; c++) {
        var data = decoded.getChannelData(c);
        for (var i = 0; i < length; i++) mono[i] += data[i] / decoded.numberOfChannels;
      }
      return new Blob([wav16(mono, decoded.sampleRate)], { type: "audio/wav" });
    }).catch(function (error) {
      throw new Error("Could not read " + file.name + " in the browser (" + (error.message || error) + "). Convert it to WAV or MP3.");
    });
  }

  function wav16(samples, rate) {
    var buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
    var text = function (offset, value) { for (var i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE");
    text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, "data"); view.setUint32(40, samples.length * 2, true);
    for (var i = 0; i < samples.length; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  // Listen to the chosen recording before transcribing it. It has its own player, so the one at the bottom
  // keeps its song; starting either one pauses the other.
  var preview = new Audio(), previewUrl = "";
  preview.preload = "metadata";
  function paintListen() {
    var button = $("coverListen"), on = !preview.paused;
    button.disabled = !previewUrl;
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.textContent = on ? "❚❚ " + clock(preview.currentTime) + " / " + clock(isFinite(preview.duration) ? preview.duration : 0) : "▶ Listen";
  }
  $("coverFile").addEventListener("change", function () {
    preview.pause();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    var file = this.files[0];
    previewUrl = file ? URL.createObjectURL(file) : "";
    if (previewUrl) preview.src = previewUrl; else preview.removeAttribute("src");
    paintListen();
  });
  $("coverListen").addEventListener("click", function () {
    if (!previewUrl) return;
    if (!preview.paused) { preview.pause(); return; }
    if (!audio.paused) audio.pause();
    preview.play().catch(function () {
      toast("This browser cannot play " + (($("coverFile").files[0] || {}).name || "this file") + "; it can still be transcribed", "bad");
    });
  });
  ["play", "pause", "ended", "timeupdate", "loadedmetadata"].forEach(function (name) { preview.addEventListener(name, paintListen); });
  audio.addEventListener("play", function () { preview.pause(); });
  $("coverDrawer").addEventListener("toggle", function () { if (!this.open) preview.pause(); });

  var coverTicker = 0;

  $("coverFromAudio").addEventListener("click", function () {
    if (!STATE.transcriber) return toast("The server runs without a transcriber (start it with --transcriber)", "bad");
    var file = $("coverFile").files[0];
    if (!file) return toast("Choose a recording first", "bad");
    var task = $("coverTask").value, button = this;
    button.disabled = true;
    $("coverAudioStatus").dataset.busy = "1";
    $("coverAudioStatus").textContent = "Reading " + file.name + "…";
    prepareAudio(file).then(function (blob) {
      var form = new FormData();
      form.append("audio", blob, blob === file ? file.name : file.name.replace(/\.[^.]+$/, "") + ".wav");
      if (task !== "full") form.append("melody_only", "1");
      return api("/transcribe", { method: "POST", body: form });
    }).then(function (data) {
      var job = registerJob(data.id, { kind: "transcribe", title: file.name, task: task, fileName: file.name }, {});
      clearInterval(coverTicker);
      coverTicker = setInterval(function () {
        if (!isLive(job)) { clearInterval(coverTicker); return; }
        $("coverAudioStatus").textContent = job.status === "queued"
          ? "Waiting for the server" + (activeJob() ? " (it is busy with " + activeJob().title + ")" : "") + "…"
          : "Transcribing " + file.name + "… " + Math.round((Date.now() - (job.started || job.submitted)) / 1000) + "s";
      }, 500);
    }).catch(function (error) {
      delete $("coverAudioStatus").dataset.busy;
      $("coverAudioStatus").textContent = error.message;
      toast(error.message, "bad");
      button.disabled = !STATE.transcriber;
    });
  });

  function finishTranscription(job) {
    api("/job?id=" + encodeURIComponent(job.id) + "&result=1").then(function (data) {
      var abc = (data && data.abc) || "";
      if (!abc) throw new Error("The transcriber returned no score");
      if (job.task === "melody-vocal") abc = keepVoice(abc, "Vocal");
      var mode = job.task === "full" ? "full" : "melody";
      var seconds = job.started ? Math.round(((job.finished || Date.now()) - job.started) / 1000) : null;
      applyCoverScore(abc, "Transcribed " + job.fileName + (seconds !== null ? " in " + seconds + "s" : "") +
        ". Check the melody under Supply your own score, then write the new lyrics and style.", mode);
      $("coverAudioStatus").textContent = "Done: " + job.fileName + " → score loaded (" +
        (mode === "full" ? "Full plan, chords kept" : job.task === "melody-vocal" ? "Melody only, vocal line" : "Melody only") + ").";
    }).catch(function (error) {
      transcriptionFailed(job, error.message);
      toast(error.message, "bad");
    }).then(function () {
      clearInterval(coverTicker);
      delete $("coverAudioStatus").dataset.busy;
      $("coverFromAudio").disabled = !STATE.transcriber;
    });
  }

  function transcriptionFailed(job, message) {
    clearInterval(coverTicker);
    delete $("coverAudioStatus").dataset.busy;
    $("coverAudioStatus").textContent = message;
    $("coverFromAudio").disabled = !STATE.transcriber;
  }

  /* ----------------------------------------------------------------- writer */
  // Any local chat server with a /v1 endpoint writes the brief. It is used as it
  // is: the model the server has loaded answers. This page never names a model
  // the server would have to load, and never loads, switches or unloads one.

  var MUSE_SCHEMA = {
    type: "object",
    properties: {
      title: { type: "string", description: "Song title, two to four words, no quotes" },
      style: { type: "string", description:
        "One comma-separated line naming, in order: language, genre and mood, voice type, two to four instruments, " +
        "phrasing, and a tempo in BPM. Never a sentence. Example: 'English, warm piano pop, expressive female voice, " +
        "acoustic piano, rounded bass and light drums, unhurried phrasing, 88 BPM'" },
      lyrics: { type: "string", description:
        "A complete song of 24 to 32 sung lines using [Verse], [Chorus] and [Bridge] tags, each tag alone on its line, " +
        "the chorus repeated word for word. No title line, no commentary" }
    },
    required: ["title", "style", "lyrics"]
  };

  var MUSE_SYSTEM = [
    "You write briefs for YuE2, a song generation model.",
    "",
    "You are given a one-line idea. Return exactly three fields: title, style and lyrics.",
    "",
    "style is a control string, not prose. It is a single comma-separated line listing,",
    "in this order: language, genre and mood, voice type, two to four instruments,",
    "phrasing, tempo in BPM. Write it the way a producer writes a track sheet.",
    "",
    "Good style: English, warm piano pop, expressive female voice, acoustic piano, rounded bass and light drums, unhurried phrasing, 88 BPM",
    "Good style: Mandarin, late-night jazz ballad, smoky male voice, upright bass, brushed drums, Rhodes, laid-back phrasing, 72 BPM",
    "Bad style: instruments",
    "Bad style: A beautiful song about love that features piano.",
    "",
    "lyrics must be a COMPLETE song, never a sketch. The user's message gives the",
    "section order to follow; follow it exactly, in that order, with no extra sections.",
    "",
    "Rules for lyrics:",
    "- Four to eight words per line, singable in one breath.",
    "- Each section tag sits alone on its own line, spelled exactly as given.",
    "- Repeat the chorus verbatim every time; never reword it.",
    "- A pre-chorus is two lines that lift into the chorus, the same both times.",
    "- Write in the language named in style.",
    "- No title line, no commentary, no explanations.",
    "",
    "Write like a person who was there, not like a machine describing a mood.",
    "",
    "- Name concrete things: an object, a place, a time, something someone did.",
    "  \"Your coat still on the hook\" beats \"memories of you\".",
    "- One image per line, and let it carry the feeling instead of naming it.",
    "  Write the evidence, not the emotion.",
    "- Never use these, in any language: neon, echoes, whispers, dancing shadows,",
    "  city lights, fading light, endless night, burning desire, fire inside,",
    "  broken heart, shattered dreams, breaking chains, spreading wings, endless",
    "  road, chasing dreams, weathering the storm, hidden scars, lost in time,",
    "  rising from the ashes, standing tall, feeling alive.",
    "- Avoid rhyming on fire/desire, night/light, heart/apart, rain/pain.",
    "",
    "title must never be empty.",
    "",
    "This is the exact shape of the lyrics field, tags included:",
    "",
    "[Verse]",
    "Neon fades along the lane",
    "Footsteps keep the time of rain",
    "[Chorus]",
    "Let the day come into view",
    "Every road begins with you",
    "",
    "Answer with JSON only. No commentary, no markdown fences."
  ].join("\n");

  var RETRY_NOTE = "Your previous answer had no section tags. Rewrite the lyrics with the section " +
    "order given above, each tag alone on its own line, spelled exactly as shown, " +
    "for example a line containing only [Chorus].";

  var CLICHE_NOTE = "Your previous answer used these worn-out phrases: %s. Rewrite the lyrics " +
    "without them and without any near-synonym of them. Replace each one with a " +
    "concrete detail: a named object, a place, a time of day, or something " +
    "somebody actually does. Keep the same structure, section tags and language.";

  // The score vocabulary documents verse, chorus, bridge and interlude. Pre-chorus,
  // intro and outro are passed through as written and are not attested tags.
  var STRUCTURES = {
    simple: ["[Verse]", "[Chorus]", "[Verse]", "[Chorus]"],
    bridge: ["[Verse]", "[Chorus]", "[Verse]", "[Chorus]", "[Bridge]", "[Chorus]"],
    prechorus: ["[Verse]", "[Pre-Chorus]", "[Chorus]", "[Verse]", "[Pre-Chorus]", "[Chorus]", "[Bridge]", "[Chorus]"],
    full: ["[Intro]", "[Verse]", "[Pre-Chorus]", "[Chorus]", "[Verse]", "[Pre-Chorus]", "[Chorus]", "[Bridge]", "[Chorus]", "[Outro]"]
  };

  // Phrases people name when a song sounds machine-written; the worst ones
  // are worth a rewrite on their own, the rest only in bulk.
  var CLICHES = [
    "neon", "echoes", "echo of", "whisper", "shadows dance", "dancing in the shadow",
    "dance in the shadow", "chasing shadows", "city lights",
    "fading light", "endless night", "into the night", "dead of night",
    "burning bright", "blinding light", "silver moon", "moonlit",
    "burning desire", "fire inside", "hearts on fire", "flames of",
    "rise from the ashes", "phoenix", "set the night on fire",
    "broken heart", "shattered dreams", "shattered glass", "picking up the pieces",
    "break these chains", "breaking free", "spread my wings", "silent scream",
    "endless road", "path unknown", "long road", "chasing dreams", "no turning back",
    "weather the storm", "drowning in", "eye of the storm", "tears like rain", "storm inside",
    "hidden scars", "unseen tears", "lost in time", "memories fade", "frozen in time",
    "against all odds", "rise again", "stand tall", "feel alive", "come alive",
    "electric dreams", "concrete jungle", "velvet sky", "crimson sky",
    "neonlicht", "neonlichter", "im schatten tanz", "tanz im schatten",
    "zerbrochene träume", "gebrochenes herz", "ketten sprengen",
    "asche", "flügel", "sterne verglühen", "endlose nacht", "im regen stehen"
  ];
  var WORST = ["neon", "echoes", "whisper", "shadows dance", "dancing in the shadow", "city lights", "neonlicht", "neonlichter"];

  function findCliches(text) {
    var lowered = String(text).toLowerCase(), found = {};
    CLICHES.forEach(function (phrase) { if (lowered.indexOf(phrase) >= 0) found[phrase] = true; });
    return Object.keys(found).sort();
  }

  function hasSections(lyrics) {
    return String(lyrics).split(/\r?\n/).some(function (line) { return line.trim().charAt(0) === "["; });
  }

  function structureRequest(structure) {
    var sections = STRUCTURES[structure] || STRUCTURES.bridge, lines = ["\n\nSection order, exactly:"];
    sections.forEach(function (section) {
      if (section === "[Intro]" || section === "[Outro]") lines.push(section + " — instrumental: write the tag alone, with no words under it");
      else if (section === "[Bridge]") lines.push("[Bridge] — two to four lines, new words");
      else if (section === "[Pre-Chorus]") lines.push("[Pre-Chorus] — two lines, identical each time");
      else if (section === "[Chorus]") lines.push("[Chorus] — four lines, identical each time");
      else lines.push("[Verse] — four lines, new words each time");
    });
    return lines.join("\n");
  }

  function stripThinking(text) {
    var open = "<think>", close = "</think>";
    while (text.indexOf(open) >= 0 && text.indexOf(close) > text.indexOf(open)) {
      text = text.slice(0, text.indexOf(open)) + text.slice(text.indexOf(close) + close.length);
    }
    text = text.trim();
    var fence = text.match(/^```(?:json)?\s*([\s\S]*?)```$/);
    return fence ? fence[1].trim() : text;
  }

  var CHAT = { status: null };

  function chatBase() {
    var url = ($("chatUrl").value || "").trim().replace(/\/+$/, "");
    ["/chat/completions", "/models"].forEach(function (suffix) {
      if (url.slice(-suffix.length) === suffix) url = url.slice(0, -suffix.length);
    });
    if (url && !/^https?:\/\//i.test(url)) url = "http://" + url;
    if (url && url.slice(-3) !== "/v1") url += "/v1";
    return url;
  }

  function chatCall(url, payload, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 900000);
    var options = { signal: controller.signal };
    if (payload !== undefined) {
      options.method = "POST";
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(payload);
    }
    return fetch(url, options).then(function (r) {
      return r.text().then(function (text) {
        if (!r.ok) {
          var failure = new Error("HTTP " + r.status + (text ? ": " + text.slice(0, 200) : ""));
          failure.status = r.status;
          throw failure;
        }
        return text ? JSON.parse(text) : {};
      });
    }).then(function (data) { clearTimeout(timer); return data; }, function (error) { clearTimeout(timer); throw error; });
  }

  function unreachable(base) {
    return "The browser could not reach " + base + ". Either the chat server is not running, or it refuses " +
      "requests from this page (CORS): turn CORS on in its settings, or open this page from the same machine name.";
  }

  // Reachability and the loaded model, without asking the server to load anything.
  function chatStatus() {
    var base = chatBase();
    if (!base) return Promise.resolve({ configured: false, available: false, models: [], loaded: null, use: null });
    var root = base.slice(0, -3);
    var status = { configured: true, available: false, models: [], loaded: null, use: null, base: base };
    return chatCall(base + "/models", undefined, 3000).then(function (data) {
      status.available = true;
      status.models = ((data && data.data) || []).map(function (m) { return m.id || ""; });
    }).catch(function (error) {
      status.error = error.status ? error.message : unreachable(base);
      throw status;
    }).then(function () {
      // Runners that list every downloaded model report which one is in memory
      // on a native endpoint; asking for any other would make them load it.
      return chatCall(root + "/api/v0/models", undefined, 3000).then(function (data) {
        status.loaded = ((data && data.data) || []).filter(function (m) { return m.state === "loaded"; }).map(function (m) { return m.id || ""; });
      }).catch(function () {
        // Another common runner lists what is in memory under /api/ps.
        return chatCall(root + "/api/ps", undefined, 3000).then(function (data) {
          if (data && Array.isArray(data.models)) {
            status.loaded = data.models.map(function (m) { return m.model || m.name || ""; }).filter(Boolean);
          }
        }).catch(function () {});
      });
    }).then(function () {
      status.use = status.loaded !== null ? (status.loaded[0] || null) : (status.models[0] || null);
      return status;
    }).catch(function (failed) {
      if (failed === status) return status;
      throw failed;
    });
  }

  function paintChat(status) {
    var pill = $("chatState");
    pill.textContent = !status.configured ? "not set" : (!status.available ? "not answering" : (status.use ? "ready" : "no model loaded"));
    pill.dataset.s = status.use ? "ready" : (status.configured ? "bad" : "missing");
    $("chatHint").textContent = status.use
      ? "Loaded now: " + status.use + ". This page uses it as is and never loads, switches or unloads a model."
      : (status.available ? "The server answers but reports no loaded model. Load one there first."
         : (status.error || "Uses whatever model the server has loaded. This page never loads, switches or unloads a model on it."));
    $("museModel").innerHTML = status.use
      ? escape(status.use) + ' <span class="dim">loaded on the chat server</span>'
      : '<span class="dim">none yet · ' + (!status.configured ? "set the chat server under Engine"
        : (status.available ? "load a model in the chat server" : "the chat server is not answering")) + "</span>";
    $("museBtn").disabled = !status.use;
    // the state is the Chat Server button; what to do about it is its tip
    var link = $("chatLink");
    link.dataset.s = status.available ? "on" : "off";
    link.dataset.tip = !status.configured ? "Set the chat server address under Engine"
      : (!status.available ? "The chat server is not answering — check its address under Engine"
        : (status.use ? "Loaded now: " + status.use : "The server answers but has no model loaded: load one there first")) + ". Click to check again.";
    if (tipFor === link) showTip(link);
    if (!$("museBtn").dataset.busy || $("museBtn").dataset.busy === "0") {
      $("museStatus").textContent = "";
      $("museStatus").classList.remove("bad");
    }
  }

  function refreshChat() {
    return chatStatus().then(function (status) { paintChat(status); return status; });
  }

  // Structured output first, then plain chat, then the system turn folded into
  // the user turn for templates that reject one. Only a refused request is
  // worth another shape.
  function chatComplete(messages, model, maxTokens, schema) {
    var payload = { model: model, messages: messages, temperature: 0.9, top_p: 0.95, max_tokens: maxTokens, stream: false };
    var attempts = [];
    if (schema) attempts.push(Object.assign({}, payload, { response_format: { type: "json_schema", json_schema: { name: "brief", schema: schema } } }));
    attempts.push(payload);
    var system = messages.filter(function (m) { return m.role === "system"; }).map(function (m) { return m.content; }).join("\n\n");
    var rest = messages.filter(function (m) { return m.role !== "system"; });
    if (system && rest.length) {
      attempts.push(Object.assign({}, payload, { messages: [Object.assign({}, rest[0], { content: system + "\n\n" + rest[0].content })].concat(rest.slice(1)) }));
    }
    var base = chatBase(), n = 0;
    function next(lastError) {
      if (n >= attempts.length) return Promise.reject(lastError);
      var attempt = attempts[n++];
      return chatCall(base + "/chat/completions", attempt).catch(function (error) {
        if (error.status && error.status >= 400 && error.status < 500) return next(error);
        if (!error.status) throw new Error(unreachable(base));
        throw error;
      });
    }
    return next(null);
  }

  $("chatUrl").value = recall("yue2.chatUrl") || "";
  $("chatUrl").addEventListener("change", function () {
    store("yue2.chatUrl", this.value.trim() || null);
    refreshChat().catch(function () {});
  });

  $("chatTest").addEventListener("click", function () {
    var button = this;
    button.disabled = true;
    store("yue2.chatUrl", $("chatUrl").value.trim() || null);
    var started = performance.now();
    refreshChat().then(function (status) {
      if (!status.configured) throw new Error("Type the chat server's address first");
      if (!status.available) throw new Error(status.error || "The chat server is not answering");
      if (!status.use) throw new Error("No model is loaded in the chat server; load one there (this page never loads one)");
      started = performance.now();
      return chatComplete([{ role: "user", content: "Reply with the single word OK." }], status.use, 8).then(function (response) {
        var reply = ((((response.choices || [])[0] || {}).message || {}).content || "").trim().slice(0, 40);
        toast("Chat server OK: " + status.use + " answered \u201c" + reply + "\u201d in " + ((performance.now() - started) / 1000).toFixed(2) + " s", "good");
      });
    }).catch(function (error) { toast(error.message, "bad"); })
      .then(function () { button.disabled = false; });
  });

  $("chatLink").addEventListener("click", function () { refreshChat().catch(function () {}); });

  $("museDrawer").addEventListener("toggle", function () {
    if (this.open) paintStructureHint();
    if (this.open) refreshChat().catch(function () {});
  });

  $("idea").addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); writeBrief(); }   // Shift+Enter: a new line
  });
  $("museBtn").addEventListener("click", writeBrief);

  $("autoRun").checked = recall("yue2.autorun") === "1";
  $("autoRun").addEventListener("change", function () { store("yue2.autorun", this.checked ? "1" : "0"); });

  function writeBrief() {
    var idea = $("idea").value.trim();
    if (!idea) { $("idea").focus(); return toast("Describe the song in a line first", "bad"); }
    var button = $("museBtn"), started = Date.now(), model = null;
    button.dataset.busy = "1";
    $("museLabel").textContent = $("autoRun").checked ? "Writing, then generating…" : "Writing…";
    $("museStatus").classList.remove("bad");
    $("museStatus").textContent = "asking the chat server";
    var ticker = setInterval(function () {
      $("museStatus").textContent = "writing… " + Math.round((Date.now() - started) / 1000) + "s";
    }, 1000);
    var messages = [{ role: "system", content: MUSE_SYSTEM },
                    { role: "user", content: "Idea: " + idea + structureRequest($("structure").value) }];
    var retried = false, finishReason = null;

    function ask(history) {
      return chatComplete(history, model, 4096, MUSE_SCHEMA).then(function (response) {
        var choice = (response.choices || [])[0] || {};
        finishReason = choice.finish_reason || finishReason;
        return (choice.message || {}).content || "";
      });
    }

    refreshChat().then(function (status) {
      if (!status.configured) throw new Error("Set the chat server address under Engine first");
      if (!status.available) throw new Error(status.error || "The chat server is not answering at " + status.base);
      if (!status.use) throw new Error("No model is loaded in the chat server. Load one there; this page never loads or switches models.");
      model = status.use;
      return ask(messages);
    }).then(function (content) {
      var parsed;
      try { parsed = JSON.parse(stripThinking(content)); }
      catch (error) { throw new Error("The writer did not return usable JSON. Try again, or load another model."); }
      // Section tags are what YuE2 reads as structure. Smaller writers drop them,
      // so check and give the model one corrective pass before accepting the brief.
      var note = null;
      if (!hasSections(parsed.lyrics || "")) note = RETRY_NOTE;
      else {
        var found = findCliches(parsed.lyrics || "");
        if (found.length >= 2 || found.some(function (p) { return WORST.indexOf(p) >= 0; })) note = CLICHE_NOTE.replace("%s", found.slice(0, 8).join(", "));
      }
      if (!note) return parsed;
      retried = true;
      return ask(messages.concat([{ role: "assistant", content: content }, { role: "user", content: note }])).then(function (content2) {
        var parsed2 = JSON.parse(stripThinking(content2));
        var better = hasSections(parsed2.lyrics || "") &&
          findCliches(parsed2.lyrics || "").length <= findCliches(parsed.lyrics || "").length;
        return better ? parsed2 : parsed;
      }).catch(function () { return parsed; });
    }).then(function (brief) {
      var lyrics = String(brief.lyrics || "").trim();
      var sung = lyrics.split(/\r?\n/).filter(function (l) { return l.trim() && l.trim().charAt(0) !== "["; });
      var title = String(brief.title || "").trim() || (sung[0] || idea).slice(0, 60).replace(/^[\s,.!?-]+|[\s,.!?-]+$/g, "");
      $("title").value = title;
      if (brief.style) $("style").value = String(brief.style).trim();
      if (lyrics) { $("lyrics").value = lyrics; growLyrics(); }
      setCodes(null);
      var cliches = findCliches(lyrics), cut = finishReason === "length";
      var sections = lyrics.split(/\r?\n/).filter(function (l) { return l.trim().charAt(0) === "["; }).length;
      $("museStatus").textContent = model + " · " + Math.round((Date.now() - started) / 100) / 10 + "s · " + sung.length + " lines · " +
        sections + " sections" + (retried ? " · rewritten once" : "") +
        (cliches.length ? " · stock phrases left: " + cliches.join(", ") : "") +
        (cut ? " · CUT OFF at the token limit" : "") + " · model left as it was";
      $("museStatus").classList.toggle("bad", cut);
      toast("Brief written: " + title, "good");
      if ($("autoRun").checked) {
        // Submit the form rather than calling the server: the one path that
        // also reads the mode, seeds, supplied score and sampling boxes.
        $("composeForm").requestSubmit();
      }
    }).catch(function (error) {
      $("museStatus").textContent = "";
      toast(error.message, "bad");
    }).then(function () {
      clearInterval(ticker);
      button.dataset.busy = "0";
      $("museLabel").textContent = "Write the brief";
    });
  }

  /* ---------------------------------------------------------------- boot */

  function propsChanged(a, b) {
    var pick = function (p) { return JSON.stringify([p.version, p.model, p.vaes, p.default_vae, p.sliders, p.loras, p.sources, p.max_batch, p.transcriber, p.outputs]); };
    return !a || pick(a) !== pick(b);
  }

  function pollProps() {
    api("/props").then(function (props) {
      var wasOnline = STATE.online;
      STATE.online = true;
      if (propsChanged(STATE.props, props)) { applyProps(props); refreshSettings(); }
      if (!wasOnline) { paintEngine(); paintSubmitNote(); refreshLibrary().catch(function () {}); }
    }).catch(function () {
      if (STATE.online) { STATE.online = false; paintEngine(); paintSubmitNote(); }
    });
  }

  window.addEventListener("error", function (event) {
    toastOnce("page-error:" + (event.message || ""), "Page error: " + (event.message || "unknown") + " — reload if things stop responding", "bad");
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    pollProps();
    if (!STATE.online) return;
    refreshHardware();
    refreshLibrary().catch(function () {});
  });

  // ------------------------------------------------------------ column grips
  // Drag the line between two columns to resize the compose column (left) or the takes list (right); the
  // middle column takes what is left and never goes under its minimum. Double-click or Home gives the
  // default width back; arrow keys move a focused grip. The widths are this browser's own ("yue2.cols"),
  // kept as dragged: a smaller window squeezes them for now, a bigger one gives them back.
  var GRIPS = {
    left: { grip: "gripLeft", col: "view-compose", prop: "--col-left", min: 380, sign: 1 },
    right: { grip: "gripRight", col: "library", prop: "--col-right", min: 240, sign: -1 }
  };
  var MIDDLE_MIN = 420;
  var workspace = document.querySelector(".workspace");
  var stacked = window.matchMedia("(max-width: 1150px)");

  function savedCols() {
    var cols;
    try { cols = JSON.parse(recall("yue2.cols") || "{}") || {}; } catch (error) { cols = {}; }
    return cols;
  }
  function colWidth(side) { return Math.round($(GRIPS[side].col).getBoundingClientRect().width); }
  // the widest this side may be: the window less the other column, the middle's minimum and the two gaps
  function colMax(side) {
    var other = side === "left" ? "right" : "left";
    return Math.floor(workspace.getBoundingClientRect().width - colWidth(other) - MIDDLE_MIN - 2);
  }
  function setCol(side, px) {
    var g = GRIPS[side];
    if (px === null) workspace.style.removeProperty(g.prop);
    else workspace.style.setProperty(g.prop, Math.round(Math.max(g.min, Math.min(px, colMax(side)))) + "px");
    var grip = $(g.grip);
    grip.setAttribute("aria-valuenow", String(colWidth(side)));
    grip.setAttribute("aria-valuemin", String(g.min));
  }
  function applyCols() {
    if (stacked.matches || !workspace.offsetParent) return;
    var cols = savedCols();
    // left first against the default right, then right against the left it got, then left again
    ["left", "right", "left"].forEach(function (side) { setCol(side, typeof cols[side] === "number" ? cols[side] : null); });
  }
  function saveCol(side, px) {
    var cols = savedCols();
    if (px === null) delete cols[side]; else cols[side] = px;
    store("yue2.cols", Object.keys(cols).length ? JSON.stringify(cols) : null);
  }

  Object.keys(GRIPS).forEach(function (side) {
    var g = GRIPS[side], grip = $(g.grip);
    grip.addEventListener("pointerdown", function (event) {
      if (event.button !== 0) return;
      var startX = event.clientX, from = colWidth(side);
      grip.setPointerCapture(event.pointerId);
      grip.classList.add("is-dragging");
      document.body.classList.add("is-resizing");
      function move(e) { setCol(side, from + g.sign * (e.clientX - startX)); }
      function done(e) {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", done);
        grip.removeEventListener("pointercancel", done);
        grip.classList.remove("is-dragging");
        document.body.classList.remove("is-resizing");
        if (e.clientX !== startX) saveCol(side, colWidth(side));
      }
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", done);
      grip.addEventListener("pointercancel", done);
    });
    grip.addEventListener("dblclick", function () { saveCol(side, null); applyCols(); });
    grip.addEventListener("keydown", function (event) {
      var step = event.shiftKey ? 64 : 16, px;
      if (event.key === "ArrowLeft") px = colWidth(side) - g.sign * step;
      else if (event.key === "ArrowRight") px = colWidth(side) + g.sign * step;
      else if (event.key === "Home") { event.preventDefault(); saveCol(side, null); applyCols(); return; }
      else return;
      event.preventDefault();
      setCol(side, px);
      saveCol(side, colWidth(side));
    });
  });
  // re-fit on window resizes, and when the workspace comes back from the Engine page
  if (window.ResizeObserver) new ResizeObserver(applyCols).observe(workspace);
  else window.addEventListener("resize", applyCols);
  applyCols();

  // ------------------------------------------------------------------ fonts
  // Three fonts this browser can change ("yue2.fonts"; the <head> script applies them before the first paint):
  // the text (--sans), the headings (--heading, the text font unless picked) and numbers and code (--mono).
  // Each menu lists the app's own fonts, a line, then the fonts this computer has: a common set, found by
  // measuring, or every installed family after List all my fonts (the browser asks first; Chrome and Edge).
  var FONT_ROLES = {
    sans: { select: "fontSans", generic: "sans-serif", own: "IBM Plex Sans" },
    heading: { select: "fontHeading", generic: "sans-serif", own: "" },
    mono: { select: "fontMono", generic: "monospace", own: "IBM Plex Mono" }
  };
  var APP_FONTS = ["IBM Plex Sans", "IBM Plex Mono", "Bodoni Moda", "Space Grotesk", "Michroma"];
  var COMMON_FONTS = ["Aptos", "Arial", "Avenir", "Avenir Next", "Bahnschrift", "Baskerville", "Calibri", "Cambria", "Candara",
    "Cantarell", "Cascadia Code", "Cascadia Mono", "Charter", "Consolas", "Constantia", "Corbel", "Courier New", "DejaVu Sans",
    "DejaVu Sans Mono", "DejaVu Serif", "Didot", "Fira Mono", "Fira Sans", "Franklin Gothic Medium", "Futura", "Garamond",
    "Georgia", "Gill Sans", "Helvetica", "Helvetica Neue", "Hoefler Text", "Inter", "Iowan Old Style", "JetBrains Mono", "Lato",
    "Liberation Mono", "Liberation Sans", "Liberation Serif", "Lucida Console", "Lucida Sans Unicode", "Menlo", "Monaco",
    "Noto Sans", "Noto Sans Mono", "Noto Serif", "Open Sans", "Optima", "Palatino", "Palatino Linotype", "Roboto", "Roboto Mono",
    "SF Mono", "Segoe UI", "Segoe UI Variable Text", "Sitka Text", "Source Code Pro", "Source Sans 3", "Tahoma", "Times New Roman",
    "Trebuchet MS", "Ubuntu", "Ubuntu Mono", "Verdana"];
  var systemFonts = [];

  function savedFonts() {
    var fonts;
    try { fonts = JSON.parse(recall("yue2.fonts") || "{}") || {}; } catch (error) { fonts = {}; }
    return fonts;
  }
  function applyFonts() {
    var saved = savedFonts(), root = document.documentElement;
    Object.keys(FONT_ROLES).forEach(function (role) {
      if (typeof saved[role] === "string") root.style.setProperty("--" + role, JSON.stringify(saved[role]) + ", " + FONT_ROLES[role].generic);
      else root.style.removeProperty("--" + role);
    });
  }
  // installed when text set in it measures differently from a generic fallback
  function hasFont(family) {
    var ctx = hasFont.ctx || (hasFont.ctx = document.createElement("canvas").getContext("2d")), sample = "mmmmmwwwwwiiilll 0123 AaQq";
    return ["monospace", "serif", "sans-serif"].some(function (generic) {
      ctx.font = "32px " + generic;
      var base = ctx.measureText(sample).width;
      ctx.font = "32px " + JSON.stringify(family) + ", " + generic;
      return ctx.measureText(sample).width !== base;
    });
  }
  function fontOption(family, label) {
    var option = document.createElement("option");
    option.value = family;
    option.textContent = label;
    if (family) option.style.fontFamily = JSON.stringify(family) + ", sans-serif";
    return option;
  }
  function paintFonts() {
    var saved = savedFonts();
    Object.keys(FONT_ROLES).forEach(function (role) {
      var r = FONT_ROLES[role], select = $(r.select), want = typeof saved[role] === "string" ? saved[role] : r.own;
      var system = systemFonts.slice();
      if (want && APP_FONTS.indexOf(want) < 0 && system.indexOf(want) < 0) system.push(want);   // kept from a longer list
      select.textContent = "";
      if (!r.own) select.appendChild(fontOption("", "Same as the text (default)"));
      APP_FONTS.forEach(function (family) { select.appendChild(fontOption(family, family === r.own ? family + " (default)" : family)); });
      select.appendChild(document.createElement("hr"));
      system.sort(function (a, b) { return a.localeCompare(b); }).forEach(function (family) { select.appendChild(fontOption(family, family)); });
      select.value = want;
    });
    $("fontsHint").textContent = systemFonts.length + " fonts found on this computer" +
      (typeof window.queryLocalFonts === "function" ? "; List all my fonts shows every one." : ".");
  }
  Object.keys(FONT_ROLES).forEach(function (role) {
    $(FONT_ROLES[role].select).addEventListener("change", function () {
      var saved = savedFonts();
      if (this.value === FONT_ROLES[role].own) delete saved[role]; else saved[role] = this.value;
      store("yue2.fonts", Object.keys(saved).length ? JSON.stringify(saved) : null);
      applyFonts();
    });
  });
  $("fontsReset").addEventListener("click", function () {
    store("yue2.fonts", null);
    applyFonts();
    paintFonts();
    toast("Fonts are back to the app's own");
  });
  $("fontsAll").classList.toggle("is-hidden", typeof window.queryLocalFonts !== "function");
  $("fontsAll").addEventListener("click", function () {
    window.queryLocalFonts().then(function (fonts) {
      var seen = {};
      systemFonts = [];
      fonts.forEach(function (font) {
        if (!seen[font.family] && APP_FONTS.indexOf(font.family) < 0) { seen[font.family] = true; systemFonts.push(font.family); }
      });
      paintFonts();
      toast(systemFonts.length + " fonts listed");
    }).catch(function (error) { toast("The browser did not list the fonts: " + error.message, "bad"); });
  });
  paintFonts();
  (window.requestIdleCallback || function (fn) { return setTimeout(fn, 200); })(function () {
    systemFonts = COMMON_FONTS.filter(hasFont);
    paintFonts();
  });

  STATE.favOnly = recall("yue2.favOnly") === "1";

  // The polls start once, and wait while the tab is hidden (a visible tab catches up at once).
  var pollsStarted = false;
  function startPolls() {
    if (pollsStarted) return;
    pollsStarted = true;
    setInterval(function () { if (!document.hidden) pollProps(); }, 10000);
    // Keep the memory readout honest while runs come and go.
    setInterval(function () { if (!document.hidden) refreshHardware(); }, 5000);
  }

  function boot() {
    api("/props").then(function (props) {
      STATE.online = true;
      applyProps(props);
      restoreJobs();
      connectLogs();
      startPolls();
      refreshSettings();
      refreshHardware();
      if (chatBase()) refreshChat().catch(function () {});
      else paintChat({ configured: false, available: false, models: [], loaded: null, use: null });
      // a library that cannot be read is its own problem, not a server that is down
      refreshLibrary().catch(function (error) { toastOnce("library", "Could not read the song library: " + error.message, "bad"); });
    }).catch(function (error) {
      STATE.online = false;
      paintEngine();
      paintSubmitNote();
      toastOnce("offline", "Could not reach the server: " + error.message, "bad");
      setTimeout(boot, 5000);
    });
  }

  buildKnobs();
  syncShape();
  paintOutputDefaults();
  paintSliders();
  paintLibrary();
  paintEngine();
  boot();
})();
