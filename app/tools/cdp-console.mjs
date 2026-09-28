// Headless checks of the console page against the mock server (tools/mock_server.py).
// Starts its own mock on a free port with an empty library under tmp/, drives
// headless Chrome over the DevTools protocol, and stops both by PID at the end.
//
//   node tools/cdp-console.mjs                 # build the page first: ./build-page.sh
//   node tools/cdp-console.mjs http://127.0.0.1:41869/   # an already running mock instead
//
// Nothing is written outside the project: Chrome's HOME/XDG dirs and TMPDIR sit in
// tmp/chrome-home, screenshots land in tmp/shots/console.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, statSync, cpSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chromeTmp, findChrome, freshProfile, makeSend, stopChrome } from "./cdp-common.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = ROOT + "/tmp", HOME = TMP + "/chrome-home", OUT = TMP + "/shots/console";
const CHROME = findChrome();
if (!CHROME) { console.log("\x1b[31mno Chrome or Chromium found\x1b[0m: install one, or set YUE2_CHROME=/path/to/chrome"); process.exit(2); }
const PROFILE = freshProfile(HOME, "profile-console");   // new and empty every run
const CHROME_TMP = chromeTmp(ROOT + "/tmp");
const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
mkdirSync(OUT, { recursive: true });
mkdirSync(HOME, { recursive: true });

// ---------------------------------------------------------------- preflight
const page = TMP + "/console.html";
if (!existsSync(page)) { console.log(`${R}tmp/console.html is missing${X}: run ./build-page.sh first`); process.exit(2); }
const newest = Math.max(...["index.html", "app.css", "app.js"].map((f) => statSync(ROOT + "/build/tools/console/" + f).mtimeMs));
if (statSync(page).mtimeMs < newest) { console.log(`${R}tmp/console.html is older than its sources${X}: run ./build-page.sh`); process.exit(2); }

const env = { ...process.env, HOME, XDG_CONFIG_HOME: HOME + "/.config", XDG_CACHE_HOME: HOME + "/.cache",
              XDG_DATA_HOME: HOME + "/.local/share", TMPDIR: TMP, PYTHONDONTWRITEBYTECODE: "1" };

// ------------------------------------------------------------- mock server
let mock = null, BASE = process.argv[2];
if (!BASE) {
  mock = spawn("nice", ["-n", "15", "python3", ROOT + "/tools/mock_server.py", "--port", "0", "--outputs", TMP + "/mock-outputs/cdp",
                        "--reset", "--demo", "3", "--speed", "3", "--quiet"], { env, stdio: ["ignore", "pipe", "pipe"] });
  // it prints its address once it listens; its errors go to the same text so a failure says why
  try {
    BASE = await new Promise((ok, fail) => {
      let text = "";
      const timer = setTimeout(() => fail(new Error("the mock server did not start within 90 s: " + text.slice(-600))), 90000);
      const read = (d) => {
        text += d;
        const m = text.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (m) { clearTimeout(timer); ok(`http://127.0.0.1:${m[1]}/`); }
      };
      mock.stdout.on("data", read);
      mock.stderr.on("data", read);
      mock.on("exit", (code) => { clearTimeout(timer); fail(new Error("the mock server exited " + code + ": " + text.slice(-600))); });
    });
    // and it answers
    for (let i = 0; ; i++) {
      try { if ((await fetch(BASE + "props")).ok) break; } catch { /* not yet */ }
      if (i > 120) throw new Error("the mock server printed its address but does not answer /props");
      await sleep(250);
    }
  } catch (e) {
    console.log(`\x1b[31m${e.message}\x1b[0m`);
    try { mock.kill("SIGKILL"); } catch {}
    process.exit(2);
  }
}
const mockGet = async (path) => (await fetch(BASE + path)).json();
const mockClear = () => fetch(BASE + "mock/clear", { method: "POST" });

// ------------------------------------------------------------------ chrome
const chrome = spawn("nice", ["-n", "15", CHROME, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--autoplay-policy=no-user-gesture-required", "--user-data-dir=" + PROFILE, "--remote-debugging-port=0",
  "about:blank"], { env: { ...env, TMPDIR: CHROME_TMP }, stdio: ["ignore", "ignore", "pipe"] });
let chromeErr = ""; chrome.stderr.on("data", (d) => { chromeErr = (chromeErr + d).slice(-2000); });
const finish = async (code) => {
  if (mock) { try { mock.kill("SIGTERM"); } catch {} }
  await stopChrome(chrome, PROFILE, CHROME_TMP);
  process.exit(code);
};
// a stalled DevTools command (or any other failure) still stops Chrome and the mock
process.on("unhandledRejection", (e) => { console.log(`\x1b[31mstopped: ${e?.message || e}\x1b[0m`); finish(2); });
setTimeout(() => { console.log(`${R}TIMEOUT${X} after 240 s`); report(); finish(2); }, 240000);

let port;
for (let i = 0; i < 300 && !port; i++) {     // up to 60 s: a first start on a slow machine can take a while
  await sleep(200);
  if (existsSync(PROFILE + "/DevToolsActivePort")) port = readFileSync(PROFILE + "/DevToolsActivePort", "utf8").split("\n")[0];
}
if (!port) { console.log(`${R}Chrome did not start within 60 s${X} (${CHROME})\n${chromeErr.split("\n").filter((l) => !/cpufreq|org\.freedesktop|dbus/.test(l)).slice(-20).join("\n")}`); await finish(2); }
const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === "page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0;
const pending = new Map(), errors = [];
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errors.push((d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text).split("\n")[0]);
  if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push("console.error: " + d.params.args.map((a) => a.value ?? a.description).join(" "));
  if (d.method === "Page.javascriptDialogOpening") ws.send(JSON.stringify({ id: ++seq, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
});
const send = makeSend(ws, pending, () => ++seq);   // every command gives up after 60 s, naming itself
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return "EVAL ERROR: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).split("\n")[0];
  return r.result?.result?.value;
};
// screenshots only on request (YUE2_SHOTS=1): the kit and the README take theirs from tools/screenshots.mjs
const SHOTS_ON = process.env.YUE2_SHOTS === "1";
let shots = 0;
const shot = async (name) => {
  if (!SHOTS_ON) return;
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64"));
  shots++;
};
const waitFor = async (expr, timeout = 10000, step = 100) => {
  const until = Date.now() + timeout;
  for (;;) {
    const v = await ev(expr);
    if (v && !(typeof v === "string" && v.startsWith("EVAL ERROR"))) return v;
    if (Date.now() > until) return null;
    await sleep(step);
  }
};
const wheel = async (x, y, dy) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy });
  await sleep(250);
};
let lastHover = { x: 0, y: 0 };
const hoverOn = async (selector) => {
  const box = await ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: "center" });
    const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (!box) return null;
  await sleep(120);
  lastHover = box;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await sleep(220);
  return ev(`(() => { const t = document.querySelector(".tip"), b = t.getBoundingClientRect(), s = getComputedStyle(t);
    return { on: t.classList.contains("is-on") && s.visibility === "visible", text: t.innerText, left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: innerWidth, h: innerHeight }; })()`);
};
const inView = (t) => t && t.left >= 0 && t.right <= t.w && t.top >= 0 && t.bottom <= t.h;
const click = (selector) => ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true; })()`);
const setValue = (id, value) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(value)};
  e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
const synthBodies = async () => (await mockGet("mock/requests")).filter((r) => r.path === "/synth").map((r) => r.body);

// ----------------------------------------------------------------- results
const lines = [];
let passed = 0, failed = 0;
const section = (name) => lines.push(`${C}${B}${name}${X}`);
const check = (name, ok, detail) => {
  ok ? passed++ : failed++;
  lines.push(`  ${ok ? G + "PASS" : R + "FAIL"}${X}  ${name}${detail !== undefined && detail !== "" ? D + "  (" + String(detail).slice(0, 220) + ")" + X : ""}`);
};
function report() {
  console.log(lines.join("\n"));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${B}cdp-console${X}  ${failed ? R : G}${passed} passed, ${failed} failed${X}` +
              `  ${D}${secs} s · ${SHOTS_ON ? shots + " screenshots in tmp/shots/console · " : ""}mock ${BASE}${X}`);
}

await send("Page.enable");
await send("Runtime.enable");
// the profile is new and empty for every run, so nothing is stored from an earlier one
// Every load waits for the new document: the old one is marked first, so a
// condition that was already true before the reload cannot pass for it.
const navigate = async (libraryRows) => {
  await ev(`window.__stale = true`);
  await send("Page.navigate", { url: BASE });
  return waitFor(`!window.__stale && document.readyState === "complete" && document.querySelectorAll("#decoders input").length === 3 &&
    document.querySelectorAll("#libList .take").length >= ${libraryRows} && document.getElementById("logState").textContent === "live"`, 15000);
};
const boot = () => navigate(3);

// ================================================================== layout
const measure = `(() => { const r = (id) => document.getElementById(id).getBoundingClientRect();
  const pb = r("playbar").top, ws = document.querySelector(".workspace").getBoundingClientRect();
  return { vh: innerHeight, doc: document.scrollingElement.scrollHeight, pb: Math.round(pb), wsTop: Math.round(ws.top), wsBottom: Math.round(ws.bottom),
    gen: Math.round(r("generateBtn").bottom), libBottom: Math.round(document.querySelector(".lib-list").getBoundingClientRect().bottom) }; })()`;
for (const [w, h] of [[1536, 730], [1920, 960]]) {
  const tag = `${w}x${h}`;
  section(`layout ${tag}`);
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  const ready = await boot();
  check("page loads: VAEs, library and the log stream are up", !!ready);
  check("no script errors while loading", errors.length === 0, errors.join(" | ") || "none");
  const closed = await ev(measure);
  if (tag === "1920x960") {
    const idle = await ev(`({ text: document.getElementById("statusText").textContent, s: document.getElementById("statusPill").dataset.s,
      w: Math.round(document.getElementById("statusPill").getBoundingClientRect().width), dl: document.querySelectorAll("#playbar a[download]").length })`);
    check("the player bar's status says Idle before anything runs (a pill where the downloads were)", idle.text === "Idle" && idle.s === "idle" && idle.dl === 0, JSON.stringify(idle));
    const cpp = await ev(`(() => { const a = document.querySelector(".brand .engine-tag"); return a && { tag: a.tagName, href: a.href, target: a.target, rel: a.rel, text: a.textContent }; })()`);
    const yue = await ev(`(() => { const a = document.querySelector(".brand h1 a"); return a && { href: a.href, target: a.target, text: a.textContent }; })()`);
    check("the YuE2 name links to the model's repo, in a new tab", yue?.href === "https://github.com/multimodal-art-projection/YuE" && yue.target === "_blank" &&
      yue.text === "YuE2", JSON.stringify(yue));
    check("the CPP badge links to the engine's repo, in a new tab", cpp?.tag === "A" && cpp.href === "https://github.com/ServeurpersoCom/yue2.cpp" &&
      cpp.target === "_blank" && /noopener/.test(cpp.rel) && cpp.text === "cpp", JSON.stringify(cpp));
  }
  check("page height fits the window", closed.doc <= closed.vh && closed.wsBottom <= closed.pb + 1, `doc ${closed.doc} / window ${closed.vh}, workspace ends ${closed.wsBottom}, player at ${closed.pb}`);
  await shot(`${tag}-1-page`);
  await click("#engineToggle");
  await sleep(400);
  await shot(`${tag}-2-engine-open`);
  const engineProbe = `(() => { const ws = document.querySelector(".workspace"), head = document.querySelector(".engine-head").getBoundingClientRect();
    const probe = document.createElement("i"); probe.style.background = "var(--amber)"; document.body.append(probe);
    const amber = getComputedStyle(probe).backgroundColor; probe.remove();
    // the lowest card on screen (the grid packs cards out of source order)
    const last = { bottom: Math.max(...[...document.querySelectorAll("#view-engine .card")].map(c => c.getBoundingClientRect().bottom)) };
    return { wsShown: ws.offsetParent !== null, headTop: Math.round(head.top), lit: getComputedStyle(document.getElementById("engineToggle")).backgroundColor === amber,
      title: document.querySelector(".engine-title").textContent.trim(), lastBottom: Math.round(last.bottom),
      pb: Math.round(document.getElementById("playbar").getBoundingClientRect().top), doc: document.scrollingElement.scrollHeight, vh: innerHeight }; })()`;
  const eng = await ev(engineProbe);
  check("engine open: its own page (the song workspace steps aside), the Engine band under the top bar, the Engine button lit",
    !eng.wsShown && eng.headTop === 52 && eng.lit && /Engine/.test(eng.title), JSON.stringify(eng));
  for (let i = 0; i < 4; i++) await wheel(Math.round(w * 0.5), 300, 3000);
  const down = await ev(engineProbe);
  check("engine scrolled to the end: the last card clears the player, the band stays in view", down.lastBottom > 0 && down.lastBottom <= down.pb + 1 &&
    down.headTop === 52, `last card ends ${down.lastBottom}, player ${down.pb}, band ${down.headTop}`);
  if (tag === "1920x960") {
    const about = await ev(`(() => { const c = document.getElementById("aboutCard"); if (!c) return null;
      const links = [...c.querySelectorAll("a")], cards = [...document.querySelectorAll("#view-engine .engine-grid > .card")];
      const onScreen = c.getBoundingClientRect();
      return { last: cards[cards.length - 1] === c, credit: c.querySelector(".about-credit").textContent.replace(/\\s+/g, " ").trim(),
        gh: links.some(a => a.href === "https://github.com/IronWolve"), yue: links.some(a => a.href === "https://github.com/multimodal-art-projection/YuE"),
        cpp: links.some(a => a.href === "https://github.com/ServeurpersoCom/yue2.cpp"), weights: links.some(a => a.href === "https://huggingface.co/m-a-p/YuE2-3B"),
        page: links.some(a => a.href === "https://map-yue2.github.io/"), ggml: links.some(a => a.href === "https://github.com/ggml-org/ggml"),
        projects: [...c.querySelectorAll(".about-project h4")].map(e => e.textContent).join(),
        newTab: links.every(a => a.target === "_blank" && /noopener/.test(a.rel)), web: links.every(a => /^https?:/.test(a.getAttribute("href"))),
        addons: [...c.querySelectorAll("#aboutAddons a")].map(a => a.textContent).join(","),
        plain: [...c.querySelectorAll("#aboutAddons .about-name")].map(e => e.textContent).join(","), shown: onScreen.bottom <= innerHeight && onScreen.top < innerHeight }; })()`);
    check("About closes the Engine page: your credit and GitHub, the model's and the engine's pages, all in new tabs", !!about && about.last &&
      about.credit === "Customized Collection by SeattleSysop github.com/IronWolve" && about.gh && about.yue && about.cpp && about.weights && about.page && about.ggml && about.projects === "YuE2,yue2.cpp,ggml" && about.newTab && about.web,
      JSON.stringify(about));
    check("  the add-ons come from sources.json; a non-web link stays plain text", about?.addons === "Standard VAE,Blend VAE,Voice and genre sliders,sv-billie,Industrial rock" &&
      about.plain === "Legacy VAE", JSON.stringify({ addons: about?.addons, plain: about?.plain }));
  }
  await shot(`${tag}-3-engine-scrolled`);
  await click("#engineBack");
  await sleep(200);
  const back = await ev(measure);
  check("Back to compose closes it: the workspace returns and the page fits the window", (await ev(`document.getElementById("view-engine").classList.contains("is-hidden")`)) === true &&
    back.doc <= back.vh && back.wsTop === 52 && back.wsBottom <= back.pb + 1, JSON.stringify(back));
}

// ============================================================ column grips
section("column grips (drag the lines between the columns)");
const cols = `(() => { const w = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().width);
  const g = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 200), shown: r.width > 0 }; };
  const c = document.getElementById("view-compose").getBoundingClientRect(), t = document.getElementById("view-take").getBoundingClientRect(), l = document.getElementById("library").getBoundingClientRect();
  let saved = null; try { saved = JSON.parse(localStorage.getItem("yue2.cols")); } catch (e) {}
  return { left: w("#view-compose"), mid: w("#view-take"), right: w("#library"), gl: g("gripLeft"), gr: g("gripRight"),
    gapL: (c.right + t.left) / 2, gapR: (t.right + l.left) / 2, saved, sw: document.scrollingElement.scrollWidth, vw: innerWidth }; })()`;
const drag = async (from, dx) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 6; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + Math.round(dx * i / 6), y: from.y, button: "left", buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: from.x + dx, y: from.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(100);
};
const c0 = await ev(cols);
check("two grips sit on the lines between the columns", c0.gl.shown && c0.gr.shown && Math.abs(c0.gl.x - c0.gapL) <= 1.5 && Math.abs(c0.gr.x - c0.gapR) <= 1.5 && c0.saved === null,
  JSON.stringify({ gl: c0.gl.x, gapL: c0.gapL, gr: c0.gr.x, gapR: c0.gapR, saved: c0.saved }));
const hit = await ev(`[document.elementFromPoint(${c0.gl.x}, ${c0.gl.y})?.id, document.elementFromPoint(${c0.gr.x}, ${c0.gr.y})?.id].join()`);
check("  the mouse finds them there (nothing covers them)", hit === "gripLeft,gripRight", hit);
await drag(c0.gl, 120);
const c1 = await ev(cols);
check("dragging the left grip 120px right widens the compose column by 120px; the takes list stays", Math.abs(c1.left - c0.left - 120) <= 1 && c1.right === c0.right &&
  c1.saved?.left === c1.left, JSON.stringify({ before: [c0.left, c0.mid, c0.right], after: [c1.left, c1.mid, c1.right], saved: c1.saved }));
await drag(c1.gr, -100);
const c2 = await ev(cols);
check("dragging the right grip 100px left widens the takes list by 100px; the compose column stays", Math.abs(c2.right - c1.right - 100) <= 1 && c2.left === c1.left &&
  c2.saved?.right === c2.right, JSON.stringify({ after: [c2.left, c2.mid, c2.right], saved: c2.saved }));
await drag(c2.gl, 2000);
const c3 = await ev(cols);
check("  dragged too far, the middle column stops at its minimum (420px) and the page gets no side scroll", c3.mid >= 419 && c3.mid <= 421 && c3.sw <= c3.vw,
  JSON.stringify({ cols: [c3.left, c3.mid, c3.right], scrollWidth: c3.sw, window: c3.vw }));
await drag(c3.gl, c2.left - c3.left);
await boot();
const c4 = await ev(cols);
check("the widths survive a reload (this browser keeps them)", Math.abs(c4.left - c2.left) <= 1 && Math.abs(c4.right - c2.right) <= 1, JSON.stringify({ was: [c2.left, c2.right], now: [c4.left, c4.right] }));
for (const clickCount of [1, 2]) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: c4.gl.x, y: c4.gl.y, button: "left", buttons: 1, clickCount });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c4.gl.x, y: c4.gl.y, button: "left", buttons: 0, clickCount });
}
await sleep(100);
const c5 = await ev(cols);
check("double-clicking the left grip gives the compose column its default width back", c5.left === c0.left && c5.right === c4.right && c5.saved?.left === undefined,
  JSON.stringify({ now: [c5.left, c5.right], defaults: [c0.left, c0.right], saved: c5.saved }));
await ev(`document.getElementById("gripRight").focus(); true`);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
await sleep(50);
const c6 = await ev(cols);
check("  the keyboard moves a focused grip (ArrowLeft widens the takes list 16px); Home resets it", c6.right === c5.right + 16, JSON.stringify({ before: c5.right, after: c6.right }));
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Home", code: "Home", windowsVirtualKeyCode: 36 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Home", code: "Home", windowsVirtualKeyCode: 36 });
await sleep(50);
const c7 = await ev(cols);
check("  both back to the defaults, nothing stored", c7.left === c0.left && c7.right === c0.right && c7.saved === null, JSON.stringify({ now: [c7.left, c7.right], saved: c7.saved }));
// drawer headings in the narrowest compose column: the name on one line, its sentence under it (never beside it)
const heads = await ev(`(() => { document.querySelector(".workspace").style.setProperty("--col-left", "380px");
  const out = [...document.querySelectorAll("#view-compose .drawer > summary")].map(s => { const n = s.querySelector(".sum-name").getBoundingClientRect(), y = s.querySelector(".sum-say");
    const r = y.getBoundingClientRect(); return { name: s.querySelector(".sum-name").textContent, oneLine: n.height < 24, under: r.top >= n.bottom - 1, say: y.textContent }; });
  document.querySelector(".workspace").style.removeProperty("--col-left"); return out; })()`);
check("drawer headings: the name on one line with its sentence under it, even in the narrowest column", heads.length === 5 &&
  heads.every(h => h.oneLine && h.under && h.say) && /^A local chat model writes the title, style and lyrics from one line\.$/.test(heads[0].say),
  JSON.stringify(heads.filter(h => !h.oneLine || !h.under).map(h => h.name)) + " " + heads[0].say);
await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(200);
const gripsNarrow = await ev(`[getComputedStyle(document.getElementById("gripLeft")).display, getComputedStyle(document.getElementById("gripRight")).display].join()`);
check("  a narrow window stacks the columns and hides the grips", gripsNarrow === "none,none", gripsNarrow);
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 960, deviceScaleFactor: 1, mobile: false });
await sleep(200);

// ============================================================ engine panel
section("engine panel");
await click("#engineToggle");
await sleep(300);
const server = await ev(`[...document.querySelectorAll("#serverCard div")].map(d => d.innerText.replace(/\\s+/g, " "))`);
check("server card shows /props (backbone, batch, transcriber, library)", server.some((s) => /YuE2-3B-BF16\.gguf/.test(s)) &&
  server.some((s) => /Songs per pass 4/.test(s)) && server.some((s) => /Transcriber loaded/.test(s)) && server.some((s) => /Library saved on disk/.test(s)), server.join(" | "));
const vaeCard = await ev(`document.getElementById("vaeCard").innerText`);
check("VAE card names every repo", ["m-a-p/YuE2-Vae", "m-a-p/YuE2-Vae-legacy", "Mothersuperior/YuE2-Vae-merge-0.666"].every((r) => vaeCard.includes(r)));
const sliderCard = await ev(`({ tiles: document.querySelectorAll("#sliderCard > li").length, buttons: document.querySelectorAll("#sliderCard button").length,
  badge: (document.querySelector("#view-engine .kind-badge.is-addon") && [...document.querySelectorAll("#view-engine h3")].find(h => /Sliders/.test(h.textContent))
    .querySelector(".kind-badge.is-addon") || {}).textContent || "",
  href: (document.querySelector("#sliderSource a.tile-link") || { getAttribute: () => "" }).getAttribute("href"),
  info: (document.querySelector("#sliderSource .info") || { dataset: {} }).dataset.tip || "",
  first: (document.querySelector("#sliderCard > li") || {}).innerText || "", note: document.getElementById("sliderCardNote").textContent })`);
check("Engine Sliders card: marked ADD-ON, its source linked with an (i), one tile per slider (16, no buttons)", sliderCard.tiles === 16 &&
  sliderCard.buttons === 0 && sliderCard.badge === "add-on" && sliderCard.href === "https://example.org/sliders" && /an add-on/.test(sliderCard.info) &&
  /16 voice and genre sliders/.test(sliderCard.note), JSON.stringify(sliderCard).slice(0, 300));
const formKinds = await ev(`({ sliders: !!document.querySelector("fieldset .label .kind-badge.is-addon") &&
    [...document.querySelectorAll("fieldset .label")].filter(l => /^(Sliders|LoRAs)/.test(l.textContent.trim()) && l.querySelector(".kind-badge.is-addon")).length,
  vaes: [...document.querySelectorAll("#decoders label.toggle")].map(l => l.querySelector("input").value + ":" + ((l.querySelector(".kind-badge") || {}).textContent || "")) })`);
check("the form marks the add-ons: Sliders and LoRAs headings, and the Blend VAE (the stock VAEs unmarked)", formKinds.sliders === 2 &&
  formKinds.vaes.join() === "standard:,legacy:,blend:add-on", JSON.stringify(formKinds));
const cramped = await ev(`(() => { const h = document.querySelector("#paneServer .pane-head h4").getBoundingClientRect().height,
  b = document.getElementById("chatTest").getBoundingClientRect().height; return { h: Math.round(h), b: Math.round(b) }; })()`);
check("Writer card has room: its header and button sit on one line", cramped.h < 22 && cramped.b < 34, JSON.stringify(cramped));
const logText = await ev(`document.getElementById("logBody").innerText`);
check("server log card streams /logs", /\[Server\] Listening on/.test(logText) && (await ev(`document.getElementById("logState").textContent`)) === "live");
check("no PyTorch-only settings (device, backend, quantization dtype, budget)", (await ev(`!document.getElementById("setBackend") && !document.getElementById("setQuant") && !document.getElementById("setBudget") && !document.getElementById("setDevice")`)) === true);
let t;
// the F32 option was removed on 2026-09-26 (unproven quality claim, about 60% slower): nothing of it is left
check("no F32 option: no button by the model menu, no Precision setting, no tip", await ev(`!document.getElementById("f32Toggle") &&
  !document.getElementById("setPrecision") && !document.querySelector('[data-tip-ref="tip-precision"]') && !document.getElementById("tip-precision")`));
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 700 });
check("the engine panel is open before Escape", (await ev(`document.getElementById("view-engine").classList.contains("is-hidden")`)) === false);
await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
check("Escape closes the engine panel", await ev(`document.getElementById("view-engine").classList.contains("is-hidden")`));

// ==================================================================== VAEs
section("VAE choice");
const kinds = await ev(`[...document.querySelectorAll("#decoders input")].map(i => i.type + ":" + i.name)`);
check("VAE choices are one group of radios from /props", kinds.length === 3 && kinds.every((k) => k === "radio:vae"), kinds.join(" "));
const picks = [];
for (const v of ["legacy", "blend", "standard", "legacy"]) {
  await click(`#decoders input[value="${v}"]`);
  await sleep(60);
  picks.push(await ev(`[...document.querySelectorAll("#decoders input:checked")].map(i => i.value).join("+")`));
}
check("ticking one unticks the others", picks.join(",") === "legacy,blend,standard,legacy", picks.join(" -> "));
check("the pick is remembered in this browser", (await ev(`localStorage.getItem("yue2.vae")`)) === "legacy");
await boot();
check("the pick survives a reload", (await ev(`document.querySelector("#decoders input:checked")?.value`)) === "legacy");

// ==================================================================== tips
section("info tips");
// each VAE's name (not the label's centre: the ADD-ON badge inside the label has a tip of its own)
t = await hoverOn('#decoders label:has(input[value="standard"]) .vae-name');
check("hover Standard: the quality choice and the newer model, and its repo", t?.on && /quality/.test(t.text) && /newer model/.test(t.text) &&
  t.text.includes("m-a-p/YuE2-Vae"), t?.text);
t = await hoverOn('#decoders label:has(input[value="legacy"]) .vae-name');
check("hover Legacy: the older decoder behind the benchmarks, and its repo", t?.on && /older/.test(t.text) && /benchmark/.test(t.text) &&
  t.text.includes("m-a-p/YuE2-Vae-legacy"), t?.text);
t = await hoverOn('#decoders label:has(input[value="blend"]) .vae-name');
check("hover Blend: the mix, \u2154 Standard and \u2153 Legacy, and its repo", t?.on && t.text.includes("\u2154 Standard and \u2153 Legacy") &&
  t.text.includes("Mothersuperior/YuE2-Vae-merge-0.666"), t?.text);
check("  Blend no longer spells the mix out beside its name", (await ev(`document.querySelector('#decoders label:has(input[value="blend"]) small')`)) === null &&
  (await ev(`document.querySelector('#decoders label:has(input[value="standard"]) small')?.textContent`)) === "best sound");
t = await hoverOn('#decoders label:has(input[value="blend"]) .kind-badge');
check("  its ADD-ON badge explains add-on", t?.on && /third party/i.test(t.text), t?.text);
t = await hoverOn('[data-tip-ref="tip-vae"]');
check("(i) beside VAE explains it and lists the server's three", t?.on && /VAE · sound decoder/i.test(t.text) && t.text.includes("m-a-p/YuE2-Vae-legacy") && t.text.includes("Mothersuperior"), t?.text.split("\n")[0]);
check("  the tip sits inside the window", inView(t));
await shot("tip-vae");
t = await hoverOn('#sliderChips [data-slider="metal"]');
check("hover a slider chip says what it does, that it is an add-on, and its id", t?.on && /Heavy guitar riffs/.test(t.text) && /Add-on slider/.test(t.text) &&
  t.text.includes("metal"), t?.text.replace(/\n/g, " | "));
t = await hoverOn('[data-tip-ref="tip-sliders"]');
check("(i) beside Sliders says they are an add-on, not stock, and a cousin of a LoRA", t?.on && /add-on, not stock/i.test(t.text) &&
  /cousin of a LoRA/.test(t.text), t?.text.split("\n")[0]);
t = await hoverOn('[data-tip-ref="tip-seeds"]');
check("(i) beside the seeds explains music vs sound", t?.on && /Music/.test(t.text) && /Sound/.test(t.text), t?.text.split("\n")[0]);
await ev(`document.getElementById("coverDrawer").open = true; document.getElementById("outDrawer").open = true; true`);
t = await hoverOn('[data-tip-ref="tip-transcribe"]');
check("(i) beside From a recording names both models", t?.on && t.text.includes("m-a-p/SheetSage2") && t.text.includes("m-a-p/MERT-v2-FullSong"), t?.text.split("\n")[0]);
check("  the tip sits inside the window", inView(t));
t = await hoverOn('[data-tip-ref="tip-output"]');
check("(i) beside Format explains WAV 24 and peak clip", t?.on && /WAV 24/.test(t.text) && /Peak clip/.test(t.text));
t = await hoverOn('[data-tip-ref="tip-versions"]');
check("(i) beside Versions says the server's batch size", t?.on && /up to 4 side by side/.test(t.text.replace(/\s+/g, " ")), t?.text.replace(/\s+/g, " ").slice(0, 120));
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1100, y: 400 });
await sleep(200);
check("the tip hides when the pointer leaves", !(await ev(`document.querySelector(".tip").classList.contains("is-on")`)));
await ev(`document.querySelector('[data-tip-ref="tip-vae"]').focus()`);
await sleep(120);
check("tabbing onto (i) shows the tip too", await ev(`document.querySelector(".tip").classList.contains("is-on")`));
await ev(`document.activeElement.blur(); document.getElementById("coverDrawer").open = false; document.getElementById("outDrawer").open = false; true`);

// ================================================================= sliders
section("sliders");
await click('#sliderChips [data-slider="metal"]');
await sleep(80);
check("tapping a chip adds a strength row", (await ev(`document.querySelectorAll("#sliderActive .slider-row").length`)) === 1 &&
  (await ev(`document.querySelector('#sliderChips [data-slider="metal"]').classList.contains("is-on")`)));
await ev(`(() => { const r = document.querySelector('#sliderActive input[data-strength="metal"]'); r.value = "0.6"; r.dispatchEvent(new Event("input", { bubbles: true })); })()`);
check("strength moves 0..1 and shows its value", (await ev(`document.querySelector("#sliderActive output").textContent`)) === "0.60");
await click('#sliderChips [data-slider="female"]');
await click('#sliderChips [data-slider="male"]');
await sleep(80);
let hint = await ev(`document.getElementById("sliderHint").textContent`);
check("sliders stack (three rows)", (await ev(`document.querySelectorAll("#sliderActive .slider-row").length`)) === 3);
check("hint: Female and Male pull in opposite directions", /opposite directions/.test(hint), hint);
check("hint: trained in Direct mode (full plan selected)", /trained in Direct mode/.test(hint));
await click('#modes input[value="off"]');
hint = await ev(`document.getElementById("sliderHint").textContent`);
check("the Direct-mode note goes away in Direct mode", !/trained in Direct mode/.test(hint));
await click('#modes input[value="full"]');
await click('#sliderActive [data-remove="female"]');
await click('#sliderActive [data-remove="male"]');
check("removing leaves only the chosen one", (await ev(`[...document.querySelectorAll("#sliderActive .slider-name")].map(e => e.textContent).join()`)) === "Metal");
await shot("sliders");

// ============================================================ generate
section("generate: request and live run");
await mockClear();
await ev(`(() => {
  const set = (id, v) => { document.getElementById(id).value = v; };
  set("title", "CDP Song"); set("style", "English, dark country, baritone male voice, fiddle, 86 BPM MOCK-SLOW");
  set("lyrics", "[Verse]\\nTruck won't start till midnight\\nBelt clicks on the empty seat\\n\\n[Chorus]\\nRidin' where the ridge road goes");
  set("lmSeed", "9223372036854775000"); set("soundSeed", "12345"); set("versions", "1"); set("abc", "");
  return true; })()`);
await click("#generateBtn");
const firstBody = await waitFor(`fetch("/mock/requests").then(r => r.json()).then(a => a.filter(x => x.path === "/synth").map(x => x.body)[0] || null)`, 5000);
const req = firstBody ? JSON.parse(firstBody.replace(/("(?:lm_seed|seed)"\s*:\s*)(\d+)/g, '$1"$2"')) : {};
check("request carries the VAE and the sliders", req.vae === "legacy" && JSON.stringify(req.sliders) === '[{"id":"metal","strength":0.6}]', JSON.stringify({ vae: req.vae, sliders: req.sliders }));
check("music seed goes out as the exact 19-digit integer", /"lm_seed":9223372036854775000[,}]/.test(firstBody || ""), (firstBody || "").match(/"lm_seed":[^,]*/)?.[0]);
check("sound seed goes out as an integer", /"seed":12345[,}]/.test(firstBody || ""));
check("output defaults to WAV 24-bit; defaults stay out of the request",
  req.output_format === "wav24" && !("steps" in req) && !("cfg_scale" in req) && !("lm_batch_size" in req) && !("duration" in req) && !("plan_only" in req),
  Object.keys(req).join(","));
check("title, style, lyrics and mode are sent", req.title === "CDP Song" && req.cot === "full" && /MOCK-SLOW/.test(req.style) && /Truck/.test(req.lyrics));
const seenStages = new Set();
let sawMeter = false, sawClock = false, runSeedsText = "", sawRendering = 0;
for (let i = 0; i < 80; i++) {
  const s = await ev(`(() => ({ state: document.getElementById("runState").dataset.s, running: [...document.querySelectorAll("#stages .stage[data-s=running]")].map(e => e.dataset.key),
    meter: !!document.querySelector("#stages .stage[data-s=running] .meter:not(.is-hidden)"), clock: document.getElementById("runClock").textContent,
    status: document.getElementById("statusText").textContent, pillW: Math.round(document.getElementById("statusPill").getBoundingClientRect().width),
    open: !document.getElementById("takeBody").classList.contains("is-hidden") && document.getElementById("chain").hidden }))()`);
  s.running.forEach((k) => seenStages.add(k));
  if (s.status === "Rendering") sawRendering = s.pillW;
  if (!runSeedsText && !s.open) runSeedsText = await ev(`document.getElementById("runSeeds").textContent`);
  if (s.meter) sawMeter = true;
  if (s.clock && s.clock !== "0:00") sawClock = true;
  if (i === 12) await shot("run-progress");
  if (s.open) break;
  await sleep(100);
}
check("the run shows its stages as they run (score, tokens, sound, decode)", ["score", "tokens", "sound"].every((k) => seenStages.has(k)), [...seenStages].join(" -> "));
check("progress bars and elapsed time move", sawMeter && sawClock);
check("  the player bar's status says Rendering while it runs, at the same size", sawRendering === 104, String(sawRendering));
check("the run shows both seeds", runSeedsText === "music seed 9223372036854775000 · sound seed 12345", runSeedsText);
const opened = await waitFor(`!document.getElementById("takeBody").classList.contains("is-hidden") && document.getElementById("takeTitle").textContent === "CDP Song"`, 15000);
check("when done, the new take opens", !!opened);
await sleep(300);
const meta = await ev(`Object.fromEntries([...document.querySelectorAll("#metaGrid [data-field]")].map(d => [d.dataset.field, d.dataset.value]))`);
check("song info: VAE, both seeds, format", meta?.VAE === "Legacy" && meta?.["Music seed"] === "9223372036854775000" && meta?.["Sound seed"] === "12345" && meta?.Format === "WAV 24-bit", JSON.stringify(meta));
const layout = await ev(`(() => { const h = document.getElementById("takeActions");
  return { icons: ["favTake", "renameTake", "deleteTake"].map(id => !!h.querySelector("#" + id)).join(),
    danger: h.querySelector("#deleteTake")?.classList.contains("danger"), eyebrow: document.getElementById("takeEyebrow").textContent,
    groups: [...document.querySelectorAll("#takeTools .tool-cap")].map(e => e.textContent).join(),
    sections: [...document.querySelectorAll("#metaGrid h4")].map(e => e.textContent).join(),
    copies: document.querySelectorAll("#metaGrid .seed-copy").length, oldDelete: document.querySelectorAll("#deleteTake").length }; })()`);
check("header: Favourite, Rename and Delete (red) as icons on the title line", layout.icons === "true,true,true" && layout.danger && layout.oldDelete === 1, JSON.stringify(layout));
check("  the line under the title says age, length and render time, no seed", /long/.test(layout.eyebrow) && /made in/.test(layout.eyebrow) && !/seed/i.test(layout.eyebrow), layout.eyebrow);
check("  the buttons sit in Download, Make again and Files", layout.groups === "Download,Make again,Files", layout.groups);
check("  the details are one compact card: Song | Sound | Shape, Sliders | LoRAs, then the seeds with copy buttons", layout.sections === "Song,Sound,Shape,Sliders,LoRAs" && layout.copies === 2, layout.sections);
check("song info: model from the library entry, no precision row on a new song", meta?.Model === "BF16" && !("Precision" in meta) && !("Score" in meta));
const shapesMeta = await waitFor(`(() => { const m = Object.fromEntries([...document.querySelectorAll("#metaGrid [data-field]")].map(d => [d.dataset.field, d.dataset.value]));
  return m.Composition && m.Composition !== "…" ? m : null; })()`, 5000, 100);
check("song info: Composition, Performance and Style influence as the sliders name them (defaults here)", shapesMeta?.Composition === "default" &&
  shapesMeta?.Performance === "default" && shapesMeta?.["Style influence"] === "default" && !("Guidance" in (shapesMeta || {})),
  JSON.stringify({ c: shapesMeta?.Composition, p: shapesMeta?.Performance, s: shapesMeta?.["Style influence"] }));
check("the player loads the take from the library", /\/library\/audio\?name=/.test(await ev(`document.getElementById("audio").src`)));
const waveInk = await waitFor(`(() => { const c = document.getElementById("wave"), x = c.getContext("2d"), d = x.getImageData(0, 0, c.width, c.height).data;
  let cols = 0; for (let i = 0; i < c.width; i++) { for (let j = 0; j < c.height; j++) { if (d[(j * c.width + i) * 4 + 3] > 0) { cols++; break; } } } return cols > c.width * 0.6 ? cols : 0; })()`, 8000, 250);
check("the waveform is drawn", !!waveInk, `${waveInk} inked columns`);
const firstTake = await ev(`document.querySelector("#libList .take.is-active")?.dataset.name`);
const reqsAfterOpen = await mockGet("mock/requests");
check("  its peaks come from /library/peaks", reqsAfterOpen.some((r) => r.path === "/library/peaks" && r.name === firstTake));
check("  and the audio is not downloaded again to decode it", !reqsAfterOpen.some((r) => r.path === "/library/audio" && !r.range), 
  reqsAfterOpen.filter((r) => r.path === "/library/audio").map((r) => (r.range ? "range" : "full")).join(","));
check("the score of the take shows (staff or ABC)", (await waitFor(`document.getElementById("scoreAbc").textContent.startsWith("X:1")`, 4000)) === true);
await ev(`document.getElementById("scorePanel").open = true; true`);
await shot("take-open");
// a narrower window: the details card folds its columns and nothing spills out of it
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(400);
const narrow = await ev(`(() => { const c = document.getElementById("metaGrid"), t = document.getElementById("takeTools"), col = document.getElementById("view-take");
  const spill = [...c.querySelectorAll("dd, dt, h4")].filter(e => e.getBoundingClientRect().right > c.getBoundingClientRect().right + 1).length;
  return { card: Math.round(c.getBoundingClientRect().width), spill, cardScroll: c.scrollWidth - c.clientWidth, toolsScroll: t.scrollWidth - t.clientWidth,
    colScroll: col.scrollWidth - col.clientWidth }; })()`);
check("at 1280 px the details card and the buttons fit their column (nothing spills)", narrow.spill === 0 && narrow.cardScroll <= 0 && narrow.toolsScroll <= 0 && narrow.colScroll <= 0, JSON.stringify(narrow));
await shot("take-open-1280");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 960, deviceScaleFactor: 1, mobile: false });
await sleep(300);
const cdpTake = await ev(`document.querySelector("#libList .take.is-active")?.dataset.name`);

// playback + keyboard
await ev(`document.activeElement && document.activeElement.blur(); document.body.focus(); true`);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
const playing = await waitFor(`!document.getElementById("audio").paused`, 3000);
check("Space plays the take", !!playing);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
check("Space again pauses", !!(await waitFor(`document.getElementById("audio").paused`, 2000)));

// ============================================================ versions
section("versions and batches");
await mockClear();
const before = await ev(`document.querySelectorAll("#libList .take:not(.is-running-row)").length`);
await ev(`(() => { const set = (id, v) => { document.getElementById(id).value = v; };
  set("title", "Batch Song"); set("style", "German synth pop, 118 BPM"); set("lmSeed", "1000"); set("soundSeed", "");
  set("versions", "6"); set("variations", "2"); set("odeSteps", "8"); set("cfg", "1.2"); document.getElementById("cfg").dataset.touched = "1";
  const f = document.getElementById("outFormat"); f.value = "wav16"; f.dispatchEvent(new Event("change")); return true; })()`);
await click('#sliderActive [data-remove="metal"]');
await click("#generateBtn");
const bodies = await waitFor(`fetch("/mock/requests").then(r => r.json()).then(a => { const b = a.filter(x => x.path === "/synth").map(x => x.body); return b.length >= 2 ? b : null; })`, 6000);
await click("#libList .take:not(.is-running-row)");
const away = await waitFor(`!document.getElementById("backToRun").classList.contains("is-hidden") && /Back to Batch Song/.test(document.getElementById("backToRunLabel").textContent)`, 3000);
check("opening a take during a run offers the way back", !!away);
await click("#backToRun");
check("  Back to the run shows the run again", !!(await waitFor(`!document.getElementById("chain").hidden && document.getElementById("takeTitle").textContent === "Batch Song"`, 3000)));
const parsed = (bodies || []).map((b) => JSON.parse(b.replace(/("(?:lm_seed|seed)"\s*:\s*)(\d+)/g, '$1"$2"')));
check("6 versions with 4 per pass queue two jobs (4 + 2 songs)", parsed.length === 2 && parsed[0].lm_batch_size === 4 && parsed[1].lm_batch_size === 2,
  parsed.map((p) => p.lm_batch_size).join(" + "));
check("the second pass continues the music seeds (1000, 1004)", parsed[0]?.lm_seed === "1000" && parsed[1]?.lm_seed === "1004", parsed.map((p) => p.lm_seed).join(", "));
check("sound variations, steps, format and guidance are sent", parsed.every((p) => p.synth_batch_size === 2 && p.steps === 8 && p.output_format === "wav16" && p.cfg_scale === 1.2),
  JSON.stringify(parsed[0] && { v: parsed[0].synth_batch_size, s: parsed[0].steps, f: parsed[0].output_format, c: parsed[0].cfg_scale }));
const batchDone = await waitFor(`document.querySelectorAll("#libList .take:not(.is-running-row)").length >= ${before + 12} &&
  [...document.querySelectorAll("#libList .take-title")].filter(e => /^Batch Song · v\\d · sound \\d$/.test(e.textContent)).length === 12`, 30000, 250);
const titles = await ev(`[...document.querySelectorAll("#libList .take-title")].map(e => e.textContent).filter(t => t.startsWith("Batch Song")).sort()`);
check("12 takes land, named v1..v6 × sound 1..2", !!batchDone, titles.slice(0, 3).join(" | ") + " … " + titles.slice(-1));
await shot("library-batch");
await ev(`(() => { const set = (id, v) => { document.getElementById(id).value = v; }; set("versions", "1"); set("variations", "1"); set("odeSteps", "32"); set("cfg", "");
  document.getElementById("cfg").dataset.touched = ""; const f = document.getElementById("outFormat"); f.value = "wav24"; f.dispatchEvent(new Event("change")); return true; })()`);

// ======================================================= VAE switch, replays
section("song page: VAE versions and new sound");
await click(`#libList .take[data-name="${cdpTake}"]`);
await waitFor(`document.getElementById("takeTitle").textContent === "CDP Song"`, 4000);
const chips = await ev(`[...document.querySelectorAll("#decodeSwitch .chip")].map(c => c.textContent + (c.classList.contains("is-on") ? "*" : ""))`);
check("VAE row: Legacy playing, + Standard and + Blend offered", JSON.stringify(chips) === '["+ Standard","Legacy*","+ Blend"]', JSON.stringify(chips));
t = await hoverOn('#decodeSwitch [data-add-vae="blend"]');
check("hover + Blend names its repo", t?.on && t.text.includes("Mothersuperior"), t?.text.replace(/\n/g, " | "));
await mockClear();
const parentReq = await ev(`fetch("/library/request?name=${encodeURIComponent(cdpTake)}").then(r => r.text())`);
await click('#decodeSwitch [data-add-vae="standard"]');
const replayBody = await waitFor(`fetch("/mock/requests").then(r => r.json()).then(a => a.filter(x => x.path === "/synth").map(x => x.body)[0] || null)`, 5000);
const rep = replayBody ? JSON.parse(replayBody.replace(/("(?:lm_seed|seed)"\s*:\s*)(\d+)/g, '$1"$2"')) : {};
const par = JSON.parse(parentReq.replace(/("(?:lm_seed|seed)"\s*:\s*)(\d+)/g, '$1"$2"'));
check("+ Standard posts a replay: parent set, VAE changed", rep.parent === cdpTake && rep.vae === "standard", `parent ${rep.parent}, vae ${rep.vae}`);
check("  same music codes, score and both seeds", rep.semantic_tokens === par.semantic_tokens && rep.abc === par.abc && rep.seed === par.seed && rep.lm_seed === par.lm_seed && rep.lm_batch_size === 1,
  `seed ${rep.seed}/${par.seed}, codes ${String(rep.semantic_tokens).length}`);
const switched = await waitFor(`document.querySelector('#metaGrid [data-field="VAE"]')?.dataset.value === "Standard"`, 10000);
check("when it lands, the page switches to the Standard version", !!switched);
await sleep(650);
const hanging = await ev(`(() => { const t = document.querySelector(".tip");
  if (!t.classList.contains("is-on")) return "off";
  const under = document.elementFromPoint(${lastHover.x}, ${lastHover.y}), target = under && under.closest("[data-tip]");
  return target && target.dataset.tip === t.innerText ? "matches " + target.textContent : "stale: " + t.innerText.split("\\n")[0]; })()`);
check("no tip is left describing a button that was repainted away", /^(off|matches)/.test(hanging), hanging);
const chips2 = await ev(`[...document.querySelectorAll("#decodeSwitch .chip")].map(c => c.textContent + (c.classList.contains("is-on") ? "*" : "") + (c.dataset.playTake ? "(play)" : ""))`);
check("VAE row now plays Legacy from the family", JSON.stringify(chips2) === '["Standard*","Legacy(play)","+ Blend"]', JSON.stringify(chips2));
await click("#decodeSwitch [data-play-take]");
check("clicking Legacy switches back", !!(await waitFor(`document.querySelector('#metaGrid [data-field="VAE"]')?.dataset.value === "Legacy"`, 3000)));
await mockClear();
await click("#rerenderSound");
const soundBody = await waitFor(`fetch("/mock/requests").then(r => r.json()).then(a => a.filter(x => x.path === "/synth").map(x => x.body)[0] || null)`, 5000);
const snd = soundBody ? JSON.parse(soundBody.replace(/("(?:lm_seed|seed)"\s*:\s*)(\d+)/g, '$1"$2"')) : {};
check("Re-render sound posts a replay: parent set, new sound seed, same codes", snd.parent === cdpTake && snd.seed !== par.seed && /^\d+$/.test(snd.seed || "") &&
  snd.semantic_tokens === par.semantic_tokens && snd.vae === "legacy", `seed ${snd.seed}`);
const soundRow = await waitFor(`document.querySelectorAll("#soundSwitch .chip:not([disabled])").length === 2`, 10000);
check("the new sound lands and a Sound row offers both", !!soundRow);
await shot("take-versions");
await click(`#libList .take[data-name="${cdpTake}"]`);
await waitFor(`document.getElementById("takeTitle").textContent === "CDP Song"`, 3000);
await click("#retakeTake");
const reused = await waitFor(`!document.getElementById("codesNote").classList.contains("is-hidden") ? { title: document.getElementById("title").value,
  seed: document.getElementById("lmSeed").value, sound: document.getElementById("soundSeed").value, vae: document.querySelector("#decoders input:checked").value,
  note: document.getElementById("codesNoteText").textContent } : null`, 4000);
check("Retake loads its exact request, codes included", reused?.title === "CDP Song" && reused?.seed === "9223372036854775000" && reused?.sound === "12345" &&
  reused?.vae === "legacy" && /same music/.test(reused?.note || ""), JSON.stringify(reused));
await mockClear();
await click("#generateBtn");
const reuseBody = await waitFor(`fetch("/mock/requests").then(r => r.json()).then(a => a.filter(x => x.path === "/synth").map(x => x.body)[0] || null)`, 5000);
check("  Generate then renders those codes again, parent set", !!reuseBody && JSON.parse(reuseBody).semantic_tokens === par.semantic_tokens &&
  JSON.parse(reuseBody).parent === cdpTake);
await waitFor(`document.getElementById("runState").dataset.s === "done" || !document.getElementById("chain").hidden === false`, 8000);
await click("#dropCodes");
check("  Drop codes forgets them", (await ev(`document.getElementById("codesNote").classList.contains("is-hidden")`)) === true);
await waitFor(`!document.querySelector("#libList .is-running-row")`, 8000);
await click(`#libList .take[data-name="${cdpTake}"]`);
await waitFor(`document.getElementById("takeTitle").textContent === "CDP Song"`, 3000);
await ev(`["title", "style", "lyrics", "abc", "lmSeed", "soundSeed"].forEach(id => { document.getElementById(id).value = ""; }); true`);
await click("#reuseTake");
const fresh = await waitFor(`document.getElementById("style").value ? { title: document.getElementById("title").value,
  style: document.getElementById("style").value, lyrics: document.getElementById("lyrics").value, abc: document.getElementById("abc").value,
  seed: document.getElementById("lmSeed").value, sound: document.getElementById("soundSeed").value,
  codes: !document.getElementById("codesNote").classList.contains("is-hidden"), vae: document.querySelector("#decoders input:checked").value,
  sliders: document.querySelectorAll("#sliderActive .slider-row").length } : null`, 4000);
check("Reuse loads the prompt, lyrics and settings with no score, seeds or codes", !!fresh && fresh.title === "CDP Song" &&
  /86 BPM/.test(fresh.style) && /\[Verse\]/.test(fresh.lyrics) && fresh.abc === "" && fresh.seed === "" && fresh.sound === "" && !fresh.codes &&
  fresh.vae === "legacy" && fresh.sliders === 1, JSON.stringify(fresh).slice(0, 200));
await mockClear();
await click("#generateBtn");
const freshBody = await waitFor(`fetch("/mock/requests").then(r => r.json()).then(a => a.filter(x => x.path === "/synth").map(x => JSON.parse(x.body))[0] || null)`, 5000);
check("  Generate then writes new music (no codes, no score, no seeds sent)", !!freshBody && !freshBody.semantic_tokens && !freshBody.abc &&
  freshBody.lm_seed === undefined && freshBody.seed === undefined, JSON.stringify(freshBody && { tokens: !!freshBody.semantic_tokens, abc: !!freshBody.abc, lm: freshBody.lm_seed }));
await waitFor(`!document.querySelector("#libList .is-running-row")`, 8000);

// ======================================================== library actions
section("library");
const libCount = async () => ev(`document.querySelectorAll("#libList .take:not(.is-running-row)").length`);
const serverTakes = async () => (await mockGet("library")).takes;
// a song that just landed reaches the page's list with its next refresh
await waitFor(`fetch("/library").then(r => r.json()).then(l => l.takes.length === document.querySelectorAll("#libList .take:not(.is-running-row)").length)`, 6000, 200);
check("the list matches the server's library", (await libCount()) === (await serverTakes()).length, `${await libCount()} rows`);
await click(`#libList .take[data-name="${cdpTake}"] .take-fav`);
await waitFor(`document.querySelector('#libList .take[data-name="${cdpTake}"]').classList.contains("is-fav")`, 3000);
check("☆ marks a favourite on the server", (await serverTakes()).find((e) => e.name === cdpTake)?.favorite === true);
await click("#favFilter");
check("the favourites filter shows only favourites", (await ev(`[...document.querySelectorAll("#libList .take:not(.is-running-row)")].map(e => e.dataset.name).join()`)) === cdpTake);
await click("#favFilter");
await click(`#libList .take[data-name="${cdpTake}"]`);
await click("#renameTake");
await ev(`(() => { const i = document.getElementById("renameInput"); i.value = "Renamed Take"; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true; })()`);
await waitFor(`document.getElementById("takeTitle").textContent === "Renamed Take"`, 3000);
check("Rename writes the title to the server and the list", (await serverTakes()).find((e) => e.name === cdpTake)?.title === "Renamed Take" &&
  (await ev(`document.querySelector('#libList .take[data-name="${cdpTake}"] .take-title').textContent`)) === "Renamed Take");
const victim = await ev(`[...document.querySelectorAll("#libList .take:not(.is-running-row)")].map(e => e.dataset.name).find(n => n !== "${cdpTake}")`);
const n0 = await libCount();
await click(`#libList .take[data-name="${victim}"] .take-del`);
await waitFor(`!document.querySelector('#libList .take[data-name="${victim}"]')`, 3000);
check("✕ deletes a take (after the confirm)", (await libCount()) === n0 - 1 && !(await serverTakes()).some((e) => e.name === victim));

// ======================================================= downloads + playback
section("downloads and playback");
const dl = await ev(`[...document.querySelectorAll("#libList .take:not(.is-running-row)")].map(e => {
  const a = e.querySelector(".take-dl"); return a ? { name: e.dataset.name, href: a.getAttribute("href"), file: a.getAttribute("download") } : { name: e.dataset.name }; })`);
check("every library card has a download icon", dl.length > 0 && dl.every((d) => d.href), `${dl.filter((d) => d.href).length}/${dl.length}`);
check("  named after the take (date-time-title.wav), from the library",
  dl.every((d) => d.file === d.name + ".wav" && d.href === "/library/audio?name=" + encodeURIComponent(d.name)), dl[0] && dl[0].file);
await click(`#libList .take[data-name="${cdpTake}"]`);
await sleep(300);
const dlOther = dl.map((d) => d.name).find((n) => n !== cdpTake);
const stay = await ev(`(() => { const stop = (e) => e.preventDefault(); document.addEventListener("click", stop, { capture: true, once: true });
  document.querySelector('#libList .take[data-name="${dlOther}"] .take-dl').click();
  return document.querySelector("#libList .take.is-active")?.dataset.name; })()`);
check("  clicking it downloads instead of opening that take", stay === cdpTake, stay);
const names = await ev(`({ page: document.getElementById("dlTakeAudio").getAttribute("download"), pageHref: document.getElementById("dlTakeAudio").getAttribute("href"),
  label: document.getElementById("dlTakeAudio").textContent })`);
check("song page has an Audio download with the same name", names.page === cdpTake + ".wav" && names.label === "WAV" &&
  /\/library\/audio\?name=/.test(names.pageHref), JSON.stringify(names));
check("  the player bar has no download buttons of its own (the song page has them)", (await ev(`!document.getElementById("dlAudio") && !document.getElementById("dlMp3Bar") &&
  !document.querySelector("#playbar a[download]")`)) === true);
await ev(`localStorage.removeItem("yue2.mp3kbps"); document.getElementById("mp3Rate").value = "320";
  document.getElementById("mp3Rate").dispatchEvent(new Event("change")); true`);
const mp3 = await ev(`({ page: document.getElementById("dlTakeMp3").getAttribute("href"), pageFile: document.getElementById("dlTakeMp3").getAttribute("download"),
  label: document.getElementById("dlTakeMp3").textContent, rate: document.getElementById("mp3Rate").value,
  cards: [...document.querySelectorAll("#libList .take:not(.is-running-row)")].map(e => { const a = e.querySelector(".take-mp3");
    return a ? a.getAttribute("href") === "/library/mp3?name=" + encodeURIComponent(e.dataset.name) + "&kbps=320" && a.getAttribute("download") === e.dataset.name + ".mp3" : false; }) })`);
check("song page has an MP3 download at 320 kbps by default", mp3.page === "/library/mp3?name=" + encodeURIComponent(cdpTake) + "&kbps=320" &&
  mp3.pageFile === cdpTake + ".mp3" && mp3.label === "MP3" && mp3.rate === "320", JSON.stringify(mp3).slice(0, 200));
check("  every library card has an mp3 chip named after the take", mp3.cards.length > 0 && mp3.cards.every(Boolean), `${mp3.cards.filter(Boolean).length}/${mp3.cards.length}`);
t = await hoverOn("#dlTakeMp3");
check("  (i) tip explains the bitrates", t?.on && /320 kbps/.test(t.text) && /128/.test(t.text), t?.text.slice(0, 80));
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
await ev(`(() => { const s = document.getElementById("mp3Rate"); s.value = "192"; s.dispatchEvent(new Event("change")); return true; })()`);
const mp3b = await ev(`({ page: document.getElementById("dlTakeMp3").getAttribute("href"), label: document.getElementById("dlTakeMp3").textContent,
  saved: localStorage.getItem("yue2.mp3kbps"),
  card: document.querySelector("#libList .take:not(.is-running-row) .take-mp3").getAttribute("href"),
  toasts: [...document.querySelectorAll(".toast")].map(t => t.textContent).join(" | ") })`);
check("choosing 192 kbps moves every MP3 link and is remembered", /kbps=192$/.test(mp3b.page) && mp3b.label === "MP3" &&
  /kbps=192$/.test(mp3b.card) && mp3b.saved === "192" && /MP3 downloads now at 192 kbps/.test(mp3b.toasts), JSON.stringify(mp3b).slice(0, 200));
await mockClear();
const mp3get = await fetch(BASE + mp3b.page.slice(1));
const mp3reqs = (await mockGet("mock/requests")).filter((r) => r.path === "/library/mp3");
check("  the link asks the server for that take at that bitrate", mp3get.status === 200 && mp3get.headers.get("content-type") === "audio/mpeg" &&
  mp3reqs.length === 1 && mp3reqs[0].name === cdpTake && mp3reqs[0].kbps === "192", JSON.stringify(mp3reqs));
await ev(`(() => { const s = document.getElementById("mp3Rate"); s.value = "320"; s.dispatchEvent(new Event("change")); return true; })()`);
const flacLink = await ev(`(() => { const a = document.getElementById("dlTakeFlac"); return { href: a.getAttribute("href"), file: a.getAttribute("download"),
  hidden: a.classList.contains("is-hidden") }; })()`);
check("song page has a FLAC download (lossless, from the WAV)", !flacLink.hidden && flacLink.href === "/library/flac?name=" + encodeURIComponent(cdpTake) &&
  flacLink.file === cdpTake + ".flac", JSON.stringify(flacLink));
const flacGet = await fetch(BASE + flacLink.href.slice(1));
check("  the server answers with a FLAC file named after the take", flacGet.status === 200 && flacGet.headers.get("content-type") === "audio/flac" &&
  (flacGet.headers.get("content-disposition") || "").includes(cdpTake + ".flac"));
t = await hoverOn("#dlTakeFlac");
check("  (i) tip says it is lossless", t?.on && /lossless/.test(t.text), t?.text.slice(0, 60));
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });

// a song that finishes while another plays must not stop it
await ev(`document.activeElement && document.activeElement.blur(); document.body.focus(); true`);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
check("a take is playing", !!(await waitFor(`!document.getElementById("audio").paused`, 3000)));
const playingSrc = await ev(`document.getElementById("audio").src`);
await ev(`(() => { const set = (id, v) => { document.getElementById(id).value = v; };
  set("title", "Keep Playing"); set("style", "English, pop, bright female voice"); set("lyrics", "[Verse]\\nla la la");
  set("lmSeed", ""); set("soundSeed", ""); set("versions", "1"); set("abc", ""); return true; })()`);
await click("#generateBtn");
// open the run while the other song plays: the player's waveform must stay
const waveCols = `(() => { const c = document.getElementById("wave"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let cols = 0; for (let i = 0; i < c.width; i++) { for (let j = 0; j < c.height; j++) { if (d[(j * c.width + i) * 4 + 3] > 0) { cols++; break; } } } return cols / c.width; })()`;
const wavedBefore = await ev(waveCols);
await waitFor(`!!document.querySelector("#libList .is-running-row")`, 8000, 100);
await click("#libList .is-running-row");
await sleep(400);
const wavedDuring = await ev(waveCols);
check("  opening the running song leaves the player's waveform alone", wavedBefore > 0.5 && wavedDuring > 0.5 &&
  !(await ev(`document.getElementById("chain").hidden`)), `${(wavedBefore * 100).toFixed(0)}% -> ${(wavedDuring * 100).toFixed(0)}% of the bar drawn`);
const landed = await waitFor(`fetch("/library").then(r => r.json()).then(l => l.takes.some(t => t.title === "Keep Playing"))`, 30000, 250);
await sleep(1200);
const after = await ev(`({ paused: document.getElementById("audio").paused, src: document.getElementById("audio").src,
  toasts: [...document.querySelectorAll(".toast")].map(t => t.textContent).join(" | ") })`);
check("the new song finished and was saved", !!landed);
check("  the playing song kept playing (same audio, not paused)", !after.paused && after.src === playingSrc, after.paused ? "paused" : "playing");
check("  the toast says so", /Keep Playing.*keeps playing/.test(after.toasts), after.toasts.slice(0, 160));
await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
await waitFor(`document.getElementById("audio").paused`, 2000);

// ================================================= browsing while a song plays
section("browsing while a song plays");
const rows = await ev(`[...document.querySelectorAll("#libList .take:not(.is-running-row)")].map(e => e.dataset.name)`);
const [songA, songB] = [rows[0], rows[1]];
await click(`#libList .take[data-name="${songA}"]`);
await sleep(300);
await ev(`document.activeElement && document.activeElement.blur(); document.body.focus(); true`);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
check("song A plays", !!(await waitFor(`!document.getElementById("audio").paused`, 3000)));
const srcA = await ev(`document.getElementById("audio").src`), barA = await ev(`document.getElementById("playbarTitle").textContent`);
t = await hoverOn("#playbarTitle");
check("the player shows just the song's name; its style prompt is on hover", (await ev(`!document.getElementById("playbarStyle")`)) === true && t?.on &&
  t.text === (await ev(`document.querySelector("#libList .take.is-playing .take-style")?.textContent || ""`)), t?.text);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
await click(`#libList .take[data-name="${songB}"]`);
await sleep(600);
const browse = await ev(`({ viewing: document.querySelector("#libList .take.is-active")?.dataset.name, playing: !document.getElementById("audio").paused,
  src: document.getElementById("audio").src, bar: document.getElementById("playbarTitle").textContent,
  playHere: !!document.getElementById("playHere") && !document.getElementById("playHere").classList.contains("is-hidden") })`);
check("opening song B shows it on screen", browse.viewing === songB, browse.viewing);
check("  while song A keeps playing (same audio, same playbar title)", browse.playing && browse.src === srcA && browse.bar === barA, browse.playing ? "playing" : "paused");
check("  and song B offers ▶ Play this song", browse.playHere);
const playingCards = () => ev(`[...document.querySelectorAll("#libList .take.is-playing")].filter(c => getComputedStyle(c.querySelector(".playing-tag")).display !== "none").map(c => c.dataset.name)`);
check("  in the list, song A's card says PLAYING and no other does", JSON.stringify(await playingCards()) === JSON.stringify([songA]), JSON.stringify(await playingCards()));
await click("#playHere");
const nowB = await waitFor(`!document.getElementById("audio").paused && document.getElementById("audio").src.includes(${JSON.stringify(encodeURIComponent(songB))})`, 4000);
check("pressing it switches the player to song B", !!nowB);
check("  the status says Playing", !!(await waitFor(`document.getElementById("statusText").textContent === "Playing"`, 2000, 100)));
check("  and the button hides again", await ev(`document.getElementById("playHere").classList.contains("is-hidden")`));
check("  PLAYING moves to song B's card", JSON.stringify(await playingCards()) === JSON.stringify([songB]), JSON.stringify(await playingCards()));
await click(`#libList .take[data-name="${songA}"]`);
await sleep(600);
check("browsing back to song A leaves song B playing", await ev(`!document.getElementById("audio").paused && document.getElementById("audio").src.includes(${JSON.stringify(encodeURIComponent(songB))})`));
// the status pill: Playing, and a click opens the song that plays; back to song A, song B keeps playing
check("  the status says Playing; clicking it opens the playing song", (await ev(`document.getElementById("statusText").textContent`)) === "Playing" &&
  !!(await (async () => { await click("#statusPill"); return waitFor(`document.querySelector("#libList .take.is-active")?.dataset.name === ${JSON.stringify(songB)}`, 3000, 100); })()));
await click(`#libList .take[data-name="${songA}"]`);
await sleep(400);
// the playing card is coloured (tinted card, solid badge), unlike the plain selected card beside it
const looks = await ev(`(() => { const bg = (s) => { const c = document.querySelector(s); return c ? getComputedStyle(c).backgroundColor : ""; };
  return { playing: bg('#libList .take.is-playing'), selected: bg('#libList .take.is-active'), badge: bg('#libList .take.is-playing .playing-tag') }; })()`);
check("  song B's card is coloured, not like the selected card", looks.badge !== "rgba(0, 0, 0, 0)" && looks.playing !== looks.selected && looks.playing !== "rgba(0, 0, 0, 0)", JSON.stringify(looks));
await shot("library-playing");
await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
check("Space still controls the player (pauses song B)", !!(await waitFor(`document.getElementById("audio").paused`, 2000)));
// the pause event reaches the page a beat after the audio reports paused
check("  paused, no card says PLAYING", !!(await waitFor(`document.querySelectorAll("#libList .take.is-playing").length === 0`, 2000, 100)),
  JSON.stringify(await playingCards()));
check("  the status says Paused", (await ev(`document.getElementById("statusText").textContent`)) === "Paused");
// song A is on screen, song B in the player: ▶ Play this song shows, on the left right after the title
const playPlace = await ev(`(() => { const b = document.getElementById("playHere").getBoundingClientRect(), t = document.getElementById("takeTitle").getBoundingClientRect();
  return { shown: !document.getElementById("playHere").classList.contains("is-hidden"), gap: Math.round(b.left - t.right), sameLine: Math.abs((b.top + b.bottom) / 2 - (t.top + t.bottom) / 2) < 16 }; })()`);
check("▶ Play this song sits on the left, right after the song's title", playPlace.shown && playPlace.gap >= 0 && playPlace.gap <= 24 && playPlace.sameLine, JSON.stringify(playPlace));
await shot("play-button");
// a real mouse double-click on song A's card in the list plays it
await ev(`(() => { const c = document.querySelector('#libList .take[data-name="${songA}"] .take-style') ||
  document.querySelector('#libList .take[data-name="${songA}"]'); c.scrollIntoView({ block: "center", behavior: "instant" }); return true; })()`);
await sleep(300);   // measured after the scroll has settled, then checked: the pointer must land on song A
const cardAt = await ev(`(() => { const c = document.querySelector('#libList .take[data-name="${songA}"] .take-style') ||
  document.querySelector('#libList .take[data-name="${songA}"]'); const r = c.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  return { x, y, hits: document.elementFromPoint(x, y)?.closest(".take")?.dataset.name || "" }; })()`);
check("  (the pointer is on song A's card)", cardAt.hits === songA, cardAt.hits);
for (const clickCount of [1, 2]) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: cardAt.x, y: cardAt.y, button: "left", clickCount });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cardAt.x, y: cardAt.y, button: "left", clickCount });
}
const dblPlays = await waitFor(`!document.getElementById("audio").paused && document.getElementById("audio").src.includes(${JSON.stringify(encodeURIComponent(songA))})`, 4000);
check("double-clicking a song in the list plays it", !!dblPlays, await ev(`document.getElementById("audio").src.split("name=")[1]`));
check("  its card says PLAYING, and the page shows it with no Play button", JSON.stringify(await playingCards()) === JSON.stringify([songA]) &&
  (await ev(`document.getElementById("playHere").classList.contains("is-hidden") && document.getElementById("renameInput") === null`)) === true,
  JSON.stringify(await playingCards()));
await ev(`document.getElementById("audio").pause(); true`);
await click(`#libList .take[data-name="${songB}"]`);
await sleep(300);

// ================================================================= plan
section("plan score only");
await mockClear();
await ev(`(() => { document.getElementById("abc").value = ""; document.getElementById("lmSeed").value = ""; document.getElementById("title").value = "Planned";
  document.querySelector('#modes input[value="melody"]').click(); return true; })()`);
await click("#planBtn");
const planBody = await waitFor(`fetch("/mock/requests").then(r => r.json()).then(a => a.filter(x => x.path === "/synth").map(x => x.body)[0] || null)`, 5000);
check("Plan score only sends plan_only", /"plan_only":true/.test(planBody || "") && /"cot":"melody"/.test(planBody || ""));
const planned = await waitFor(`document.getElementById("abc").value.startsWith("X:1") && document.getElementById("scoreDrawer").open`, 8000);
check("the planned score fills Supply your own score", !!planned);
check("  the music seed field takes the resolved seed", /^\d{6,}$/.test(await ev(`document.getElementById("lmSeed").value`)));
check("  the plan's score shows in the take column", (await ev(`!document.getElementById("takeBody").classList.contains("is-hidden") && document.getElementById("scoreAbc").textContent.startsWith("X:1")`)) === true);
const planStages = await ev(`[...document.querySelectorAll("#stages .stage")].map(e => e.dataset.key + ":" + e.dataset.s).join()`);
check("  only the score stage runs; music, sound and decode are skipped", planStages === "score:completed,tokens:skipped,sound:skipped,decode:skipped", planStages);
check("  no stage shows a negative time", !/-\d/.test(await ev(`document.getElementById("stages").innerText`)));
await shot("plan");
await ev(`document.getElementById("title").value = "From Plan"; true`);
await click("#generateBtn");
await waitFor(`document.getElementById("takeTitle").textContent === "From Plan" && !document.getElementById("takeBody").classList.contains("is-hidden")`, 12000);
const planMeta = await ev(`Object.fromEntries([...document.querySelectorAll("#metaGrid [data-field]")].map(d => [d.dataset.field, d.dataset.value]))`);
check("a song rendered from the planned score says Score: supplied", planMeta?.Score === "supplied", JSON.stringify(planMeta));
await fetch(BASE + "mock/flags", { method: "POST", body: JSON.stringify({ peaks: false }) });
await mockClear();
const other = await ev(`[...document.querySelectorAll("#libList .take:not(.is-running-row)")].map(e => e.dataset.name).find(n => /nachtzug/.test(n))`);
await click(`#libList .take[data-name="${other}"]`);
await waitFor(`document.getElementById("takeTitle").textContent === "Nachtzug"`, 4000);
for (let i = 0; i < 40 && !(await mockGet("mock/requests")).some((r) => r.path === "/library/audio" && !r.range); i++) await sleep(200);
const fallbackInk = await waitFor(`(() => { const c = document.getElementById("wave"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let cols = 0; for (let i = 0; i < c.width; i++) { for (let j = 0; j < c.height; j++) { if (d[(j * c.width + i) * 4 + 3] > 0) { cols++; break; } } } return cols > c.width * 0.6; })()`, 8000, 250);
const fb = await mockGet("mock/requests");
check("peaks route failing: the browser decodes the audio instead", !!fallbackInk && fb.some((r) => r.path === "/library/peaks") && fb.some((r) => r.path === "/library/audio" && !r.range),
  JSON.stringify({ other, ink: fallbackInk, reqs: fb.map((r) => r.path + (r.path === "/library/audio" ? (r.range ? ":range" : ":full") : "")) }));
await fetch(BASE + "mock/flags", { method: "POST", body: JSON.stringify({ peaks: true }) });

// ========================================================= transcription
section("transcription");
const setFile = (name, kind) => ev(`(() => {
  const rate = 8000, n = rate * 2, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / 8) * 8000), true);
  const bytes = ${JSON.stringify(kind)} === "junk" ? new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) : new Uint8Array(buf);
  const dt = new DataTransfer(); dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: "audio/wav" }));
  const input = document.getElementById("coverFile"); input.files = dt.files; return input.files.length; })()`);
await ev(`document.getElementById("coverDrawer").open = true; document.getElementById("abc").value = ""; true`);
await mockClear();
await setFile("tune.wav", "wav");
await ev(`(() => { const s = document.getElementById("coverTask"); s.value = "melody-vocal"; return true; })()`);
await click("#coverFromAudio");
const vocal = await waitFor(`document.getElementById("abc").value.startsWith("X:1") ? document.getElementById("abc").value : null`, 10000);
const tx = (await mockGet("mock/requests")).filter((r) => r.path === "/transcribe");
check("Vocal melody only posts audio with melody_only", tx.length === 1 && tx[0].fields.includes("audio") && tx[0].fields.includes("melody_only"), JSON.stringify(tx[0]));
check("  and keeps only the Vocal voice, without chords", !!vocal && /V: Vocal/.test(vocal) && !/V: Ins/.test(vocal) && !/"[A-G][^"]*"/.test(vocal), (vocal || "").split("\n").slice(5, 9).join(" / "));
check("  the mode switches to Melody only", (await ev(`document.querySelector('#modes input:checked').value`)) === "melody");
await mockClear();
await ev(`document.getElementById("abc").value = ""; document.getElementById("coverTask").value = "full"; true`);
await click("#coverFromAudio");
const full = await waitFor(`document.getElementById("abc").value.startsWith("X:1") ? document.getElementById("abc").value : null`, 10000);
const tx2 = (await mockGet("mock/requests")).filter((r) => r.path === "/transcribe");
check("Melody and chords sends no melody_only and keeps chords and both voices", tx2.length === 1 && !tx2[0].fields.includes("melody_only") &&
  !!full && /"D"/.test(full) && /V: Ins/.test(full));
check("  the mode switches to Full plan", (await ev(`document.querySelector('#modes input:checked').value`)) === "full");
await setFile("broken.ogg", "junk");
await click("#coverFromAudio");
const bad = await waitFor(`/Convert it to WAV or MP3/.test(document.getElementById("coverAudioStatus").textContent)`, 5000);
await ev(`document.getElementById("coverAudioStatus").scrollIntoView({ block: "center" }); true`);
check("a file the browser cannot read gets a plain message", !!bad, await ev(`document.getElementById("coverAudioStatus").textContent`));
await shot("transcription");

// ============================================================ cancel + fail
section("queued, cancel and failure");
await ev(`(() => { const set = (id, v) => { document.getElementById(id).value = v; }; set("title", "Cancel Me"); set("abc", ""); set("lmSeed", ""); set("soundSeed", "");
  set("style", "slow test MOCK-SLOW"); document.querySelector('#modes input[value="full"]').click(); return true; })()`);
await click("#generateBtn");
await waitFor(`document.getElementById("runState").dataset.s === "running"`, 5000);
await ev(`(() => { document.getElementById("title").value = "Queued Me"; document.getElementById("style").value = "folk"; return true; })()`);
await click("#generateBtn");
const queued = await waitFor(`document.getElementById("takeTitle").textContent === "Queued Me" && document.getElementById("runState").dataset.s === "queued" &&
  document.getElementById("runState").textContent === "Queued" ? document.getElementById("takeEyebrow").textContent : null`, 5000);
check("a run behind another shows as queued", queued === "waiting behind Cancel Me", queued);
const queuedSeeds = await waitFor(`/^music seed \\d{6,} · sound seed \\d{6,}$/.test(document.getElementById("runSeeds").textContent) ? document.getElementById("runSeeds").textContent : null`, 4000);
check("  its seeds come from the job status while it waits", !!queuedSeeds, queuedSeeds);
await shot("run-queued");
await click("#cancelRun");                                  // flags the waiting job
await click('#libList .is-running-row');                    // the running one is listed first
await waitFor(`document.getElementById("takeTitle").textContent === "Cancel Me" && document.getElementById("runState").dataset.s === "running"`, 4000);
await click("#cancelRun");
check("Cancel run stops the running job", !!(await waitFor(`document.getElementById("runState").dataset.s === "cancelled"`, 8000)));
check("  and the cancelled queued job never runs", !!(await waitFor(`!document.querySelector("#libList .is-running-row") &&
  ![...document.querySelectorAll("#libList .take-title")].some(e => e.textContent === "Queued Me")`, 8000)));
await ev(`document.getElementById("style").value = "fail test MOCK-FAIL"; document.getElementById("title").value = "Fail Me"; true`);
await click("#generateBtn");
const failedRun = await waitFor(`document.getElementById("runState").dataset.s === "failed" && !document.getElementById("runError").classList.contains("is-hidden")`, 10000);
check("a failed run shows the server's error", !!failedRun, await ev(`document.getElementById("runError").textContent`));
await shot("run-failed");

// ====================================================== engine settings
section("engine settings, presets and hardware");
await ev(`document.getElementById("view-engine").classList.remove("is-hidden"); window.scrollTo(0, 0); true`);
const settingsForm = `({ models: [...document.getElementById("setModel").options].map(o => o.value).join(), model: document.getElementById("setModel").value,
  ctx: document.getElementById("setMaxSeq").value, keep: document.getElementById("setKeepLoaded").checked, vae: document.getElementById("setVaeCore").value,
  preset: document.getElementById("memPreset").value })`;
const f0 = await ev(settingsForm);
check("Compute card shows /settings (models, context, keep loaded, VAE tiles)", f0.models === "BF16,Q8_0" && f0.model === "BF16" && f0.ctx === "0" &&
  f0.keep === false && f0.vae === "512" && f0.preset === "16", JSON.stringify(f0));
// an older page or settings.json may still send "precision": ignored, like any unknown key
const stale = await fetch(BASE + "settings", { method: "POST", body: JSON.stringify({ precision: "f32" }) });
const staleSettings = await mockGet("settings");
check("a stale precision from an older page is ignored (no error, not stored)", stale.ok && !("precision" in staleSettings), JSON.stringify(staleSettings));
check("  the top bar has no precision next to the backbone", !/Precision/.test(await ev(`document.getElementById("hwStats").innerText`)));
const strip = await ev(`document.getElementById("hwStats").innerText.replace(/\\s+/g, " ")`);
check("top bar shows the GPU and its memory from /hardware", /Mock GPU/.test(strip) && /VRAM \d+\.\d \/ 31\.8 GiB/.test(strip) && /Backbone BF16/.test(strip), strip);
check("Unload model is off while nothing is loaded", (await ev(`document.getElementById("unloadModel").disabled && document.getElementById("unloadNow").disabled`)) === true);
t = await hoverOn('[data-tip-ref="tip-model"]');
check("(i) beside Model explains BF16 and the quantized copies", t?.on && /BF16/.test(t.text) && /quantized/.test(t.text));
t = await hoverOn('[data-tip-ref="tip-keep"]');
check("(i) beside Keep loaded explains on and off", t?.on && /Off/.test(t.text) && /On/.test(t.text));
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
await mockClear();
await ev(`(() => { const p = document.getElementById("memPreset"); p.value = "8"; p.dispatchEvent(new Event("change")); return true; })()`);
const f8 = await ev(settingsForm);
check("8 GB preset fills Q8_0, context 12,288, unload after songs, VAE tiles 256", f8.model === "Q8_0" && f8.ctx === "12288" && f8.keep === false && f8.vae === "256",
  JSON.stringify(f8));
check("  a preset only fills the form (nothing sent yet)", (await mockGet("mock/requests")).filter((r) => r.path === "/settings").length === 0);
await click("#saveSettings");
await waitFor(`/Saved/.test([...document.querySelectorAll(".toast")].map(t => t.textContent).join())`, 5000);
const s8 = await mockGet("settings");
check("Save posts /settings and the server takes it", s8.model === "Q8_0" && s8.max_seq === 12288 && s8.vae_core === 256 && s8.keep_loaded === false, JSON.stringify(s8));
check("  the top bar follows (backbone, context)", !!(await waitFor(`/Backbone Q8_0/.test(document.getElementById("hwStats").innerText.replace(/\\s+/g, " ")) &&
  /Context 12,288/.test(document.getElementById("hwStats").innerText.replace(/\\s+/g, " "))`, 12000, 250)));
await mockClear();
await ev(`(() => { const i = document.getElementById("setMaxSeq"); i.value = "1000"; i.dispatchEvent(new Event("input")); return true; })()`);
await waitFor(`!document.getElementById("saveSettings").disabled`, 3000, 100);
await click("#saveSettings");
// the refusal is a toast, not a request: wait for it rather than a fixed pause
await waitFor(`[...document.querySelectorAll(".toast")].some(t => /Context size must be/.test(t.textContent))`, 3000, 100);
const ctxReqs = (await mockGet("mock/requests")).filter((r) => r.path === "/settings");
const ctxToasts = await ev(`[...document.querySelectorAll(".toast")].map(t => t.textContent).join(" | ")`);
check("a context outside 0 or 4,096..24,576 is refused before sending", ctxReqs.length === 0 && /Context size must be/.test(ctxToasts),
  `${ctxReqs.length} posts ${JSON.stringify(ctxReqs.map((r) => r.body))} · toasts: ${ctxToasts.slice(-200)}`);
await ev(`(() => { const p = document.getElementById("memPreset"); p.value = "32"; p.dispatchEvent(new Event("change")); return true; })()`);
await click("#saveSettings");
await waitFor(`(async () => (await (await fetch("/settings")).json()).keep_loaded)()`, 5000);
check("32 GB preset keeps models loaded, whole context, BF16", (await mockGet("settings")).keep_loaded === true && (await mockGet("settings")).max_seq === 0 &&
  (await mockGet("settings")).model === "BF16");
await shot("engine-settings");
await ev(`document.getElementById("view-engine").classList.add("is-hidden"); (() => { const set = (id, v) => { document.getElementById(id).value = v; };
  set("title", "Keep Song"); set("style", "folk, 90 BPM"); set("abc", ""); set("lmSeed", ""); set("soundSeed", ""); set("versions", "1"); return true; })()`);
await click("#generateBtn");
await waitFor(`document.getElementById("takeTitle").textContent === "Keep Song" && !document.getElementById("takeBody").classList.contains("is-hidden")`, 12000);
const resident = await waitFor(`!document.getElementById("unloadModel").disabled && /resident/.test(document.getElementById("engineDetail").textContent)`, 8000, 250);
check("with keep loaded on, the models stay after the song: Unload model lights up", !!resident, await ev(`document.getElementById("engineDetail").textContent`));
const keepMeta = await ev(`Object.fromEntries([...document.querySelectorAll("#metaGrid [data-field]")].map(d => [d.dataset.field, d.dataset.value]))`);
check("a new song has no precision row", !("Precision" in (keepMeta || {})) && keepMeta?.Model === "BF16", JSON.stringify({ p: keepMeta?.Precision, m: keepMeta?.Model }));
const hwLoaded = await ev(`[...document.querySelectorAll("#hwCard div")].map(d => d.innerText.replace(/\\s+/g, " ")).find(t => /^Loaded/.test(t))`);
check("  the Hardware card shows the BF16 models loaded (about 7.5 GiB)", /^Loaded\s*[67]\.\d GiB/.test(hwLoaded || ""), hwLoaded);
// a song made while the F32 option existed still says so: copy this song as an old F32 one
const libDir = TMP + "/mock-outputs/cdp", keepDir = readdirSync(libDir).find((d) => /keep-song/.test(d));
const oldDir = libDir + "/19990101-000000-old-f32-song";
cpSync(libDir + "/" + keepDir, oldDir, { recursive: true });
writeFileSync(oldDir + "/meta.json", JSON.stringify({ ...JSON.parse(readFileSync(oldDir + "/meta.json", "utf8")), title: "Old F32 Song", precision: "f32" }));
// and a saved request with the sliders moved: Composition at "highest", Performance tuned by hand, guidance 1.15
writeFileSync(oldDir + "/request.json", JSON.stringify({ ...JSON.parse(readFileSync(oldDir + "/request.json", "utf8")), cfg_scale: 1.15,
  abc_sampling: { temperature: 1.0, top_p: 0.97, top_k: 64 }, semantic_sampling: { temperature: 0.97, top_p: 0.95, top_k: 100 } }));
await ev(`document.getElementById("refreshLib").click(); true`);
await waitFor(`!!document.querySelector('#libList .take[data-name="19990101-000000-old-f32-song"]')`, 5000);
await click('#libList .take[data-name="19990101-000000-old-f32-song"]');
await waitFor(`document.getElementById("takeTitle").textContent === "Old F32 Song"`, 5000);
const oldMeta = await ev(`Object.fromEntries([...document.querySelectorAll("#metaGrid [data-field]")].map(d => [d.dataset.field, d.dataset.value]))`);
check("  an older song made in F32 still says so (the option since removed)", oldMeta?.Precision === "F32 (option since removed)", JSON.stringify(oldMeta?.Precision));
const oldShapes = await waitFor(`(() => { const m = Object.fromEntries([...document.querySelectorAll("#metaGrid [data-field]")].map(d => [d.dataset.field, d.dataset.value]));
  return m.Composition && m.Composition !== "…" ? m : null; })()`, 5000, 100);
check("  moved sliders: Composition highest, Performance custom with its values, Style influence highest", oldShapes?.Composition === "highest" &&
  oldShapes?.Performance === "custom: temperature 0.97 · top-p 0.95 · top-k 100" && oldShapes?.["Style influence"] === "highest",
  JSON.stringify({ c: oldShapes?.Composition, p: oldShapes?.Performance, s: oldShapes?.["Style influence"] }));
rmSync(oldDir, { recursive: true, force: true });
await ev(`document.getElementById("refreshLib").click(); true`);
await waitFor(`!document.querySelector('#libList .take[data-name="19990101-000000-old-f32-song"]')`, 5000);
await mockClear();
await click("#unloadModel");
const unloaded = await waitFor(`/Model unloaded — [\\d,]+ MB freed/.test([...document.querySelectorAll(".toast")].map(t => t.textContent).join())`, 6000);
check("Unload model posts /unload and says how much it freed", !!unloaded && (await mockGet("mock/requests")).some((r) => r.path === "/unload"),
  await ev(`[...document.querySelectorAll(".toast")].map(t => t.textContent).filter(t => /unloaded/.test(t)).pop()`));
check("  then it switches off again", !!(await waitFor(`document.getElementById("unloadModel").disabled && /not loaded/.test(document.getElementById("engineDetail").textContent)`, 4000)));
await ev(`(() => { const p = document.getElementById("memPreset"); p.value = "16"; p.dispatchEvent(new Event("change")); return true; })()`);
await click("#saveSettings");
await waitFor(`(async () => { const s = await (await fetch("/settings")).json(); return !s.keep_loaded && s.vae_core === 512; })()`, 5000);
check("16 GB preset: models unloaded after each song, VAE tiles 512", (await mockGet("settings")).keep_loaded === false && (await mockGet("settings")).vae_core === 512);
const pick0 = await ev(`(() => { const s = document.getElementById("modelPick"); return { options: [...s.options].map(o => o.value + "=" + o.textContent).join("|"),
  value: s.value, disabled: s.disabled }; })()`);
check("top-bar Model dropdown lists the backbones with sizes", pick0.options === "BF16=Model: BF16 (7.2 GB)|Q8_0=Model: Q8_0 (3.8 GB)" &&
  pick0.value === (await mockGet("settings")).model && !pick0.disabled, JSON.stringify(pick0));
t = await hoverOn("#modelPick");
check("  (i) tip explains the copies", t?.on && /BF16/.test(t.text) && /Q5_K_M/.test(t.text), t?.text.split("\n")[0]);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
await mockClear();
await ev(`(() => { const s = document.getElementById("modelPick"); s.value = "Q8_0"; s.dispatchEvent(new Event("change")); return true; })()`);
const picked = await waitFor(`/Model Q8_0/.test([...document.querySelectorAll(".toast")].map(t => t.textContent).join()) && document.getElementById("setModel").value === "Q8_0"`, 5000, 200);
const pickBodies = (await mockGet("mock/requests")).filter((r) => r.path === "/settings").map((r) => r.body);
check("choosing Q8_0 there posts only the model, and the Engine form follows", !!picked && pickBodies.length === 1 &&
  JSON.stringify(JSON.parse(pickBodies[0])) === '{"model":"Q8_0"}' && (await mockGet("settings")).model === "Q8_0", pickBodies.join());
await ev(`(() => { const s = document.getElementById("modelPick"); s.value = "BF16"; s.dispatchEvent(new Event("change")); return true; })()`);
check("  and back to BF16", !!(await waitFor(`(async () => (await (await fetch("/settings")).json()).model === "BF16")()`, 5000)));

// =============================================================== writer
section("idea writer (stand-in chat server)");
await mockClear();
await ev(`(() => { const u = document.getElementById("chatUrl"); u.value = location.origin + "/fakechat-loaded/v1"; u.dispatchEvent(new Event("change")); return true; })()`);
await waitFor(`document.getElementById("chatState").textContent === "ready"`, 5000);
// the Chat Server button: its state, the label that shows, its colour against the theme's, its size, its tip
const chatBtn = `(() => { const b = document.getElementById("chatLink"), r = b.getBoundingClientRect(), probe = document.createElement("i"); document.body.append(probe);
  const col = (v) => { probe.style.color = "var(" + v + ")"; return getComputedStyle(probe).color; };
  const out = { s: b.dataset.s, label: [...b.children].filter(e => getComputedStyle(e).visibility === "visible").map(e => e.textContent).join("|"),
    green: getComputedStyle(b).color === col("--good"), red: getComputedStyle(b).color === col("--bad"), w: Math.round(r.width), h: Math.round(r.height),
    radius: parseFloat(getComputedStyle(b).borderTopLeftRadius), tip: b.dataset.tip, status: document.getElementById("museStatus").textContent };
  probe.remove(); return out; })()`;
await ev(`document.getElementById("museDrawer").open = true; true`);
const chatOn = await ev(chatBtn);
check("chat server answering: a green square Chat Server Connected button, the model in its tip", chatOn.s === "on" && chatOn.label === "Chat Server Connected" && chatOn.green &&
  chatOn.radius <= 3 && /model-b/.test(chatOn.tip), JSON.stringify(chatOn));
const buttonPair = `(() => { const w = document.getElementById("museBtn").getBoundingClientRect(), c = document.getElementById("chatLink").getBoundingClientRect(),
  st = document.getElementById("museStatus"), sr = st.getBoundingClientRect();
  return { gap: Math.round(w.left - c.right), sameRow: Math.abs((w.top + w.bottom) / 2 - (c.top + c.bottom) / 2) < 2, status: st.textContent, statusBelow: !st.textContent || sr.top >= w.bottom }; })()`;
const ideaBox = await ev(`(() => { const box = document.getElementById("idea"), row = box.closest(".muse").getBoundingClientRect(), r0 = box.getBoundingClientRect();
  box.value = "a long idea ".repeat(40); box.dispatchEvent(new Event("input")); const r1 = box.getBoundingClientRect();
  box.value = ""; box.dispatchEvent(new Event("input")); const r2 = box.getBoundingClientRect();
  const w = document.getElementById("museBtn").getBoundingClientRect(), c = document.getElementById("chatLink").getBoundingClientRect();
  return { tag: box.tagName, fill: Math.round(r0.width / row.width * 100), one: Math.round(r0.height), grown: Math.round(r1.height), back: Math.round(r2.height),
    gap: Math.round(w.left - c.right), sameRow: Math.abs((w.top + w.bottom) / 2 - (c.top + c.bottom) / 2) < 2, hW: Math.round(w.height), hC: Math.round(c.height),
    wW: Math.round(w.width), wC: Math.round(c.width), left: Math.round(c.left - row.left),
    oldTag: !!document.getElementById("museTag"), oldHint: !!document.getElementById("structureHint"),
    ideaInfo: !!box.closest(".field").querySelector(".label .info"), modelInfo: !!document.getElementById("museModel").closest(".field").querySelector(".label .info"),
    structureTip: document.getElementById("structure").closest(".field").querySelector(".info")?.dataset.tip || "",
    stackedFill: Math.round(document.getElementById("structure").getBoundingClientRect().width / row.width * 100),
    modelUnder: document.getElementById("museModel").getBoundingClientRect().top >= document.getElementById("structure").getBoundingClientRect().bottom,
    modelFill: Math.round(document.getElementById("museModel").getBoundingClientRect().width / row.width * 100) }; })()`);
check("the idea box is a full line across that grows with its text, like the style box", ideaBox.tag === "TEXTAREA" && ideaBox.fill >= 90 && ideaBox.grown > ideaBox.one * 2 &&
  ideaBox.back === ideaBox.one, JSON.stringify(ideaBox));
check("  the Chat Server button and Write the brief sit together on the left, the same size", ideaBox.sameRow && ideaBox.gap >= 0 && ideaBox.gap <= 10 &&
  ideaBox.hW === ideaBox.hC && ideaBox.wW === ideaBox.wC && ideaBox.left <= 1, JSON.stringify(ideaBox));
check("  Structure and Writer model each on their own full line, the model under the structure", ideaBox.stackedFill >= 95 && ideaBox.modelFill >= 95 &&
  ideaBox.modelUnder, JSON.stringify({ structure: ideaBox.stackedFill, model: ideaBox.modelFill, under: ideaBox.modelUnder }));
check("  one chat server marker (no small tag); the (i)s sit on the labels; the structure's note is in its (i)", !ideaBox.oldTag && !ideaBox.oldHint &&
  ideaBox.ideaInfo && ideaBox.modelInfo && /Now: Verse, Chorus and Bridge/.test(ideaBox.structureTip), JSON.stringify({ tag: ideaBox.oldTag, hint: ideaBox.oldHint, tip: ideaBox.structureTip.slice(-80) }));
await ev(`document.getElementById("idea").focus(); true`);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8, text: "\r" });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
check("  Shift+Enter makes a new line in it (Enter still writes the brief)", (await ev(`document.getElementById("idea").value`)) === "\n", JSON.stringify(await ev(`document.getElementById("idea").value`)));
await ev(`document.getElementById("idea").value = ""; document.getElementById("idea").blur(); true`);
check("status names the loaded model only", /model-b/.test(await ev(`document.getElementById("chatHint").textContent`)) &&
  (await ev(`document.getElementById("museModel").textContent`)) === "model-b loaded on the chat server");
await ev(`document.getElementById("museDrawer").open = true; document.getElementById("idea").value = "a truck that will not start"; true`);
await click("#museBtn");
const brief = await waitFor(`document.getElementById("title").value === "Ridge Road" && /Truck/.test(document.getElementById("lyrics").value)`, 8000);
const chatReqs = (await mockGet("mock/requests")).filter((r) => /fakechat/.test(r.path));
check("Write the brief fills title, style and lyrics", !!brief);
const afterWrite = await ev(buttonPair);
check("  with the result line showing, the two buttons still sit together and the line goes under them", afterWrite.sameRow && afterWrite.gap >= 0 && afterWrite.gap <= 10 &&
  !!afterWrite.status && afterWrite.statusBelow, JSON.stringify(afterWrite));
check("  only the loaded model is ever asked (structured first, then plain)", chatReqs.length >= 2 && chatReqs.every((r) => r.model === "model-b") && chatReqs[0].json_schema && !chatReqs[1].json_schema,
  chatReqs.map((r) => r.model + (r.json_schema ? "+schema" : "")).join(", "));
await shot("writer");
await mockClear();
await ev(`(() => { const u = document.getElementById("chatUrl"); u.value = location.origin + "/fakechat-none/v1"; u.dispatchEvent(new Event("change")); return true; })()`);
await waitFor(`document.getElementById("chatState").textContent === "no model loaded"`, 5000);
const chatNone = await ev(chatBtn);
check("nothing loaded: writer refuses; the button's tip asks you to load one", (await ev(`document.getElementById("museBtn").disabled`)) === true &&
  chatNone.s === "on" && /no model loaded: load one there first/.test(chatNone.tip) &&
  /none yet · load a model/.test(await ev(`document.getElementById("museModel").textContent`)), JSON.stringify(chatNone));
await ev(`document.getElementById("museBtn").disabled = false; document.getElementById("museBtn").click(); true`);
await sleep(600);
check("  and sends no completion request", (await mockGet("mock/requests")).filter((r) => /fakechat/.test(r.path)).length === 0);
await ev(`(() => { const u = document.getElementById("chatUrl"); u.value = "http://127.0.0.1:9/v1"; u.dispatchEvent(new Event("change")); return true; })()`);
await waitFor(`document.getElementById("chatState").textContent === "not answering"`, 6000);
check("unreachable or blocked: says so plainly (CORS)", /CORS/.test(await ev(`document.getElementById("chatHint").textContent`)), await ev(`document.getElementById("chatHint").textContent`));
const chatOff = await ev(chatBtn);
check("  the button turns red, Chat Server Offline; the old line of text is now its tip", chatOff.s === "off" && chatOff.label === "Chat Server Offline" && chatOff.red &&
  chatOff.tip.startsWith("The chat server is not answering — check its address under Engine") && chatOff.status === "", JSON.stringify(chatOff));
check("  and it keeps its size between the two states", chatOff.w === chatOn.w && chatOff.h === chatOn.h, `connected ${chatOn.w}x${chatOn.h}, offline ${chatOff.w}x${chatOff.h}`);
await ev(`document.getElementById("chatLink").scrollIntoView({ block: "center", behavior: "instant" }); true`);
await sleep(200);
const chatAt = await ev(`(() => { const r = document.getElementById("chatLink").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: chatAt.x, y: chatAt.y });
await sleep(250);
const chatTip = await ev(`(() => { const t = document.querySelector(".tip.is-on"); return t ? t.textContent : ""; })()`);
check("  hovering it pops the text up", chatTip.startsWith("The chat server is not answering — check its address under Engine"), chatTip);
await shot("chat-offline");
await ev(`document.getElementById("chatUrl").value = location.origin + "/fakechat-loaded/v1"; true`);
await click("#chatLink");
const rechecked = await waitFor(`document.getElementById("chatLink").dataset.s === "on"`, 5000);
check("  clicking it checks again: the server is back, so it turns green", !!rechecked && (await ev(chatBtn)).label === "Chat Server Connected");
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
await ev(`localStorage.removeItem("yue2.chatUrl"); document.getElementById("museDrawer").open = false; true`);

// ===================================================== prompt files + extras
section("prompt files, example, lyrics export");
await ev(`(() => { window.__downloads = []; const real = URL.createObjectURL; URL.createObjectURL = (b) => { window.__lastBlob = b; return real(b); };
  HTMLAnchorElement.prototype.click = function () { if (this.download) window.__downloads.push({ name: this.download, blob: window.__lastBlob }); };
  const set = (id, v) => { document.getElementById(id).value = v; }; set("title", "Round Trip"); set("style", "English, folk, 90 BPM");
  set("lyrics", "[Verse]\\nOne line: with a colon\\n  indented # not a comment\\n\\n[Chorus]\\nEnd"); set("lmSeed", "9007199254740993"); set("soundSeed", "77"); set("abc", "");
  document.querySelector('#modes input[value="melody"]').click(); return true; })()`);
await click('#saveMenu [data-save="json"]');
await click('#saveMenu [data-save="yaml"]');
const saved = await ev(`Promise.all(window.__downloads.map(async d => ({ name: d.name, text: await d.blob.text() })))`);
check("Save writes JSON and YAML named after the song", saved?.length === 2 && saved[0].name === "round-trip.json" && saved[1].name === "round-trip.yaml", saved?.map((s) => s.name).join(", "));
check("  the JSON keeps the seed exact", /"lm_seed": 9007199254740993/.test(saved?.[0]?.text || ""));
await ev(`(() => { ["title", "style", "lyrics", "lmSeed", "soundSeed"].forEach(id => document.getElementById(id).value = ""); document.querySelector('#modes input[value="full"]').click(); return true; })()`);
await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(saved?.[1]?.text || "")}], "round-trip.yaml"));
  const i = document.getElementById("openFile"); i.files = dt.files; i.dispatchEvent(new Event("change")); return true; })()`);
const back = await waitFor(`document.getElementById("title").value === "Round Trip" ? { style: document.getElementById("style").value, lyrics: document.getElementById("lyrics").value,
  seed: document.getElementById("lmSeed").value, sound: document.getElementById("soundSeed").value, cot: document.querySelector('#modes input:checked').value } : null`, 3000);
check("Open reads the YAML back into the form exactly", back?.style === "English, folk, 90 BPM" && back?.lyrics === "[Verse]\nOne line: with a colon\n  indented # not a comment\n\n[Chorus]\nEnd" &&
  back?.seed === "9007199254740993" && back?.sound === "77" && back?.cot === "melody", JSON.stringify(back));
// every demo in turn (the button picks one at random): each fills the form and clears the sound seed
const exampleRuns = await ev(`(() => { const n = (window.YUE2_EXAMPLES || []).length, random = Math.random, bad = [];
  for (let i = 0; i < n; i++) {
    document.getElementById("soundSeed").value = "99";
    Math.random = () => (i + 0.5) / n;
    document.getElementById("loadExample").click();
    const ex = window.YUE2_EXAMPLES[i], f = { title: document.getElementById("title").value, style: document.getElementById("style").value,
      lyrics: document.getElementById("lyrics").value, sound: document.getElementById("soundSeed").value };
    // some official demos are terse (one has the style "funk"): compare with the demo itself
    if (!(f.style && f.style === String(ex.style || "").trim() && f.lyrics === (ex.lyrics || "") && f.sound === "")) bad.push(f);
  }
  Math.random = random;
  document.querySelectorAll(".toast").forEach((t) => t.remove());   // 110 toasts would bury later screenshots
  return { n, bad }; })()`);
check("Load example fills an official demo prompt and starts from a fresh sound seed (every demo)",
  exampleRuns.n > 0 && exampleRuns.bad.length === 0, JSON.stringify(exampleRuns).slice(0, 300));
await click(`#libList .take:not(.is-running-row)`);
await sleep(500);
await ev(`window.__downloads = []; document.getElementById("lyricsTxt").click(); document.getElementById("lyricsJson").click(); true`);
const lyr = await ev(`(async () => { const d = window.__downloads; if (d.length !== 2) return { n: d.length }; const txt = await d[0].blob.text(), json = JSON.parse(await d[1].blob.text());
  return { names: d.map(x => x.name), same: json.sections.map(s => s.text).join("") === json.lyrics && txt === json.lyrics, schema: json.schema, timing: json.timing }; })()`);
check("lyrics TXT and JSON export (sections rebuild the lyrics exactly)", lyr?.same === true && lyr.schema === "song-lyrics-v1" && lyr.timing === null && /\.lyrics\.txt$/.test(lyr.names[0]), JSON.stringify(lyr));

// ================================================================ themes
section("help for every setting");
const missingHelp = await ev(`YueHelp.missing()`);
check("every form and engine setting has an (i) or a tip", Array.isArray(missingHelp) && missingHelp.length === 0, JSON.stringify(missingHelp));
check("  all 14 sampler knobs have one", (await ev(`document.querySelectorAll(".knobs label.knob .info").length`)) === 14);
const foldedBefore = await ev(`[...document.querySelectorAll("details.drawer")].filter(d => !d.open).map(d => d.id)`);
await ev(`document.querySelectorAll("details.drawer").forEach(d => { d.open = true; }); true`);
t = await hoverOn(await ev(`(() => { const i = document.getElementById("odeSteps").closest(".field").querySelector(".info"); i.id = "odeInfo"; return "#odeInfo"; })()`));
check("  ODE steps explains the default, the cost of 64, and that the music does not change", t?.on && /32 is the release setting/.test(t.text) &&
  /twice as long/.test(t.text) && /does not change/.test(t.text), t?.text.slice(0, 80));
t = await hoverOn(await ev(`(() => { const i = document.querySelector('.knobs[data-group="semantic"] input[data-key="temperature"]').closest("label").querySelector(".info"); i.id = "tempInfo"; return "#tempInfo"; })()`));
check("  the music temperature (i) gives its default and when to lower it", t?.on && /default 1\.0/.test(t.text) && /garbled/.test(t.text), t?.text.slice(0, 80));
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
await ev(`${JSON.stringify(foldedBefore)}.forEach(id => { const d = document.getElementById(id); if (d) d.open = false; }); true`);
const tickBefore = await ev(`document.getElementById("instrumental").checked`);
await click('.instrumental-check .info');
check("pressing an (i) inside a label does not tick its box", (await ev(`document.getElementById("instrumental").checked`)) === tickBefore);
const sharedSame = await ev(`YueHelp.text.odeSteps === YueHelp.text.setOde`);
check("  ODE steps reads the same here and in the other console's engine card", sharedSame === true);

section("themes");
const themeIds = await ev(`YueThemes.list.map(t => t.id)`);
const grounds = [];
for (const th of themeIds) {
  await ev(`YueThemes.set("${th}"); true`);
  grounds.push(await ev(`getComputedStyle(document.body).backgroundColor`));
  if (["daylight", "nord", "solarized-light", "bold-sunflower", "jade", "bold-midnight-blue"].includes(th)) await shot("theme-" + th);
}
check("50 themes (41 new + the 9 hand-tuned), each painting its own background", themeIds.length === 50 && new Set(grounds).size >= 49,
  `${themeIds.length} themes, ${new Set(grounds).size} distinct backgrounds`);
check("the theme choice is remembered", (await ev(`localStorage.getItem("yue2.theme")`)) === themeIds[themeIds.length - 1]);
await ev(`YueThemes.set("studio"); localStorage.removeItem("yue2.themeFavorites"); localStorage.setItem("yue2.themeFamily", "all"); true`);
await click("#themeButton");
const tiles = () => ev(`[...document.querySelectorAll(".theme-popup .theme-choice")].map(b => b.dataset.themeId)`);
check("the theme button opens a swatch grid of every theme", (await ev(`YueThemes.isOpen()`)) && (await tiles()).length === 50);
await click('.theme-popup [data-family="bold"]');
const bold = await tiles();
await click('.theme-popup [data-family="soft"]');
const soft = await tiles();
check("  Bold / Soft filters", bold.length === 23 && soft.length === 12, `bold ${bold.length}, soft ${soft.length}`);
await ev(`(() => { const q = document.querySelector(".theme-popup .theme-search"); q.value = "jad"; q.dispatchEvent(new Event("input")); return true; })()`);
check("  search looks through every collection", JSON.stringify(await tiles()) === '["jade"]', JSON.stringify(await tiles()));
await ev(`(() => { const q = document.querySelector(".theme-popup .theme-search"); q.value = ""; q.dispatchEvent(new Event("input")); return true; })()`);
await click('.theme-popup [data-family="all"]');
const box = await ev(`(() => { const b = document.querySelector('.theme-popup .theme-choice[data-theme-id="bold-crimson"]'); b.scrollIntoView({ block: "center" });
  const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
await sleep(150);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
await sleep(150);
check("  hovering a theme previews it on the page, without keeping it",
  (await ev(`document.documentElement.dataset.theme`)) === "bold-crimson" && (await ev(`YueThemes.current()`)) === "studio");
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(100);
check("  Esc goes back to the kept theme and closes the picker", (await ev(`document.documentElement.dataset.theme`)) === "studio" && !(await ev(`YueThemes.isOpen()`)));
await click("#themeButton");
await click('.theme-popup .theme-star[data-star="jade"]');
await click('.theme-popup [data-family="favorites"]');
check("  ☆ adds a theme to Favorites", JSON.stringify(await tiles()) === '["jade"]' && /jade/.test(await ev(`localStorage.getItem("yue2.themeFavorites")`)));
await click('.theme-popup [data-family="all"]');
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });   // a resting pointer would preview what is under it
await ev(`document.querySelector('.theme-popup .theme-choice[data-theme-id="studio"]').focus(); true`);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
await sleep(80);
const moved = await ev(`({ focus: document.activeElement.dataset.themeId, shown: document.documentElement.dataset.theme })`);
check("  arrow keys move through the grid and preview as they go", !!moved.focus && moved.focus !== "studio" && moved.shown === moved.focus, JSON.stringify(moved));
await shot("theme-picker");
await click('.theme-popup .theme-choice[data-theme-id="bold-emerald"]');
check("clicking a theme keeps it: page, button and memory", (await ev(`YueThemes.current()`)) === "bold-emerald" && !(await ev(`YueThemes.isOpen()`)) &&
  /Emerald/.test(await ev(`document.getElementById("themeButton").textContent`)) && (await ev(`localStorage.getItem("yue2.theme")`)) === "bold-emerald");
t = await hoverOn('[data-tip-ref="tip-vae"]');
check("tips follow the theme", t?.on && (await ev(`getComputedStyle(document.querySelector(".tip")).backgroundColor`)) !== grounds[0]);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
await ev(`YueThemes.set("studio"); localStorage.removeItem("yue2.themeFavorites"); true`);

// ============================================================ delete rest
section("new song and seeds");
const diceOf = (box, dice) => ev(`({ v: document.getElementById("${box}").value, set: document.getElementById("${dice}").classList.contains("is-set"),
  tip: document.getElementById("${dice}").dataset.tip })`);
await ev(`document.getElementById("lmSeed").value = ""; document.getElementById("lmSeed").dispatchEvent(new Event("input")); true`);
await ev(`document.getElementById("rollLmSeed").click(); true`);
const rolled = await diceOf("lmSeed", "rollLmSeed");
check("the dice on an empty seed box puts a seed in (and its tip says it will clear it)", /^\d+$/.test(rolled.v) && rolled.set && /Clear the/.test(rolled.tip), JSON.stringify(rolled));
await ev(`document.getElementById("rollLmSeed").click(); true`);
const cleared = await diceOf("lmSeed", "rollLmSeed");
check("  pressed again it clears it: random", cleared.v === "" && !cleared.set && /Put in a random/.test(cleared.tip), JSON.stringify(cleared));
await ev(`(() => { const set = (id, v) => { document.getElementById(id).value = v; }; set("title", "Old"); set("style", "old style"); set("lyrics", "[Verse]\\nold");
  set("abc", "X:1"); set("lmSeed", "123"); document.querySelector('input[name="cot"][value="off"]').click(); document.getElementById("instrumental").checked = true;
  document.getElementById("versions").value = 3; YueLoras.set([{ id: "yue2-jpop-t4-lora/yue2_jpop_t4.safetensors", ar: 0, nar: 1 }]);
  const k = document.querySelector('input[data-group="semantic"][data-key="temperature"]'); k.value = "0.5"; return true; })()`);
await ev(`document.getElementById("newSong").click(); true`);
await sleep(300);
const blank = await ev(`({ fields: ["title", "style", "lyrics", "abc", "lmSeed"].map(id => document.getElementById(id).value).join(""),
  cot: document.querySelector('input[name="cot"]:checked').value, inst: document.getElementById("instrumental").checked,
  versions: document.getElementById("versions").value, loras: document.querySelectorAll("#loraPicker .lora-row").length,
  temp: document.querySelector('input[data-group="semantic"][data-key="temperature"]').value,
  toast: [...document.querySelectorAll(".toast")].map(t => t.textContent).join(" | ") })`);
check("＋ New song empties the form: fields, seed, score, mode, Instrumental, versions, LoRAs, sampling", blank.fields === "" && blank.cot === "full" &&
  !blank.inst && blank.versions === "1" && blank.loras === 0 && Number(blank.temp) === 1 && /New song: the form is back to its defaults/.test(blank.toast),
  JSON.stringify(blank).slice(0, 180));

section("style prompt size");
const styleBox = async () => ev(`({ h: document.getElementById("style").offsetHeight, meter: document.getElementById("styleMeter").textContent,
  over: document.getElementById("styleMeter").classList.contains("is-over"), warn: document.getElementById("styleMeter").classList.contains("is-warn") })`);
await ev(`document.getElementById("style").value = "pop"; document.getElementById("lyrics").value = "[Verse]\\nla"; true`);
await sleep(900);
const small = await styleBox();
await ev(`document.getElementById("style").value = Array(60).fill("dark cinematic synthwave with a slow build, analog pads, gated drums").join(", "); true`);
await sleep(900);
const big = await styleBox();
check("the style box grows with a long prompt set by the page", big.h > small.h + 60, `${small.h}px -> ${big.h}px`);
check("  the counter under it shows its size and the shared budget", /^4,198 characters, about 1,167 tokens\. Style and lyrics together: about 1,170 of 11,400 tokens\.$/.test(big.meter), big.meter);
await ev(`document.getElementById("lyrics").value = "la la la ".repeat(5000); true`);
await sleep(900);
const over = await styleBox();
check("  past the budget it turns red and says so", over.over && /too long for a full-length song and score/.test(over.meter), over.meter.slice(-80));
await ev(`document.getElementById("lyrics").value = "la la la ".repeat(3000); true`);
await sleep(900);
check("  near it, amber", (await styleBox()).warn);
check("  the style (i) gives the limit", /24,576/.test(await ev(`YueHelp.text.style`)) && /11,400 tokens/.test(await ev(`YueHelp.text.style`)));
await ev(`document.getElementById("style").value = ""; document.getElementById("lyrics").value = ""; true`);

section("copy the prompt");
await click(`#libList .take[data-name="${cdpTake}"]`);
await sleep(300);
await ev(`window.__clip = null; navigator.clipboard.writeText = (t) => { window.__clip = t; return Promise.resolve(); }; true`);
await click("#copyPrompt");
await sleep(300);
const clip = await ev(`({ clip: window.__clip, shown: document.getElementById("metaStyle").textContent,
  toasts: [...document.querySelectorAll(".toast")].map(t => t.textContent).join(" | ") })`);
check("the copy icon in the Prompt card copies the prompt as shown", !!clip.shown && clip.clip === clip.shown && /Prompt copied/.test(clip.toasts),
  (clip.clip || "").slice(0, 60));
t = await hoverOn("#copyPrompt");
check("  it says what it does on hover", t?.on && /Copy the prompt/.test(t.text));
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });

section("LoRAs");
const nativeCheck = (abc) => `(() => { try { const s = YueInstrumental.parse(${JSON.stringify(abc)}); return { vocal: s.voices.Vocal.notes.length,
  ins: s.voices.Ins.notes.length, chords: s.voices.Vocal.chords.length }; } catch (e) { return { error: e.message }; } })()`;
const synthAfter = async (n, ms = 12000) => waitFor(`fetch("/mock/requests").then(r => r.json()).then(a => { const b = a.filter(x => x.path === "/synth").map(x => JSON.parse(x.body));
  return b.length >= ${n} ? b : null; })`, ms, 200);
const loraChips = await ev(`[...document.querySelectorAll("#loraPicker [data-lora-chip]")].map(c => ({ text: c.textContent, off: c.disabled }))`);
check("the picker lists /props loras as even buttons: name, the half it steers, a few words; a broken file is shown but off", loraChips.length === 5 &&
  loraChips.some((c) => /^sv-billie\s*both\s*hushed bedroom pop$/.test(c.text)) && loraChips.some((c) => /^Industrial rock\s*music\s*riffs and drive$/.test(c.text)) &&
  loraChips.some((c) => /^yue2_jpop_t4\s*sound\s*Japanese pop$/.test(c.text)) && loraChips.filter((c) => c.off).length === 1, JSON.stringify(loraChips).slice(0, 300));
const pickGrid = await ev(`(() => { const b = [...document.querySelectorAll("#loraPicker [data-lora-chip]")].map(x => x.getBoundingClientRect());
  return { widths: [...new Set(b.map(r => Math.round(r.width)))], heights: [...new Set(b.map(r => Math.round(r.height)))] }; })()`);
check("  every LoRA button the same size (one grid, not a ragged row)", pickGrid.widths.length === 1 && pickGrid.heights.length === 1, JSON.stringify(pickGrid));
t = await hoverOn('#loraPicker [data-lora-chip="broken/bad.safetensors"]');
check("  its tip says why it cannot load", t?.on && /Cannot load: 1 tensors do not land/.test(t.text), t?.text.slice(0, 80));
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
await ev(`(() => { const set = (id, v) => { document.getElementById(id).value = v; }; set("title", "Lora Song"); set("style", "dark pop, 100 BPM");
  set("lyrics", "[Verse]\\nneon"); set("abc", ""); set("lmSeed", ""); set("soundSeed", ""); set("versions", "1");
  document.getElementById("instrumental").checked = false; document.querySelector('input[name="cot"][value="full"]').click(); return true; })()`);
await click('#loraPicker [data-lora-chip="yue2-jpop-t4-lora/yue2_jpop_t4.safetensors"]');
await click('#loraPicker [data-lora-chip="sv-billie-yue2-lora/sv_billie.safetensors"]');
const loraRows = await ev(`[...document.querySelectorAll("#loraPicker .lora-row")].map(r => [...r.querySelectorAll(".lora-half input")].map(i => i.disabled ? "off" : i.value).join("/"))`);
check("a tap adds a row with Music and Sound; the half a file lacks is off", JSON.stringify(loraRows) === '["off/1","1/1"]', JSON.stringify(loraRows));
const loraHint = await ev(`document.querySelector("#loraPicker .lora-hint").textContent`);
check("  hints: trigger words, and a Direct-trained LoRA used with a score", /jpstyle26/.test(loraHint) && /trained in Direct mode/.test(loraHint), loraHint.slice(0, 120));
await click('#loraPicker [data-trigger="jpstyle26"]');
check("  the trigger button puts the word in the style", (await ev(`document.getElementById("style").value`)) === "jpstyle26, dark pop, 100 BPM");
// the arrows reach the values the docs and model cards use (each box is put back as it was)
const arrows = await ev(`(() => {
  const up = (el, from) => { const was = el.value; el.value = from; el.stepUp(); const got = el.value; el.value = was; return got; };
  const knob = (g, k) => document.querySelector('input[data-group="' + g + '"][data-key="' + k + '"]');
  return { temp: up(knob("semantic", "temperature"), "0.87"), topP: up(knob("semantic", "top_p"), "0.97"),
    penMusic: up(knob("semantic", "repetition_penalty"), "1.23"), penScore: up(knob("abc", "repetition_penalty"), "1"),
    cfg: up(document.getElementById("cfg"), "1.00") }; })()`);
check("arrows reach documented values: temperature 0.88, top-p 0.975, penalty 1.24 / 1.005, guidance 1.01",
  +arrows.temp === 0.88 && +arrows.topP === 0.975 && +arrows.penMusic === 1.24 && +arrows.penScore === 1.005 && +arrows.cfg === 1.01, JSON.stringify(arrows));
const lora375 = await ev(`(() => { const r = document.querySelector('#loraPicker input[data-half="nar"][data-lora="sv-billie-yue2-lora/sv_billie.safetensors"]');
  r.value = "0.375"; r.dispatchEvent(new Event("input", { bubbles: true }));
  const got = { value: r.value, shown: r.nextElementSibling.textContent };
  r.value = "1"; r.dispatchEvent(new Event("input", { bubbles: true })); return got; })()`);
check("  a LoRA half takes a card's 0.375 and shows it as 0.375", lora375.value === "0.375" && lora375.shown === "0.375", JSON.stringify(lora375));
await ev(`(() => { const r = document.querySelector('#loraPicker input[data-half="ar"][data-lora="sv-billie-yue2-lora/sv_billie.safetensors"]');
  r.value = "0.5"; r.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
t = await hoverOn('fieldset [data-tip-ref="tip-loras"]');
check("(i) beside LoRAs explains the two halves", t?.on && /Music/.test(t.text) && /Sound/.test(t.text), t?.text.slice(0, 60));
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
await ev(`document.getElementById("view-engine").classList.remove("is-hidden"); true`);
const engineLoras = await ev(`({ rows: [...document.querySelectorAll("#loraCard > li")].map(li => ({ text: li.innerText.replace(/\\s+/g, " "),
  on: li.classList.contains("is-on"), bad: li.classList.contains("is-bad") })), note: document.getElementById("loraCardNote").textContent,
  under: document.getElementById("vaeCard").compareDocumentPosition(document.getElementById("loraCard")) & Node.DOCUMENT_POSITION_FOLLOWING,
  tall: Math.max(...[...document.querySelectorAll("#loraCard > li")].map(li => li.offsetHeight)) })`);
check("Engine panel lists the LoRAs as tiles under the VAEs: in use marked, a broken file in red", engineLoras.rows.length === 5 && !!engineLoras.under &&
  engineLoras.rows.filter((r) => r.on).length === 2 && engineLoras.rows.filter((r) => r.bad).length === 1 &&
  /5 in loras\/ · 2 in the song form/.test(engineLoras.note), JSON.stringify(engineLoras).slice(0, 200));
check("  every tile stays compact (no text squeezed into a sliver)", engineLoras.tall < 100, `tallest tile ${engineLoras.tall}px`);
const loraSrc = await ev(`(() => { const tile = (id) => document.querySelector('#loraCard > li[data-lora="' + id + '"]');
  const billie = tile("sv-billie-yue2-lora/sv_billie.safetensors"), rock = tile("yue2-industrial-rock-lora/adapter-ar-179/lora.safetensors"),
    jpop = tile("yue2-jpop-t4-lora/yue2_jpop_t4.safetensors"), link = billie.querySelector("a.tile-link");
  return { href: link && link.getAttribute("href"), target: link && link.target, text: link && link.textContent,
    info: billie.querySelector(".tile-src .info").dataset.tip, tileTip: billie.hasAttribute("data-tip"),
    rockMeta: rock.querySelector(".lora-item-meta").textContent, rockName: rock.querySelector(".lora-item-name").textContent, jpopRepo: (jpop.querySelector(".tile-repo") || {}).textContent }; })()`);
check("  each LoRA tile links its source (new tab) with an (i) recap beside it", loraSrc.href === "https://example.org/billie" &&
  loraSrc.target === "_blank" && /someone\/sv-billie/.test(loraSrc.text) && /Hushed bedroom pop\./.test(loraSrc.info) &&
  /rank 32/.test(loraSrc.info) && !loraSrc.tileTip, JSON.stringify(loraSrc));
check("  a file with no source entry shows its path; a source can supply a missing trigger word",
  loraSrc.jpopRepo === "no source link" && /trigger rockword/.test(loraSrc.rockMeta) && loraSrc.rockName === "Industrial rock", JSON.stringify(loraSrc));
const vaeTiles = () => ev(`[...document.querySelectorAll("#vaeCard > li")].map(li => ({ name: li.dataset.vae,
  on: String(li.classList.contains("is-on")), buttons: li.querySelectorAll("button").length, kind: (li.querySelector(".kind-badge") || {}).textContent || "",
  href: (li.querySelector("a.tile-link") || { getAttribute: () => "" }).getAttribute("href"), text: li.innerText.replace(/\\s+/g, " ") }))`);
let vt = await vaeTiles();
const formVae = () => ev(`document.querySelector("#decoders input:checked").value`);
const vae0 = await formVae();
check("Engine VAEs are tiles too: no switches, the form's VAE marked, STOCK / ADD-ON badges, links from sources.json (web links only)",
  vt.length === 3 && vt.every((v) => v.buttons === 0) && /in the song form/i.test(vt.find((v) => v.on === "true").text) && vt.filter((v) => v.on === "true").length === 1 && vt.find((v) => v.on === "true").name.toLowerCase() === vae0 &&
  vt[0].kind === "stock" && vt[2].kind === "add-on" && vt[1].kind === "stock" && vt[1].href === "" && vt[2].href === "https://example.org/blend" &&
  /m-a-p\/YuE2-Vae-legacy/.test(vt[1].text) && /engine default/.test(vt[0].text) &&
  /3 decoders · \w+ picked in the form/.test(await ev(`document.getElementById("vaeCardNote").textContent`)), JSON.stringify(vt).slice(0, 300));
const vaeInfo = await hoverOn('#vaeCard > li:nth-child(3) .tile-src .info');
check("  the (i) recaps it: what it is and its weights", vaeInfo?.on && /community weight mix/.test(vaeInfo.text) &&
  /Weights: Mothersuperior\/YuE2-Vae-merge-0\.666/.test(vaeInfo.text), vaeInfo?.text.slice(0, 80));
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
const otherVae = vae0 === "legacy" ? "blend" : "legacy";
await click(`#vaeCard > li[data-vae="${otherVae}"]`);
check("  clicking a tile does not change the song's VAE (the form picks it)", (await formVae()) === vae0);
await ev(`document.querySelector('#decoders input[value="${otherVae}"]').click(); true`);
vt = await vaeTiles();
check("  the mark follows the form's VAE buttons", vt.filter((v) => v.on === "true").length === 1 && vt.find((v) => v.on === "true").name === otherVae);
await ev(`document.querySelector('#decoders input[value="${vae0}"]').click(); true`);
check("  and back", (await vaeTiles()).find((v) => v.on === "true").name === vae0);
const loraTiles = await ev(`({ buttons: document.querySelectorAll("#loraCard button").length,
  marked: [...document.querySelectorAll("#loraCard > li.is-on")].map(li => li.dataset.lora) })`);
check("  LoRA tiles are for reading (no buttons): the ones in the song form are marked", loraTiles.buttons === 0 &&
  loraTiles.marked.join() === "sv-billie-yue2-lora/sv_billie.safetensors,yue2-jpop-t4-lora/yue2_jpop_t4.safetensors", JSON.stringify(loraTiles));
await ev(`document.getElementById("loraCard").scrollIntoView({ block: "center" }); true`);
await shot("engine-loras");
await ev(`document.getElementById("view-engine").classList.add("is-hidden"); true`);
await mockClear();
await click("#generateBtn");
const loraBody = (await synthAfter(1, 6000) || [])[0];
check("Generate sends the chosen LoRAs and strengths", !!loraBody && JSON.stringify(loraBody.loras) ===
  '[{"id":"yue2-jpop-t4-lora/yue2_jpop_t4.safetensors","ar":0,"nar":1},{"id":"sv-billie-yue2-lora/sv_billie.safetensors","ar":0.5,"nar":1}]',
  JSON.stringify(loraBody && loraBody.loras));
await waitFor(`document.getElementById("takeTitle").textContent === "Lora Song" && !document.getElementById("takeBody").classList.contains("is-hidden")`, 12000, 200);
const loraMeta = await ev(`Object.fromEntries([...document.querySelectorAll("#metaGrid [data-field]")].map(d => [d.dataset.field, d.dataset.value]))`);
check("  the song's info lists them", loraMeta?.LoRAs === "yue2_jpop_t4 (sound 1.0), sv-billie (music 0.5 · sound 1.0)", loraMeta?.LoRAs);
const loraRowsShown = await ev(`(() => { const n = [...document.querySelectorAll('#metaGrid [data-field="LoRAs"] .name')], a = [...document.querySelectorAll('#metaGrid [data-field="LoRAs"] .amt')];
  return n.map((e, i) => e.textContent + " = " + a[i].textContent).join(" | "); })()`);
check("  one row per LoRA, its halves together, strengths in their own column", loraRowsShown === "yue2_jpop_t4 = sound 1.00 | sv-billie = music 0.50 · sound 1.00", loraRowsShown);
await click("#clearForm");
check("Clear empties the picker", (await ev(`document.querySelectorAll("#loraPicker .lora-row").length`)) === 0);
await click("#reuseTake");
await sleep(400);
const loraReused = await ev(`[...document.querySelectorAll("#loraPicker .lora-row .lora-name")].map(n => n.textContent)`);
check("Reuse this take brings its LoRAs back", JSON.stringify(loraReused) === '["yue2_jpop_t4","sv-billie"]', JSON.stringify(loraReused));
const badLora = async (loras) => { const r = await fetch(BASE + "synth", { method: "POST", body: JSON.stringify({ style: "pop", lyrics: "[Verse]\nla", loras }) });
  return r.status + " " + ((await r.json()).error || ""); };
check("the server refuses an unknown LoRA, a broken one, and strengths past 2", /^400 unknown LoRA/.test(await badLora([{ id: "nope.safetensors" }])) &&
  /^400 the LoRA bad cannot load/.test(await badLora([{ id: "broken/bad.safetensors" }])) &&
  /^400 LoRA strengths go from 0 to 2/.test(await badLora([{ id: "yue2-jpop-t4-lora/yue2_jpop_t4.safetensors", ar: 0, nar: 3 }])));
await click("#clearForm");

section("instrumental (the official recipe)");
t = await hoverOn('[data-tip-ref="tip-instrumental"]');
check("(i) beside Instrumental explains the recipe", t?.on && /vocal note/.test(t.text) && /no spoken words/.test(t.text) && /Melody mode/.test(t.text), t?.text.slice(0, 70));
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
await mockClear();
await ev(`(() => { const set = (id, v) => { document.getElementById(id).value = v; }; set("title", "Inst Song"); set("style", "dark synthwave, 100 BPM");
  set("lyrics", "[Verse]\\nneon rain on the glass\\n\\n[Chorus]\\nwe run"); set("abc", ""); set("lmSeed", ""); set("soundSeed", ""); set("versions", "1");
  document.querySelector('input[name="cot"][value="full"]').click(); document.getElementById("instrumental").checked = true; return true; })()`);
await click("#generateBtn");
const instBodies = await synthAfter(2);
const [instPlan, instRender] = instBodies || [];
check("with no score, Generate plans one first (your lyrics shape it)", !!instPlan && instPlan.plan_only === true && instPlan.cot === "full" &&
  /neon rain/.test(instPlan.lyrics) && instPlan.style === "dark synthwave, 100 BPM", JSON.stringify(instPlan && { plan: instPlan.plan_only, cot: instPlan.cot }));
const renderScore = instRender ? await ev(nativeCheck(instRender.abc)) : {};
check("  then renders it with the vocal line moved to the instrument", !!instRender && !instRender.plan_only && renderScore.vocal === 0 && renderScore.ins > 0,
  JSON.stringify(renderScore));
check("  instrumental style, section-only lyrics, Full mode (the score has chords)", !!instRender &&
  instRender.style === "Instrumental, dark synthwave, 100 BPM, no vocals, no singing, no choir, no spoken words." &&
  instRender.lyrics === "[Intro]\n\n[Verse]\n\n[Chorus]\n" && instRender.cot === "full" && renderScore.chords > 0,
  JSON.stringify(instRender && { style: instRender.style.slice(0, 40), lyrics: instRender.lyrics, cot: instRender.cot }));
check("  it keeps the plan's music seed", !!instRender && !!instPlan && instRender.lm_seed !== undefined, instRender && instRender.lm_seed);
const instTake = await waitFor(`document.getElementById("takeTitle").textContent === "Inst Song" && !document.getElementById("takeBody").classList.contains("is-hidden")`, 12000, 200);
check("  and the song lands", !!instTake);
const formAfter = await ev(`({ style: document.getElementById("style").value, lyrics: document.getElementById("lyrics").value, abcNative: document.getElementById("abc").value.length })`);
check("  your style and lyrics fields are left as written; the converted score is in the score field", formAfter.style === "dark synthwave, 100 BPM" &&
  /neon rain/.test(formAfter.lyrics) && formAfter.abcNative > 0, JSON.stringify(formAfter).slice(0, 120));
// a score already in the field converts straight away: one render, no plan
await mockClear();
await ev(`(() => { const set = (id, v) => { document.getElementById(id).value = v; }; set("title", "Inst Direct"); set("lyrics", "");
  document.querySelector('input[name="cot"][value="off"]').click(); return true; })()`);
await click("#generateBtn");
const direct = await synthAfter(1, 6000);
await sleep(500);
const directAll = (await mockGet("mock/requests")).filter((r) => r.path === "/synth").map((r) => JSON.parse(r.body));
check("with a score present it renders straight away, even from Direct mode (the score sets the mode)", !!direct && directAll.length === 1 &&
  !directAll[0].plan_only && directAll[0].cot === "full" && /^Instrumental, /.test(directAll[0].style), JSON.stringify(directAll.map((b) => ({ plan: !!b.plan_only, cot: b.cot }))));
await waitFor(`document.getElementById("takeTitle").textContent === "Inst Direct"`, 12000, 200);
// empty lyrics: the plan gets a bare section skeleton
await mockClear();
await ev(`(() => { const set = (id, v) => { document.getElementById(id).value = v; }; set("title", "Inst Bare"); set("abc", ""); set("lyrics", "");
  document.querySelector('input[name="cot"][value="melody"]').click(); return true; })()`);
await click("#generateBtn");
const bare = await synthAfter(2);
check("with no lyrics the plan gets Intro/Verse/Chorus/Outro, and a chordless (melody) plan renders in Melody mode", !!bare &&
  bare[0].lyrics === "[Intro]\n\n[Verse]\n\n[Chorus]\n\n[Outro]\n" && bare[0].cot === "melody" && bare[1].cot === "melody",
  JSON.stringify(bare && bare.map((b) => ({ plan: !!b.plan_only, cot: b.cot, lyrics: b.lyrics.slice(0, 20) }))));
await waitFor(`document.getElementById("takeTitle").textContent === "Inst Bare"`, 12000, 200);
// the drawer button converts in place and ticks the switch
await ev(`document.getElementById("instrumental").checked = false; document.getElementById("abc").value = ${JSON.stringify("")}; true`);
await click('[data-abc="score"]');
await click("#abcInstrumental");
const drawer = await ev(`({ ticked: document.getElementById("instrumental").checked, score: ${nativeCheck("").replace('YueInstrumental.parse("")', 'YueInstrumental.parse(document.getElementById("abc").value)')},
  toasts: [...document.querySelectorAll(".toast")].map(t => t.textContent).join(" | ") })`);
check("Make instrumental converts the score in the field and ticks Instrumental", drawer.ticked && drawer.score.vocal === 0 && drawer.score.ins > 0 &&
  /vocal notes moved to the instrument/.test(drawer.toasts), JSON.stringify(drawer).slice(0, 160));
await mockClear();
await ev(`document.getElementById("abc").value = "X:1\\nnot a native score"; true`);
await click("#generateBtn");
await sleep(600);
const refusedInst = await ev(`[...document.querySelectorAll(".toast")].map(t => t.textContent).join(" | ")`);
check("a score outside the native dialect is refused with the reason, nothing is sent",
  /Cannot make this score instrumental: Incomplete native two-voice ABC/.test(refusedInst) &&
  (await mockGet("mock/requests")).filter((r) => r.path === "/synth").length === 0, refusedInst.slice(-120));
await ev(`document.getElementById("instrumental").checked = false; document.getElementById("abc").value = ""; true`);

section("a take made as MP3");
await ev(`(() => { const set = (id, v) => { document.getElementById(id).value = v; }; set("title", "Mp3 Song"); set("style", "folk"); set("lyrics", "[Verse]\\nla la");
  set("abc", ""); set("lmSeed", ""); set("soundSeed", ""); set("versions", "1");
  const f = document.getElementById("outFormat"); f.value = "mp3"; f.dispatchEvent(new Event("change")); return true; })()`);
await click("#generateBtn");
const mp3Take = await waitFor(`document.getElementById("takeTitle").textContent === "Mp3 Song" && !document.getElementById("takeBody").classList.contains("is-hidden") &&
  document.querySelector("#libList .take.is-active")?.dataset.name`, 12000, 200);
const mp3View = await ev(`({ audio: document.getElementById("dlTakeAudio").textContent, flac: document.getElementById("dlTakeFlac").classList.contains("is-hidden"),
  mp3: document.getElementById("dlTakeMp3").classList.contains("is-hidden"), rate: document.getElementById("mp3Rate").classList.contains("is-hidden"),
  chip: !!document.querySelector("#libList .take.is-active .take-mp3") })`);
check("an MP3 take offers its own MP3 download, and no FLAC or MP3 conversion", !!mp3Take && mp3View.audio === "MP3" && mp3View.flac && mp3View.mp3 &&
  mp3View.rate && !mp3View.chip, JSON.stringify(mp3View));
const flacRefused = await fetch(BASE + "library/flac?name=" + encodeURIComponent(mp3Take || ""));
check("  and the server refuses a FLAC of it (400)", flacRefused.status === 400);
await ev(`(() => { const f = document.getElementById("outFormat"); f.value = "wav24"; f.dispatchEvent(new Event("change")); return true; })()`);

section("delete non-favourites");
await click("#libMenuBtn");
await click("#deleteNonFav");
const onlyFav = await waitFor(`document.querySelectorAll("#libList .take:not(.is-running-row)").length === 1`, 20000, 200);
const left = await serverTakes();
check("Delete non-favourites keeps only the favourite", !!onlyFav && left.length === 1 && left[0].favorite === true, `${left.length} left`);
await shot("library-favourites");

section("a server without transcriber or library");
await fetch(BASE + "mock/flags", { method: "POST", body: JSON.stringify({ transcriber: false, outputs: false }) });
check("the page reloads against the switched-off server", !!(await navigate(0)));
check("no transcriber: the button is off and says how to get one", (await ev(`document.getElementById("coverFromAudio").disabled && /--transcriber/.test(document.getElementById("coverAudioStatus").textContent)`)) === true);
check("no library: the list says the takes stay in this tab", /keeps no library/.test(await ev(`document.getElementById("libList").innerText`)));
await ev(`(() => { const set = (id, v) => { document.getElementById(id).value = v; }; set("title", "Tab Song"); set("style", "folk"); set("lyrics", "[Verse]\\nla la");
  set("abc", ""); set("lmSeed", ""); set("soundSeed", ""); set("versions", "1"); return true; })()`);
await click("#generateBtn");
const tabTake = await waitFor(`document.getElementById("takeTitle").textContent === "Tab Song" && document.getElementById("audio").src.startsWith("blob:")`, 12000);
check("the finished song is fetched from the job and kept in the tab", !!tabTake);
check("  it plays from memory and gets a waveform", !!(await waitFor(`(() => { const c = document.getElementById("wave"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let cols = 0; for (let i = 0; i < c.width; i++) { for (let j = 0; j < c.height; j++) { if (d[(j * c.width + i) * 4 + 3] > 0) { cols++; break; } } } return cols > c.width * 0.6; })()`, 6000, 250)));
const tabDl = await ev(`["dlTakeFlac", "dlTakeMp3", "mp3Rate"].map(id => document.getElementById(id).classList.contains("is-hidden"))`);
check("  a song kept only in the tab offers no FLAC or MP3 conversion", tabDl.every(Boolean), JSON.stringify(tabDl));
await shot("no-library");
await fetch(BASE + "mock/flags", { method: "POST", body: JSON.stringify({ transcriber: true, outputs: true }) });

section("page health");
check("no script errors during the whole run", errors.length === 0, errors.slice(0, 3).join(" | ") || "none");
report();
finish(failed ? 1 : 0);
