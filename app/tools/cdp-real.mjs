// The console page against the REAL yue-server. Run it through tools/test-real.sh, which gives it an
// isolated test library (with a labelled synthetic fixture, so a fresh install has a take to list), its
// own CPU-only server on a free port, and cleans up. By hand: start a GPU-hidden server, then
//   node tools/cdp-real.mjs http://127.0.0.1:<port>/
// Loads the embedded page, checks it reads the real /props, /settings, /library and /hardware, then makes
// a 1-second song through the form (Direct mode, 2 ODE steps, Legacy VAE, Metal slider) and opens it.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chromeTmp, findChrome, freshProfile, makeSend, stopChrome } from "./cdp-common.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = ROOT + "/tmp", OUT = TMP + "/shots/real";
const CHROME = findChrome();
if (!CHROME) { console.log("\x1b[31mno Chrome or Chromium found\x1b[0m: install one, or set YUE2_CHROME=/path/to/chrome"); process.exit(2); }
const PROFILE = freshProfile(TMP + "/chrome-home", "profile-real");   // new and empty every run
const CHROME_TMP = chromeTmp(TMP);
const BASE = process.argv[2] || "http://127.0.0.1:41869/";
const G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const env = { ...process.env, HOME: TMP + "/chrome-home", XDG_CONFIG_HOME: TMP + "/chrome-home/.config",
              XDG_CACHE_HOME: TMP + "/chrome-home/.cache", TMPDIR: TMP };
const chrome = spawn("nice", ["-n", "15", CHROME, "--headless=new", "--disable-gpu", "--no-first-run",
  "--no-default-browser-check", "--disable-extensions", "--user-data-dir=" + PROFILE, "--remote-debugging-port=0", "about:blank"],
  { env: { ...env, TMPDIR: CHROME_TMP }, stdio: "ignore" });
const t0 = Date.now();
const TITLE = "Page check " + String(t0).slice(-5);   // unique per run
const done = async (code) => { await stopChrome(chrome, PROFILE, CHROME_TMP); process.exit(code); };
process.on("unhandledRejection", (e) => { console.log(`\x1b[31mstopped: ${e?.message || e}\x1b[0m`); done(2); });
setTimeout(() => { console.log("TIMEOUT"); done(2); }, 420000);
let port;
for (let i = 0; i < 100 && !port; i++) { await sleep(200); if (existsSync(PROFILE + "/DevToolsActivePort")) port = readFileSync(PROFILE + "/DevToolsActivePort", "utf8").split("\n")[0]; }
const tgt = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === "page");
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pend = new Map(); const errors = []; const requests = [];
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errors.push((d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text).split("\n")[0]);
  if (d.method === "Network.requestWillBeSent") requests.push(d.params.request.method + " " + d.params.request.url.replace(BASE, "/"));
});
const send = makeSend(ws, pend, () => ++id);   // every command gives up after 60 s, naming itself
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  return r.result?.exceptionDetails ? "EVAL ERROR " + r.result.exceptionDetails.text : r.result?.result?.value; };
const shot = async (n) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${n}.png`, Buffer.from(r.result.data, "base64")); };
const waitFor = async (expr, timeout, step = 500) => { const until = Date.now() + timeout;
  for (;;) { const v = await ev(expr); if (v && !(typeof v === "string" && v.startsWith("EVAL ERROR"))) return v; if (Date.now() > until) return null; await sleep(step); } };
const click = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
const setValue = (sel, value) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.value = ${JSON.stringify(value)};
  e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
let passed = 0, failed = 0;
const check = (name, ok, detail) => { ok ? passed++ : failed++;
  console.log(`  ${ok ? G + "PASS" : R + "FAIL"}${X}  ${name}${detail !== undefined ? D + "  (" + String(detail).slice(0, 200) + ")" + X : ""}`); };

await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1536, height: 730, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: BASE });
console.log(`${B}the page served by the real server${X}`);
const loaded = await waitFor(`document.querySelectorAll("#decoders input").length >= 3 && document.querySelectorAll("#sliderChips [data-slider]").length`, 20000);
check("page loads from the server (gzipped, embedded)", !!loaded, (await ev("document.title")));
check("three VAEs from /props", (await ev(`document.querySelectorAll("#decoders input").length`)) === 3);
check("16 sliders from /props", (await ev(`document.querySelectorAll("#sliderChips [data-slider]").length`)) === 16);
const takes = await waitFor(`document.querySelectorAll("#libList .take-title").length`, 10000);
check("library lists the takes on disk (on a fresh install: test-real.sh's synthetic fixture)", takes >= 1, `${takes} takes`);
await click("#engineToggle"); await sleep(600);
const noPrec = await ev(`!document.getElementById("setPrecision") && !document.getElementById("f32Toggle")`);
check("no F32 option in the page, and the server's /settings has no precision", noPrec && !("precision" in (await (await fetch(BASE + "settings")).json())));
await shot("1-engine"); await click("#engineToggle"); await sleep(300);

console.log(`${B}a real song through the form (CPU, 1 s, 2 steps)${X}`);
await setValue("#title", TITLE);
await setValue("#style", "English, male vocal, heavy metal, electric guitar");
await setValue("#lyrics", "[verse]\nHello from the other room\n");
await click('input[name="cot"][value="off"]');
await click("#advDrawer summary"); await sleep(300);
await setValue("#maxLength", "1"); await setValue("#odeSteps", "2");
await click('#decoders input[value="legacy"]');
await click('#sliderChips [data-slider="metal"]');
const before = requests.length;
await click("#generateBtn");
const sent = await waitFor(`true`, 2000);
await sleep(1500);
check("Generate posted /synth", requests.slice(before).some((r) => r.startsWith("POST /synth")));
await sleep(8000); await shot("2-running");
// the server's own library is the truth: wait until it holds the finished take
let saved = null;
for (const until = Date.now() + 300000; !saved && Date.now() < until; await sleep(3000)) {
  const lib = await (await fetch(BASE + "library")).json();
  saved = lib.takes.find((t) => t.title === TITLE);
}
check("the song finished and was saved by the server", !!saved, saved ? `${saved.name}, ${((Date.now() - t0) / 1000).toFixed(0)} s` : "none");
const shown = await waitFor(`!!document.querySelector('#libList [data-name="${saved?.name}"], #libList [data-take="${saved?.name}"]') ||
  [...document.querySelectorAll("#libList .take")].some(e => e.textContent.includes(${JSON.stringify(TITLE)}) && !/running|queued/i.test(e.className))`, 20000);
check("the page's library shows it", !!shown);
await sleep(1500);
await ev(`(() => { const rows = [...document.querySelectorAll("#libList .take")].filter(e => e.textContent.includes(${JSON.stringify(TITLE)}) && !/running|queued/i.test(e.className));
  const t = rows[0] && (rows[0].querySelector(".take-title") || rows[0]); t && t.click(); })()`);
await sleep(3000);
const cells = await ev(`[...document.querySelectorAll("#metaGrid > *")].map(e => e.innerText.replace(/\\s+/g, " ").trim()).join(" | ")`);
check("song page: VAE Legacy", /VAE Legacy/i.test(cells || ""), cells);
check("song page: slider Metal", /Metal/i.test(cells || ""));
check("song page: no precision row on a new song", !/Precision/i.test(cells || ""), cells);
check("waveform came from /library/peaks", requests.some((r) => r.startsWith("GET /library/peaks")));
await shot("3-take");
check("no script errors", errors.length === 0, errors.join(" / ") || "none");
console.log(`\n${failed ? R : G}${passed} passed, ${failed} failed${X}  ${D}${((Date.now() - t0) / 1000).toFixed(0)} s, screenshots in tmp/shots/real${X}`);
done(failed ? 1 : 0);
