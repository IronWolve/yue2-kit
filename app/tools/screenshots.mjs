// Clean screenshots of the page for the README and the kit (docs/screenshots): the stand-in server
// (tools/mock_server.py) with this install's real LoRAs, sliders and their sources, a plain GPU name, and
// one made-up song made through the page. No test fixtures, no toasts. Headless Chrome, nothing outside tmp/.
//
//   node tools/screenshots.mjs                          uses tmp/showcase/props.json, saved earlier
//   node tools/screenshots.mjs http://127.0.0.1:41867/  first saves that server's /props there (one read-only GET)
//
// Writes tmp/shots/showcase/: compose-page, song-page, song-page-narrow, engine-page, engine-tiles,
// engine-about, theme-picker (.png). tools/make-kit.sh copies them into the kit.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chromeTmp, findChrome, freshProfile, makeSend, stopChrome } from "./cdp-common.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = ROOT + "/tmp", HOME = TMP + "/chrome-home", OUT = TMP + "/shots/showcase", PROPS = TMP + "/showcase/props.json";
const G = "\x1b[32m", R = "\x1b[31m", C = "\x1b[36m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stop = (msg) => { console.log(`${R}stopped${X}  ${msg}`); process.exit(2); };
mkdirSync(OUT, { recursive: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(dirname(PROPS), { recursive: true });

// ---------------------------------------------------------------- preflight
const page = TMP + "/console.html";
if (!existsSync(page)) stop("tmp/console.html is missing: run ./build-page.sh first");
const newest = Math.max(...["index.html", "app.css", "app.js"].map((f) => statSync(ROOT + "/build/tools/console/" + f).mtimeMs));
if (statSync(page).mtimeMs < newest) stop("tmp/console.html is older than its sources: run ./build-page.sh");
if (process.argv[2]) {
  const url = process.argv[2].replace(/\/?$/, "/") + "props";
  let text;
  try { text = await (await fetch(url)).text(); JSON.parse(text).loras.length; } catch (e) { stop(`could not read ${url}: ${e.message}`); }
  writeFileSync(PROPS, text);
  console.log(`${G}saved${X}  ${url} -> tmp/showcase/props.json`);
}
if (!existsSync(PROPS)) stop("no tmp/showcase/props.json: run once with a running server's address, e.g. node tools/screenshots.mjs http://127.0.0.1:41867/");
const props = JSON.parse(readFileSync(PROPS, "utf8"));
const CHROME = findChrome();
if (!CHROME) stop("no Chrome or Chromium found: install one, or set YUE2_CHROME=/path/to/chrome");

const env = { ...process.env, HOME, XDG_CONFIG_HOME: HOME + "/.config", XDG_CACHE_HOME: HOME + "/.cache",
              XDG_DATA_HOME: HOME + "/.local/share", TMPDIR: TMP, PYTHONDONTWRITEBYTECODE: "1" };

// ------------------------------------------------------------- mock server
const mock = spawn("nice", ["-n", "15", "python3", ROOT + "/tools/mock_server.py", "--port", "0", "--outputs", TMP + "/mock-outputs/showcase",
  "--reset", "--demo", "3", "--speed", "3", "--quiet", "--props", PROPS, "--gpu-name", "32 GB card"], { env, stdio: ["ignore", "pipe", "pipe"] });
const BASE = await new Promise((ok, fail) => {
  let text = "";
  const timer = setTimeout(() => fail(new Error("the mock server did not start within 90 s: " + text.slice(-400))), 90000);
  const read = (d) => { text += d; const m = text.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(timer); ok(`http://127.0.0.1:${m[1]}/`); } };
  mock.stdout.on("data", read);
  mock.stderr.on("data", read);
  mock.on("exit", (code) => { clearTimeout(timer); fail(new Error("the mock server exited " + code + ": " + text.slice(-400))); });
}).catch((e) => stop(e.message));

// ------------------------------------------------------------------ chrome
const PROFILE = freshProfile(HOME, "profile-showcase");
const CHROME_TMP = chromeTmp(TMP);
const chrome = spawn("nice", ["-n", "15", CHROME, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--hide-scrollbars", "--user-data-dir=" + PROFILE, "--remote-debugging-port=0", "about:blank"],
  { env: { ...env, TMPDIR: CHROME_TMP }, stdio: ["ignore", "ignore", "pipe"] });
const finish = async (code) => {
  try { mock.kill("SIGTERM"); } catch {}
  await stopChrome(chrome, PROFILE, CHROME_TMP);
  process.exit(code);
};
process.on("unhandledRejection", (e) => { console.log(`${R}stopped${X}  ${e?.message || e}`); finish(2); });
setTimeout(() => { console.log(`${R}stopped${X}  timed out after 120 s`); finish(2); }, 120000);
let port;
for (let i = 0; i < 300 && !port; i++) {
  await sleep(200);
  if (existsSync(PROFILE + "/DevToolsActivePort")) port = readFileSync(PROFILE + "/DevToolsActivePort", "utf8").split("\n")[0];
}
if (!port) { console.log(`${R}stopped${X}  Chrome did not start within 60 s`); await finish(2); }
const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === "page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0;
const pending = new Map(), errors = [];
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errors.push((d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text).split("\n")[0]);
});
const send = makeSend(ws, pending, () => ++seq);
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error("page script: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).split("\n")[0]);
  return r.result?.result?.value;
};
const waitFor = async (expr, what, timeout = 15000) => {
  const until = Date.now() + timeout;
  for (;;) {
    if (await ev(expr)) return;
    if (Date.now() > until) throw new Error("waited " + timeout / 1000 + " s for " + what);
    await sleep(100);
  }
};
const size = (width, height) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
const shots = [];
const shot = async (name) => {
  await ev(`document.querySelectorAll(".toast").forEach(t => t.remove()); true`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });   // no hover tips, no previews
  await sleep(250);
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64"));
  shots.push(name);
};

// ------------------------------------------------------------------ pages
await send("Page.enable");
await send("Runtime.enable");
await size(1920, 960);
await send("Page.navigate", { url: BASE });
await waitFor(`document.readyState === "complete" && document.querySelectorAll("#decoders input").length === 3 &&
  document.querySelectorAll("#libList .take").length >= 3 && document.getElementById("logState").textContent === "live"`, "the page to load");

// a song in the form: the Female slider, one LoRA, the default VAE
const lora = (props.loras.find((l) => /sv_billie/.test(l.id)) || props.loras.find((l) => !l.error) || {}).id;
await ev(`(() => { const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); };
  set("title", "Last Train Home");
  set("style", "English, indie folk, warm female voice, acoustic guitar, soft piano, brushed drums, 84 BPM");
  set("lyrics", "[Verse]\\nPlatform lights are humming low\\nThe board says ten past twelve\\nI kept your scarf, I kept the ticket\\nKept the rest all to myself\\n\\n" +
    "[Chorus]\\nOh the last train home\\nRolls on without me\\nOne more night alone\\nWhere the tracks run out to sea\\n\\n" +
    "[Verse]\\nEvery window holds a stranger\\nEvery stranger holds a name\\nI could call you from the station\\nBut the silence sounds the same\\n\\n" +
    "[Chorus]\\nOh the last train home\\nRolls on without me\\nOne more night alone\\nWhere the tracks run out to sea");
  document.querySelector('#sliderChips [data-slider="female"]')?.click();
  const s = document.querySelector('#sliderActive input[data-strength="female"]'); if (s) { s.value = "0.5"; s.dispatchEvent(new Event("input", { bubbles: true })); }
  ${lora ? `document.querySelector('#loraPicker [data-lora-chip="${lora}"]')?.click();` : ""}
  document.getElementById("view-compose").scrollTop = 0; return true; })()`);
await shot("compose-page");

await ev(`document.getElementById("generateBtn").click(); true`);
await waitFor(`!document.getElementById("takeBody").classList.contains("is-hidden") && document.getElementById("takeTitle").textContent === "Last Train Home"`, "the song to finish", 30000);
await waitFor(`(() => { const m = document.querySelector('#metaGrid [data-field="Composition"]'); return m && m.dataset.value !== "…"; })()`, "the song details");
await sleep(600);   // the waveform and the score
await ev(`document.getElementById("view-take").scrollTop = 0; true`);
await shot("song-page");
await size(1280, 800);
await sleep(400);
await shot("song-page-narrow");
await size(1920, 960);
await sleep(300);

await ev(`document.getElementById("engineToggle").click(); true`);
await sleep(500);
await shot("engine-page");
await ev(`document.getElementById("loraCard").scrollIntoView({ block: "center", behavior: "instant" }); true`);
await shot("engine-tiles");
// the very end, so the About card's last line clears the player bar
await ev(`(() => { for (const e of [document.getElementById("view-engine"), document.scrollingElement]) e.scrollTop = e.scrollHeight; return true; })()`);
await shot("engine-about");
await ev(`document.getElementById("engineBack").click(); true`);
await sleep(300);

await ev(`document.getElementById("themeButton").click(); true`);
await sleep(300);
await shot("theme-picker");
await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);

// ------------------------------------------------------------------ report
const kb = shots.map((n) => statSync(`${OUT}/${n}.png`).size / 1024);
console.log(`${B}screenshots${X}  ${G}${shots.length}${X} in ${C}tmp/shots/showcase${X}  ${D}${shots.join(", ")}${X}`);
console.log(`${B}stats${X}  ${props.loras.length} LoRAs and ${props.sliders.length} sliders from ${props.version}, ` +
            `${Math.round(kb.reduce((a, b) => a + b, 0))} KB, page errors ${errors.length ? R + errors.length + X + " (" + errors.join(" | ") + ")" : G + "0" + X}, ` +
            `${((Date.now() - t0) / 1000).toFixed(1)} s`);
await finish(errors.length ? 1 : 0);
