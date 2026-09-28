/* The LoRA picker: tap a LoRA to add it, set its strength on the music half
   (score and music tokens) and on the sound half (the acoustic stage), and
   see its trigger word and how it was trained. The same file ships in both
   consoles; each page hands it the server's catalog and reads value().

   window.YueLoras:
     mount(host, opts)     opts: { cot() -> "full"|"melody"|"off", addToStyle(word), onChange() }
     setCatalog(list)      [{id, name, halves:["ar","nar"], rank, layout, trigger, hint, mode, size_mb, error}]
     set(list)             [{id, ar, nar}] from a take, to render it again
     value()               [{id, ar, nar}] for the request (installed files only)
     describe(list)        "sv-billie (music 0.8 · sound 1.0), ..." for a song's info
     listInto(list, note)  also keep an Engine-panel list (a <ul>) of every installed LoRA
     setSources(map)       {id or folder prefix: {repo, url, about, trigger}} from loras/sources.json:
                           a link and a recap per LoRA, and a trigger word for files that carry none */
(function (root) {
  "use strict";

  var S = { catalog: [], choice: [], host: null, opts: {}, list: null, note: null, sources: {} };

  function escape(text) {
    return String(text === undefined || text === null ? "" : text).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function entry(id) {
    for (var i = 0; i < S.catalog.length; i++) if (S.catalog[i].id === id) return S.catalog[i];
    return null;
  }

  // A name for an id whose file is gone: the file stem, or its folders when the stem is generic
  function fallbackName(id) {
    var parts = String(id).split("/"), stem = parts[parts.length - 1].replace(/\.safetensors$/, "");
    return /^(lora|adapter_model|pytorch_lora_weights|model|adapter)$/i.test(stem) && parts.length > 1
      ? parts.slice(0, -1).join(" / ") : stem;
  }

  // A short name: sources.json's title, else the file's own name
  function nameOf(id) {
    var e = entry(id), src = source(id);
    return src && src.title ? src.title : e ? e.name : fallbackName(id);
  }

  // A few words on what it does, for inside its button: sources.json's tag, else the file's style note
  function tagOf(e) {
    var src = source(e.id), hint = String(e.hint || "").split(/[,.;]/)[0].trim();
    return src && src.tag ? src.tag : hint.length <= 32 ? hint : hint.slice(0, 31) + "\u2026";
  }

  function halfShort(e) { return has(e, "ar") && has(e, "nar") ? "both" : has(e, "ar") ? "music" : "sound"; }

  // The sources.json entry for a file: its exact id, else the longest folder prefix of it
  function source(id) {
    var best = "";
    Object.keys(S.sources).forEach(function (key) {
      if ((id === key || id.indexOf(key) === 0) && key.length > best.length) best = key;
    });
    return best ? S.sources[best] : null;
  }

  // Only web links become links: anything else in sources.json stays plain text
  function webUrl(u) { return /^https?:\/\//i.test(String(u || "")) ? String(u) : ""; }

  function triggerOf(e) {
    var src = e ? source(e.id) : null;
    return e ? (e.trigger || (src && src.trigger) || "") : "";
  }

  function has(e, half) { return !!e && (e.halves || []).indexOf(half) >= 0; }

  function halvesText(e) {
    return has(e, "ar") && has(e, "nar") ? "music + sound" : has(e, "ar") ? "music" : has(e, "nar") ? "sound" : "";
  }

  function chipTip(e) {
    if (e.error) return nameOf(e.id) + "\nCannot load: " + e.error;
    var lines = [nameOf(e.id) + " · " + halvesText(e) + (has(e, "ar") && has(e, "nar") ? " halves" : " half"),
      "rank " + e.rank + ", " + e.layout + " layout, " + e.size_mb + " MB"];
    if (triggerOf(e)) lines.push("Trigger word: " + triggerOf(e));
    if (e.mode) lines.push("Trained in " + (e.mode === "direct" ? "Direct" : e.mode) + " mode");
    if (e.hint) lines.push(e.hint);
    lines.push("loras/" + e.id);
    return lines.join("\n");
  }

  // chipTip with the recap from sources.json under the name
  function aboutTip(e) {
    var src = source(e.id), lines = chipTip(e).split("\n");
    if (src && src.about) lines.splice(1, 0, src.about, "");
    return lines.join("\n");
  }

  // A strength as written: at least `min` decimals, more only when the value has
  // them (a card's 0.375 stays 0.375, 0.5 stays 0.5)
  function fmt(v, min) {
    var s = Number(v).toFixed(3);
    while (s.length - s.indexOf(".") - 1 > min && s.charAt(s.length - 1) === "0") s = s.slice(0, -1);
    return s;
  }

  function halfControl(choice, e, half) {
    var label = half === "ar" ? "Music" : "Sound", on = has(e, half) || !e;
    var value = on ? choice[half] : 0;
    return '<label class="lora-half' + (on ? "" : " is-off") + '" data-tip="' + escape(on
      ? (half === "ar" ? "Strength on the music half: the score and the music tokens (0 off, 1 as trained)"
                       : "Strength on the sound half: the acoustic stage that turns music tokens into sound (0 off, 1 as trained)")
      : "This file has no " + label.toLowerCase() + " half") + '"><span>' + label + "</span>" +
      '<input type="range" min="0" max="2" step="0.025" value="' + value + '"' + (on ? "" : " disabled") +
      ' data-lora="' + escape(choice.id) + '" data-half="' + half + '" aria-label="' + escape(nameOf(choice.id)) + " " + label + ' strength" />' +
      "<output>" + (on ? fmt(value, 2) : "—") + "</output></label>";
  }

  function hints() {
    var notes = [];
    if (!S.catalog.length) return ["No LoRAs found. Put .safetensors files (or folders, or links to them) in the app's loras/ folder."];
    if (!S.choice.length) return ["None active. Tap a LoRA to add it; each can steer the music half, the sound half, or both."];
    var cot = S.opts.cot ? S.opts.cot() : "";
    S.choice.forEach(function (c) {
      var e = entry(c.id);
      if (!e) { notes.push(fallbackName(c.id) + " is no longer in loras/ and will be left out."); return; }
      var name = nameOf(c.id);
      if (triggerOf(e)) notes.push(name + ": put its trigger word “" + triggerOf(e) + "” in the style.");
      if (e.mode === "direct" && cot && cot !== "off") notes.push(name + " was trained in Direct mode.");
      if (e.mode && e.mode !== "direct" && cot === "off") notes.push(name + " was trained with a score (" + e.mode + " mode).");
      if (c.ar > 1) notes.push(name + ": above 1.0 on the music half, vocals often fall apart.");
    });
    if (S.choice.length > 1) notes.push(S.choice.length + " stacked: their changes add up.");
    return notes;
  }

  // The Engine panel's list: one tile per file in loras/ (name, source, details), the ones in the song form
  // marked. It is for reading: the form's LoRA picker adds and removes them
  function paintList() {
    if (!S.list) return;
    var on = {};
    S.choice.forEach(function (c) { on[c.id] = c; });
    S.list.innerHTML = S.catalog.length ? S.catalog.map(function (e) {
      var parts = String(e.name).split(" / "), main = parts.pop(), folder = parts.join(" / "), title = (source(e.id) || {}).title || main;
      var meta = e.error ? "cannot load: " + e.error
        : [halvesText(e), folder, "rank " + e.rank, e.size_mb + " MB", triggerOf(e) ? "trigger " + triggerOf(e) : "", e.mode ? e.mode + " mode" : ""]
          .filter(Boolean).join(" · ");
      var src = source(e.id) || {}, url = webUrl(src.url);
      var where = url
        ? '<a class="tile-link" href="' + escape(url) + '" target="_blank" rel="noopener noreferrer" data-tip="' +
          escape("Open its model card (new tab): " + url) + '"><span>' + escape(src.repo || url) + "</span>\u2197</a>"
        : '<span class="tile-repo" data-tip="' + escape("No source for this file in loras/sources.json; the (i) has its details") + '">' +
          escape(src.repo || "no source link") + "</span>";
      return '<li class="lora-item' + (on[e.id] ? " is-on" : "") + (e.error ? " is-bad" : "") + '" data-lora="' + escape(e.id) + '">' +
        '<div class="lora-item-head"><span class="lora-item-name">' + escape(title) + "</span>" +
        (on[e.id] ? '<span class="tile-state">in the song form</span>' : "") + "</div>" +
        '<div class="tile-src">' + where + '<span class="info" tabindex="0" role="img" aria-label="About ' + escape(nameOf(e.id)) +
        '" data-tip="' + escape(aboutTip(e)) + '">i</span></div>' +
        '<div class="lora-item-meta">' + escape(meta) + "</div></li>";
    }).join("") : '<li class="lora-item"><div class="lora-item-meta">No .safetensors files in the app\'s loras/ folder.</div></li>';
    if (S.note) {
      var active = S.choice.filter(function (c) { return entry(c.id); }).length;
      S.note.textContent = S.catalog.length + " in loras/" + (active ? " · " + active + " in the song form" : " · none in the song form");
    }
  }

  function toggle(id) {
    var at = -1;
    S.choice.forEach(function (c, i) { if (c.id === id) at = i; });
    if (at >= 0) {
      S.choice.splice(at, 1);
    } else {
      var e = entry(id);
      if (!e || e.error) return;
      S.choice.push({ id: id, ar: has(e, "ar") ? 1 : 0, nar: has(e, "nar") ? 1 : 0 });
    }
    changed();
  }

  function listInto(list, note) {
    S.list = list;
    S.note = note || null;
    paintList();
  }

  function paint() {
    paintList();
    if (!S.host) return;
    var on = {};
    S.choice.forEach(function (c) { on[c.id] = true; });
    var active = S.host.querySelector(".lora-active"), chips = S.host.querySelector(".lora-chips");
    active.innerHTML = S.choice.map(function (c) {
      var e = entry(c.id);
      return '<div class="lora-row' + (e ? "" : " is-missing") + '"><span class="lora-name" data-tip="' + escape(e ? aboutTip(e) : "Not in loras/ any more") + '">' +
        escape(nameOf(c.id)) + "</span>" + halfControl(c, e, "ar") + halfControl(c, e, "nar") +
        (triggerOf(e) ? '<button type="button" class="chip lora-trigger" data-trigger="' + escape(triggerOf(e)) +
          '" data-tip="Add the trigger word to the style prompt">+ ' + escape(triggerOf(e)) + "</button>" : "<span></span>") +
        '<button type="button" class="icon-btn" data-remove-lora="' + escape(c.id) + '" aria-label="Remove ' + escape(nameOf(c.id)) + '">✕</button></div>';
    }).join("");
    // one even grid of buttons: the name, which half it steers, and a few words on what it does
    chips.innerHTML = S.catalog.map(function (e) {
      var tag = e.error ? "cannot load" : tagOf(e) || halvesText(e) + (has(e, "ar") && has(e, "nar") ? " halves" : " half");
      return '<button type="button" class="lora-pick' + (on[e.id] ? " is-on" : "") + '" data-lora-chip="' + escape(e.id) + '"' +
        (e.error ? " disabled" : "") + ' aria-pressed="' + (on[e.id] ? "true" : "false") + '" data-tip="' + escape(aboutTip(e)) + '">' +
        '<span class="lora-pick-name">' + escape(nameOf(e.id)) + "</span>" +
        (e.error ? "" : '<span class="lora-pick-half">' + halfShort(e) + "</span>") +
        '<span class="lora-pick-tag">' + escape(tag) + "</span></button>";
    }).join("");
    S.host.querySelector(".lora-hint").textContent = hints().join(" ");
  }

  function changed() {
    paint();
    if (S.opts.onChange) S.opts.onChange();
  }

  function mount(host, opts) {
    S.host = host;
    S.opts = opts || {};
    host.innerHTML = '<div class="lora-active"></div><div class="lora-chips"></div><p class="row-hint lora-hint"></p>';
    host.addEventListener("click", function (event) {
      var chip = event.target.closest("[data-lora-chip]"), remove = event.target.closest("[data-remove-lora]");
      var trigger = event.target.closest("[data-trigger]");
      if (chip && !chip.disabled) {
        toggle(chip.dataset.loraChip);
      } else if (remove) {
        S.choice = S.choice.filter(function (c) { return c.id !== remove.dataset.removeLora; });
        changed();
      } else if (trigger && S.opts.addToStyle) {
        S.opts.addToStyle(trigger.dataset.trigger);
      }
    });
    host.addEventListener("input", function (event) {
      var id = event.target.dataset.lora, half = event.target.dataset.half;
      if (!id || !half) return;
      S.choice.forEach(function (c) { if (c.id === id) c[half] = parseFloat(event.target.value); });
      event.target.nextElementSibling.textContent = fmt(event.target.value, 2);
      S.host.querySelector(".lora-hint").textContent = hints().join(" ");
    });
    paint();
  }

  function setCatalog(list) {
    var before = JSON.stringify(S.catalog);
    S.catalog = (list || []).slice();
    if (JSON.stringify(S.catalog) !== before) paint();
  }

  function setSources(map) {
    var before = JSON.stringify(S.sources);
    S.sources = map && typeof map === "object" ? map : {};
    if (JSON.stringify(S.sources) !== before) paint();
  }

  function set(list) {
    S.choice = (list || []).map(function (c) {
      return { id: String(c.id), ar: Number(c.ar) || 0, nar: Number(c.nar) || 0 };
    }).filter(function (c) { return c.id && (c.ar || c.nar); });
    changed();
  }

  function value() {
    return S.choice.filter(function (c) {
      var e = entry(c.id);
      return e && !e.error && ((has(e, "ar") && c.ar > 0) || (has(e, "nar") && c.nar > 0));
    }).map(function (c) {
      var e = entry(c.id);
      return { id: c.id, ar: has(e, "ar") ? Math.round(c.ar * 1000) / 1000 : 0, nar: has(e, "nar") ? Math.round(c.nar * 1000) / 1000 : 0 };
    });
  }

  // One line per LoRA for a song's info: a LoRA's two halves (often two files) share its line
  function lines(list) {
    var byName = {}, order = [];
    (list || []).forEach(function (c) {
      var name = c.name || nameOf(c.id);
      if (!byName[name]) { byName[name] = { music: 0, sound: 0 }; order.push(name); }
      if (Number(c.ar)) byName[name].music = Number(c.ar);
      if (Number(c.nar)) byName[name].sound = Number(c.nar);
    });
    return order.map(function (name) {
      var l = byName[name], parts = [];
      if (l.music) parts.push("music " + fmt(l.music, 2));
      if (l.sound) parts.push("sound " + fmt(l.sound, 2));
      return { name: name, amounts: parts.join(" · ") };
    });
  }

  function describe(list) {
    return (list || []).map(function (c) {
      var parts = [];
      if (Number(c.ar)) parts.push("music " + fmt(c.ar, 1));
      if (Number(c.nar)) parts.push("sound " + fmt(c.nar, 1));
      return (c.name || nameOf(c.id)) + " (" + parts.join(" · ") + ")";
    }).join(", ");
  }

  root.YueLoras = { mount: mount, setCatalog: setCatalog, set: set, value: value, describe: describe, lines: lines, repaint: paint,
    listInto: listInto, setSources: setSources };
})(window);
