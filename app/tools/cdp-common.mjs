// Shared by the browser tests (cdp-console.mjs, cdp-real.mjs): finding Chrome, a fresh profile per run,
// and Chrome DevTools commands that give up with a clear message instead of hanging.
import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Chrome or Chromium: YUE2_CHROME, else the usual names on PATH, else the macOS app bundles.
export function findChrome() {
  if (process.env.YUE2_CHROME) return existsSync(process.env.YUE2_CHROME) ? process.env.YUE2_CHROME : null;
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];
  for (const dir of (process.env.PATH || "").split(":")) {
    for (const n of names) if (dir && existsSync(join(dir, n))) return join(dir, n);
  }
  for (const p of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                   "/Applications/Chromium.app/Contents/MacOS/Chromium",
                   "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

// A new, empty profile for this run (YUE2_CHROME_PROFILE picks it, so a wrapper can clean up after it).
// A fresh profile has no stored data, so no storage reset is needed (on macOS
// Storage.clearDataForOrigin with storageTypes "all" hung until the suite timed out).
export function freshProfile(home, name) {
  const dir = process.env.YUE2_CHROME_PROFILE || join(home, `${name}-${process.pid}-${Date.now()}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // older runs' profiles of the same test (not this one) are left-overs: remove them
  try {
    for (const d of readdirSync(home)) {
      if (d.startsWith(name + "-") && join(home, d) !== dir) rmSync(join(home, d), { recursive: true, force: true });
    }
  } catch { /* no home yet */ }
  return dir;
}

// Chrome's temp folder for this run: inside the project, deleted with the profile (a killed Chrome
// cannot remove its com.google.Chrome.* folders), and SHORT. Chrome makes a Unix socket in it, and a
// socket path may not exceed 104 bytes on macOS (108 on Linux): a long folder name here stopped Chrome
// with "Socket path too long".
const SOCKET_TAIL = "/com.google.Chrome.XXXXXX/SingletonSocket".length;
export function chromeTmp(tmp) {
  let dir = join(tmp, "cr" + String(process.pid).slice(-6));
  if (dir.length + SOCKET_TAIL > 100) dir = tmp;
  if (dir.length + SOCKET_TAIL > 100) {
    console.log(`\x1b[33mnote\x1b[0m: this install's path is long (${tmp}); Chrome may not start ("Socket path too long"). A shorter install path fixes it.`);
  }
  mkdirSync(dir, { recursive: true });
  try {   // the same folders of earlier runs, over an hour old, are left-overs
    for (const d of readdirSync(tmp)) {
      const p = join(tmp, d);
      if (/^cr\d+$/.test(d) && p !== dir && Date.now() - statSync(p).mtimeMs > 3600e3) rmSync(p, { recursive: true, force: true });
    }
  } catch { /* nothing to sweep */ }
  return dir;
}

// Stop Chrome, wait until it has exited (or 3 s), then delete its profile: deleting while it still
// writes would leave the folder behind.
export async function stopChrome(chrome, profile, tmpdir) {
  try { chrome.kill("SIGKILL"); } catch { /* already gone */ }
  await new Promise((r) => {
    if (chrome.exitCode !== null || chrome.signalCode !== null) return r();
    chrome.once("exit", r); setTimeout(r, 3000);
  });
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(profile, { recursive: true, force: true });
      if (tmpdir && /\/cr\d+$/.test(tmpdir)) rmSync(tmpdir, { recursive: true, force: true });
      if (!existsSync(profile)) return;
    } catch { /* busy */ }
    await new Promise((r) => setTimeout(r, 200));
  }
}

// A DevTools command that fails after `ms` with the command's name, so a stall says what stalled.
export function makeSend(ws, pending, next, defaultMs = 60000) {
  return (method, params = {}, ms = defaultMs) => new Promise((ok, fail) => {
    const i = next();
    const timer = setTimeout(() => { pending.delete(i); fail(new Error(`DevTools command ${method} gave no answer in ${ms / 1000} s`)); }, ms);
    pending.set(i, (d) => { clearTimeout(timer); ok(d); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}
