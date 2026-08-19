#!/usr/bin/env node
/**
 * Build a separately-iconed copy of the Hermes desktop app for Grok Build.
 *
 * WHY THIS EXISTS
 * ---------------
 * Grok Build and stock Hermes both launched the literal same Hermes.exe file
 * (same path) — Windows would show one shared taskbar icon for both.
 *
 * TWO layers had to be fixed, not one (found 2026-07-20 after the first fix
 * shipped and still showed identical icons on both windows — verified via a
 * real taskbar screenshot, not just a file-level check):
 *
 * 1. The exe's own PE icon resource — affects File Explorer and the icon
 *    shown before launch (e.g. a pinned shortcut's own glyph). Fixed with
 *    rcedit (a pure PE resource editor — no code changes, same technique
 *    Hermes's own build uses in apps/desktop/scripts/set-exe-identity.mjs).
 *
 * 2. The LIVE RUNNING WINDOW's icon — this is what actually shows on the
 *    taskbar button and in Alt-Tab/hover previews, and it is NOT read from
 *    the exe's PE resource at all. Hermes's own createWindow() calls
 *    getAppIconPath(), which resolves to
 *      resources/app.asar.unpacked/dist/apple-touch-icon.png
 *    (a 1024x1024 PNG, already unpacked from app.asar for exactly this
 *    purpose — Electron must unpack anything a native API touches directly).
 *    That file, not the exe resource, is what electron's BrowserWindow
 *    `icon:` option actually loads. My first fix only did (1), which is why
 *    both windows still looked identical live — confirmed by the user via
 *    an actual taskbar hover-preview screenshot after I'd (wrongly) declared
 *    it fixed based on inspecting the exe's icon resource alone. Lesson:
 *    verify the ACTUAL rendered artifact (a live screenshot), not a proxy
 *    for it (a file's embedded resource) — they can diverge.
 *
 * Fixing (2) is a pure ASSET swap — the file lives outside app.asar already,
 * so this never touches any Hermes code/logic, same spirit as (1).
 *
 * Kept out of git (~380MB, pure build output) — lives under the isolated
 * profile dir, mirroring how node_modules / the update-stub git repo are
 * already local-only, regenerated-on-demand artifacts.
 *
 * Usage: node build-grok-app.mjs <sourceWinUnpackedDir> <targetDir> <iconIcoPath> [appIconPngPath]
 *   iconIcoPath    - .ico for the exe's PE resource (rcedit)
 *   appIconPngPath - PNG for the live window icon (apple-touch-icon.png
 *                    replacement). Optional; skipped (with a warning) if
 *                    omitted or missing, since (1) alone is still a partial
 *                    improvement (Explorer/pre-launch) even without it.
 * Idempotent: skips the copy if targetDir already has a build stamped from
 * the same source commit + both icon files unchanged.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [, , sourceDir, targetDir, iconPath, appIconPngPath] = process.argv;

if (!sourceDir || !targetDir || !iconPath) {
  console.error(
    "usage: build-grok-app.mjs <sourceWinUnpackedDir> <targetDir> <iconIcoPath> [appIconPngPath]"
  );
  process.exit(2);
}
if (!fs.existsSync(sourceDir)) {
  console.error(`source not found: ${sourceDir}`);
  process.exit(1);
}
if (!fs.existsSync(iconPath)) {
  console.error(`icon not found: ${iconPath}`);
  process.exit(1);
}

const targetExe = path.join(targetDir, "GrokBuild.exe");
const stampFile = path.join(targetDir, ".grok-build-stamp.json");
const appIconTarget = path.join(
  targetDir,
  "resources",
  "app.asar.unpacked",
  "dist",
  "apple-touch-icon.png"
);

function readInstallCommit(dir) {
  try {
    const stamp = JSON.parse(
      fs.readFileSync(
        path.join(dir, "resources", "install-stamp.json"),
        "utf8"
      )
    );
    return stamp.commit || null;
  } catch {
    return null;
  }
}

function findRcedit() {
  // sourceDir is .../apps/desktop/release/win-unpacked — the hermes-agent
  // repo root (where rcedit is hoisted to node_modules/) is 4 levels up.
  const known = path.resolve(
    sourceDir,
    "..",
    "..",
    "..",
    "..",
    "node_modules",
    "rcedit",
    "bin",
    "rcedit-x64.exe"
  );
  if (fs.existsSync(known)) return known;
  // Fallback: walk up looking for node_modules/rcedit in case the layout differs.
  let dir = path.dirname(sourceDir);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(
      dir,
      "node_modules",
      "rcedit",
      "bin",
      "rcedit-x64.exe"
    );
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function fileFingerprint(p) {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

const sourceCommit = readInstallCommit(sourceDir);
// The commit alone is NOT enough to decide "already built". We deliberately
// carry local patches on top of the pinned Hermes commit (see
// docs/HERMES-UPDATE-PROTOCOL.md §1b), so a rebuilt win-unpacked can differ
// while the commit stays identical - and this script would happily skip the
// copy and leave the OLD exe installed, which is exactly what happened on
// 2026-08-18 with the link-routing patch. electron-builder rewrites
// resources/app.asar on every package run, so its mtime+size is a cheap,
// precise "this is a different build" signal that a patch cannot slip past.
const sourceBuild = fileFingerprint(
  path.join(sourceDir, "resources", "app.asar")
);
const wantStamp = JSON.stringify({
  sourceCommit,
  sourceBuild,
  icon: fileFingerprint(iconPath),
  appIcon: appIconPngPath ? fileFingerprint(appIconPngPath) : null,
});

if (fs.existsSync(targetExe) && fs.existsSync(stampFile)) {
  const haveStamp = fs.readFileSync(stampFile, "utf8");
  if (haveStamp === wantStamp) {
    console.log(
      `[build-grok-app] up to date (source commit ${sourceCommit || "unknown"}, icons unchanged) - skipping rebuild`
    );
    process.exit(0);
  }
  console.log("[build-grok-app] source or icon changed - rebuilding copy");
}

const rcedit = findRcedit();
if (!rcedit) {
  console.error(
    "[build-grok-app] rcedit-x64.exe not found under the Hermes install's node_modules - cannot stamp icon"
  );
  process.exit(1);
}

console.log(`[build-grok-app] copying ${sourceDir}`);
console.log(`[build-grok-app]      -> ${targetDir}`);
try {
  fs.rmSync(targetDir, { recursive: true, force: true });
} catch (err) {
  if (err.code === "EPERM" || err.code === "EBUSY") {
    console.error(
      `[build-grok-app] SKIPPED: ${targetDir} is locked - GrokBuild.exe is currently ` +
        "running from it (a live session has file handles open). Close the Grok Build " +
        "window first, then re-run. Leaving the existing build untouched - nothing broken."
    );
    process.exit(3);
  }
  throw err;
}
fs.mkdirSync(targetDir, { recursive: true });
// robocopy's own exit codes are a bitmask where 0-7 all mean success (files
// copied/skipped/mismatched are all "fine"); only >=8 is a real failure.
// spawnSync (not execFileSync) so we can check that ourselves instead of
// Node treating any non-zero code as a thrown error.
const copy = spawnSync(
  "robocopy",
  [sourceDir, targetDir, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"],
  { stdio: "ignore" }
);
if ((copy.status ?? 8) >= 8) {
  console.error(`[build-grok-app] robocopy failed with code ${copy.status}`);
  process.exit(1);
}

const stockExe = path.join(targetDir, "Hermes.exe");
if (!fs.existsSync(stockExe)) {
  console.error(`[build-grok-app] copy failed - ${stockExe} missing`);
  process.exit(1);
}
fs.renameSync(stockExe, targetExe);

console.log(`[build-grok-app] stamping icon + identity on ${targetExe}`);
execFileSync(rcedit, [
  targetExe,
  "--set-icon",
  iconPath,
  "--set-version-string",
  "ProductName",
  "Grok Build",
  "--set-version-string",
  "FileDescription",
  "Grok Build Desktop",
  "--set-version-string",
  "CompanyName",
  "Grok Build Desktop (unofficial)",
]);

// The layer that actually fixes the LIVE taskbar icon — see header comment.
if (appIconPngPath && fs.existsSync(appIconPngPath)) {
  if (fs.existsSync(appIconTarget)) {
    console.log(`[build-grok-app] replacing live window icon at ${appIconTarget}`);
    fs.copyFileSync(appIconPngPath, appIconTarget);
  } else {
    console.error(
      `[build-grok-app] WARNING: expected unpacked icon not found at ${appIconTarget} - live taskbar icon will still match stock Hermes (Explorer/pre-launch icon is fixed, but the running window will not be)`
    );
  }
} else {
  console.error(
    "[build-grok-app] WARNING: no appIconPngPath given/found - only the exe's PE icon was changed. The LIVE running window's taskbar icon will still match stock Hermes until this is provided (see header comment)."
  );
}

// THIRD identity layer (found 2026-07-21 after layers 1+2 still showed one
// merged taskbar button): Windows groups taskbar buttons by AppUserModelID,
// not by exe or icon. Hermes hardcodes app.setAppUserModelId(
// "com.nousresearch.hermes") in electron-main.mjs, so stock Hermes and this
// copy declared the SAME identity — Windows merged both windows onto the one
// pinned "Hermes" button, whose pin icon won regardless of layers 1+2. The
// window title "Hermes" is hardcoded the same way (twice). electron-main.mjs
// ships UNPACKED (app.asar.unpacked/dist/), so this is a plain-text patch of
// the COPY only — stock Hermes untouched, no asar surgery.
const mainMjs = path.join(
  targetDir,
  "resources",
  "app.asar.unpacked",
  "dist",
  "electron-main.mjs"
);
if (fs.existsSync(mainMjs)) {
  let src = fs.readFileSync(mainMjs, "utf8");
  const aumidHits = src.split('app.setAppUserModelId("com.nousresearch.hermes")').length - 1;
  const titleHits = src.split('title: "Hermes"').length - 1;
  if (aumidHits > 0 || titleHits > 0) {
    src = src
      .split('app.setAppUserModelId("com.nousresearch.hermes")')
      .join('app.setAppUserModelId("com.mjcity.grokbuild")');
    src = src.split('title: "Hermes"').join('title: "Grok Build"');
    // The BrowserWindow `title:` option alone is not enough: once the
    // renderer loads, Electron mirrors document.title ("Hermes") back onto
    // the window unless page-title-updated is prevented. Idempotency marker
    // is our own setTitle call — do NOT key on "page-title-updated", Hermes
    // has an unrelated listener with that name (scheduleGrace).
    if (!src.includes('win.setTitle("Grok Build")')) {
      const anchor = 'app.setAppUserModelId("com.mjcity.grokbuild");';
      src = src.replace(
        anchor,
        anchor +
          '\n  app.on("browser-window-created", (_ev, win) => {\n' +
          '    win.on("page-title-updated", (e) => e.preventDefault());\n' +
          '    win.setTitle("Grok Build");\n' +
          "  });"
      );
    }
    // FOURTH identity layer (found 2026-07-21, user report: separate button
    // now, but still the stock icon on it): getAppIconPath() walks
    // APP_ICON_PATHS in order and the FIRST entry — public/apple-touch-icon
    // .png INSIDE app.asar — exists and wins, so the unpacked file we swap
    // (layer 2) never gets read. Electron's fs patching makes asar paths
    // pass fileExists. Reorder so the unpacked (replaceable) path is first.
    // The bundler's path-module alias (path15 etc.) drifts across builds —
    // match it, never hardcode it.
    // Layout-agnostic: match the whole array body whatever upstream puts in
    // it, then force OUR unpacked png to be the first candidate. Upstream has
    // already changed this array's shape once (2026-08-01 / 40e0e7ad
    // prepended a Windows-only `resources/icon.ico` + `assets/icon.ico`
    // branch AHEAD of the png entries, which silently defeated the old
    // exact-shape regex and would have fallen the window icon back to stock).
    // Prepending instead of rewriting a known list means future upstream
    // additions can't win the `find(fileExists)` race against us again.
    const ICON_MARKER = 'unpackedPathFor(APP_ROOT), "dist", "apple-touch-icon.png"),\n  ...';
    const iconOrderRe = /var APP_ICON_PATHS = \[\n([\s\S]*?)\n\];/;
    const iconOrderMatch = src.match(iconOrderRe);
    if (iconOrderMatch && !src.includes(ICON_MARKER)) {
      const body = iconOrderMatch[1];
      // Reuse the bundler's own path-module alias (path21 etc. — it drifts
      // every build, so never hardcode it) from any join() already in there.
      const aliasMatch = body.match(/(\w+)\.join\(/);
      if (aliasMatch) {
        const v = aliasMatch[1];
        src = src.replace(
          iconOrderRe,
          "var APP_ICON_PATHS = [\n" +
            `  ${v}.join(unpackedPathFor(APP_ROOT), "dist", "apple-touch-icon.png"),\n` +
            `  ...[\n${body}\n  ]\n` +
            "];"
        );
      } else {
        console.error(
          "[build-grok-app] WARNING: APP_ICON_PATHS found but no path alias inside - live window icon may fall back to the stock icon"
        );
      }
    } else if (!iconOrderMatch) {
      console.error(
        "[build-grok-app] WARNING: APP_ICON_PATHS not found in electron-main.mjs - upstream layout changed; the live window icon will fall back to the stock icon"
      );
    }
    // Windows-only (new upstream 40e0e7ad): the icon list now starts with
    // resources/icon.ico, which Electron ALSO uses for the window icon. Even
    // with our png prepended, replace it so every icon surface is ours.
    try {
      const resIco = path.join(targetDir, "resources", "icon.ico");
      if (fs.existsSync(resIco) && fs.existsSync(iconPath)) {
        fs.copyFileSync(iconPath, resIco);
        console.log(`[build-grok-app] replaced ${resIco} with the Grok Build icon`);
      }
    } catch (e) {
      console.error(`[build-grok-app] WARNING: could not replace resources/icon.ico: ${e.message}`);
    }
    fs.writeFileSync(mainMjs, src);
    console.log(
      `[build-grok-app] patched app identity (AppUserModelID x${aumidHits}, window title x${titleHits} + title lock, icon path priority) - distinct taskbar identity`
    );
  } else if (!src.includes("com.mjcity.grokbuild")) {
    console.error(
      "[build-grok-app] WARNING: neither the stock AUMID nor the patched one found in electron-main.mjs - upstream Hermes may have changed how it sets AppUserModelId; taskbar buttons may merge with stock Hermes again"
    );
  }
} else {
  console.error(
    `[build-grok-app] WARNING: ${mainMjs} not found - cannot patch AppUserModelID; taskbar buttons will merge with stock Hermes`
  );
}

fs.writeFileSync(stampFile, wantStamp);
console.log(`[build-grok-app] done - ${targetExe}`);
