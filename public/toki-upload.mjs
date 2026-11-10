#!/usr/bin/env node
// Toki upload script: puts a web game on Toki (https://playtoki.app) from a folder.
// Needs Node.js 18 or newer and nothing else.
//
//   TOKI_KEY=toki_… node toki-upload.mjs path/to/game-folder
//
// The folder holds the game's index.html (a web export from Godot, Unity, GameMaker, Phaser, …).
// A toki.json next to it can set the title, description, controls, version and update notes:
// see https://playtoki.app/agents.md. Get a key on Toki: My games → Upload keys.
//
// Options: --key <key> (instead of TOKI_KEY), --game <slug> (which game; else toki.json's slug,
// else its title), --dry-run (only show what would be uploaded).
//
//   node toki-upload.mjs --build
//
// builds the game first, from its source in this folder, then uploads the built game:
// - a web project (package.json, e.g. Vite, Phaser, PixiJS): installs its packages with npm,
//   pnpm, yarn or bun (whichever lock file is there), runs "build", and takes the folder with
//   the built index.html (dist, build, out, …);
// - a Godot project (project.godot, Godot 3 or 4): downloads that Godot version and its export
//   templates, and exports the game for the web (with its "Web" export preset, or a plain one);
// - already a web build (an index.html that runs as it is): takes it as it is.
// Unity, GameMaker and Construct need their editor (and its license) to export: commit the
// exported web build instead, or upload it.
// In GitHub Actions no key is needed: with "id-token: write" in the workflow, the script proves
// to Toki which repository and branch it runs for, and Toki takes it for the game that follows
// them. Toki adds that workflow to a game's repository for you (game settings → From GitHub).
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const TOKI = (process.env.TOKI_URL || "https://www.playtoki.app").replace(/\/+$/, "");
// The address in the links it prints (the short one forwards to www).
const LINK = process.env.TOKI_URL ? TOKI : "https://playtoki.app";
const SKIP = /(^|\/)(\.git|\.github|node_modules|__MACOSX|\.vscode|\.idea|\.godot|\.import)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
let key = opt("key") || process.env.TOKI_KEY || "";
const slug = opt("game") || process.env.TOKI_GAME || undefined;
const dryRun = flag("dry-run");
const build = flag("build");
let start = resolve(args[0] || ".");

const HINTS = {
  login_required: "The key is missing. Set TOKI_KEY or pass --key.",
  bad_key: "Toki doesn't know this key. Make a new one on Toki: My games → Upload keys.",
  not_allowed: "This account can't add games (only developers can), or the game belongs to someone else.",
  slug_taken: "Another developer's game already uses this name. Set a different \"slug\" in toki.json.",
  no_game: "No game to upload to: put a \"title\" in toki.json, or pass --game <slug>.",
  no_files: "The folder has no files to upload.",
  no_entry: "No index.html found. Upload the folder of the web export (the one with index.html), or set \"entry\" in toki.json.",
  too_big: "The game is bigger than 100 MB.",
  too_many_files: "The game has more than 3000 files.",
  account_full: "Your games on Toki use 1 GB already. Delete an old game first.",
  storage_full: "Toki's game storage is full right now. Please tell Toki's admins.",
  rate_limited: "Too many uploads in the last hour. Try again later.",
  hosting_off: "Uploading games isn't set up on Toki yet.",
  missing_files: "Some files didn't arrive. Run the upload again.",
  not_followed: "No game on Toki is built from this repository and branch. On Toki, open the game's settings, choose \"From GitHub\" with this repository, and let Toki build it with GitHub Actions.",
  actions_token: "GitHub didn't give this run its proof for Toki. Add \"permissions: id-token: write\" to the workflow.",
};

/** In GitHub Actions: GitHub's signed proof of which repository and branch this run is for (no key needed). */
async function githubProof() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) return "";
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}audience=toki-upload`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  const data = res?.ok ? await res.json().catch(() => ({})) : {};
  return typeof data.value === "string" ? data.value : "";
}

// A bundler's source page (it loads ./src/main.ts) isn't the game: the built one is elsewhere.
const isSourcePage = (html) => /<script[^>]+src=["'][^"']*\.(tsx?|jsx)["']/i.test(html) || /<script[^>]+src=["'](?:\.?\/)?src\//i.test(html);
const BUILD_FOLDERS = ["dist", "build", "out", "www", "docs", "public", "."];

function sh(cmd, dir) {
  console.log(`$ ${cmd}`);
  try {
    execSync(cmd, { cwd: dir, stdio: "inherit", env: { ...process.env, CI: "true" } });
  } catch {
    fail(`"${cmd}" failed (see above).`);
  }
}

/** The folder with a built game's page that runs as it is, or null. */
async function builtFolder(dir, wanted) {
  for (const f of wanted ? [wanted] : BUILD_FOLDERS) {
    const page = join(dir, f, "index.html");
    if (existsSync(page) && !isSourcePage(await readFile(page, "utf8"))) return resolve(dir, f);
  }
  return null;
}

/** What kind of project this is, by the files at its top. */
async function projectKind(dir) {
  const names = await readdir(dir).catch(() => []);
  if (names.includes("project.godot")) return "godot";
  if (names.includes("package.json")) return "web";
  if (existsSync(join(dir, "ProjectSettings", "ProjectVersion.txt"))) return "Unity";
  if (names.some((n) => /\.yyp$/i.test(n))) return "GameMaker";
  if (names.some((n) => /\.c3proj$/i.test(n)) || existsSync(join(dir, "project.c3proj"))) return "Construct";
  return "static";
}

/** Builds the game in `dir` and returns the folder with its built page. */
async function buildGame(dir, wanted) {
  const kind = await projectKind(dir);
  if (kind === "godot") return buildGodot(dir);
  if (kind === "static") {
    const found = await builtFolder(dir, wanted);
    if (found) return found;
    fail(`Nothing to build here: no package.json or project.godot, and no folder with a game's index.html in ${dir}.`);
  }
  if (kind !== "web") {
    const found = await builtFolder(dir, wanted);
    if (found) return found;
    fail(`This is a ${kind} project. ${kind} needs its own editor (and license) to export for the web, which can't run here. Export the web build into a folder of the repository (or set "folder" in toki.json), or upload the export on Toki.`);
  }
  let pkg;
  try {
    pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  } catch (e) {
    fail(`package.json isn't valid JSON: ${e.message}`);
  }
  const has = (f) => existsSync(join(dir, f));
  let pm = "npm";
  if (has("pnpm-lock.yaml")) pm = "pnpm";
  else if (has("yarn.lock")) pm = "yarn";
  else if (has("bun.lockb") || has("bun.lock")) pm = "bun";
  if (pm === "pnpm" || pm === "yarn") sh("corepack enable", dir);
  if (pm === "bun") sh("npm install --global bun", dir);
  sh(pm === "npm" ? (has("package-lock.json") ? "npm ci" : "npm install") : pm === "pnpm" ? "pnpm install --frozen-lockfile" : `${pm} install`, dir);
  if (typeof pkg.scripts?.build === "string") sh(`${pm} run build`, dir);
  else console.log('No "build" script in package.json: looking for the game as it is.');
  const found = await builtFolder(dir, wanted);
  if (found) return found;
  fail(`Built, but no folder with the game's index.html (looked in ${(wanted ? [wanted] : BUILD_FOLDERS).join(", ")}). Set "folder" in toki.json.`);
}

/**
 * Godot: the project's Godot version (from project.godot), its official build and export
 * templates from GitHub, then a web export. Uses the project's "Web" (Godot 4) or "HTML5"
 * (Godot 3) export preset when it has one, else adds a plain one. Godot 4.3 and newer export
 * without threads, so the game needs no cross-origin isolation.
 */
async function buildGodot(dir) {
  const project = await readFile(join(dir, "project.godot"), "utf8");
  if (/\[dotnet\]|\.csproj/i.test(project) || (await readdir(dir)).some((n) => /\.csproj$/i.test(n))) {
    fail("This Godot project uses C#. Godot can't export C# games for the web yet: export it with GDScript, or upload a web build.");
  }
  const four = /config_version\s*=\s*5/.test(project);
  const feature = /config\/features\s*=\s*PackedStringArray\(\s*"(\d+\.\d+)/.exec(project)?.[1];
  const version = process.env.GODOT_VERSION || (four ? feature || "4.3" : "3.6");
  const v = version.split(".").map(Number);
  const tag = `${version}-stable`;
  const home = process.env.HOME || "/tmp";
  const tools = join(home, ".toki-godot");
  const base = `https://github.com/godotengine/godot/releases/download/${tag}`;
  const bin = four ? `Godot_v${tag}_linux.x86_64` : `Godot_v${tag}_linux_headless.64`;
  console.log(`Godot ${version} project: exporting for the web.`);
  sh(`mkdir -p "${tools}" && cd "${tools}" && curl -fsSL -o godot.zip "${base}/${bin}.zip" && unzip -oq godot.zip && chmod +x "${bin}"`, dir);
  const templates = four ? join(home, ".local/share/godot/export_templates", `${version}.stable`) : join(home, ".local/share/godot/templates", `${version}.stable`);
  sh(`curl -fsSL -o "${tools}/templates.tpz" "${base}/Godot_v${tag}_export_templates.tpz" && mkdir -p "${templates}" && unzip -oq "${tools}/templates.tpz" -d "${tools}/t" && cp -r "${tools}/t/templates/." "${templates}/"`, dir);

  const platform = four ? "Web" : "HTML5";
  const presetsFile = join(dir, "export_presets.cfg");
  let presets = existsSync(presetsFile) ? await readFile(presetsFile, "utf8") : "";
  let preset = null;
  for (const m of presets.matchAll(/\[preset\.\d+\][^[]*?name="([^"]+)"[^[]*?platform="([^"]+)"/g)) if (m[2] === platform) preset = m[1];
  if (!preset) {
    const n = [...presets.matchAll(/\[preset\.(\d+)\]/g)].reduce((a, m) => Math.max(a, Number(m[1]) + 1), 0);
    preset = "Toki Web";
    const threads = four && (v[0] > 4 || v[1] >= 3) ? "variant/thread_support=false\n" : "";
    presets += `\n[preset.${n}]\n\nname="${preset}"\nplatform="${platform}"\nrunnable=true\nexport_filter="all_resources"\ninclude_filter=""\nexclude_filter=""\nexport_path="toki-build/index.html"\n\n[preset.${n}.options]\n\n${threads}`;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(presetsFile, presets);
    console.log(`No ${platform} export preset in the project: added "${preset}".`);
  }
  // Godot 4.0 to 4.2 web exports always use threads: the game needs cross-origin isolation.
  if (four && v[0] === 4 && v[1] < 3) godotIsolation = true;
  const out = join(dir, "toki-build");
  const godot = `"${join(tools, bin)}"`;
  // Import the project's files first, so the export has everything.
  if (four) {
    const importCmd = v[1] >= 2 ? `${godot} --headless --import` : `${godot} --headless --editor --quit`;
    try {
      execSync(importCmd, { cwd: dir, stdio: "inherit", timeout: 600_000 });
    } catch {
      console.log("(Importing reported problems; trying the export anyway.)");
    }
  }
  sh(`mkdir -p "${out}" && ${godot} ${four ? "--headless --export-release" : "--export"} "${preset}" "${join(out, "index.html")}"`, dir);
  if (!existsSync(join(out, "index.html"))) fail("Godot didn't export the game. See its messages above.");
  return out;
}
let godotIsolation = false;

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

async function walk(dir, root, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join("/");
    if (SKIP.test(rel)) continue;
    if (entry.isDirectory()) await walk(full, root, out);
    else if (entry.isFile()) out.push({ path: rel, full, size: (await stat(full)).size });
  }
  return out;
}

async function api(body) {
  const res = await fetch(`${TOKI}/api/hosting`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(HINTS[data.error] ?? `Toki answered ${res.status}: ${data.error ?? "unknown error"} ${data.message ?? ""}`);
  return data;
}

async function put(url, full, size) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { method: "PUT", body: await readFile(full), headers: { "content-length": String(size) } });
      if (res.ok) return;
      if (attempt >= 4) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      if (attempt >= 4) throw e;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

let toki = {};
try {
  toki = JSON.parse((await readFile(join(start, "toki.json"), "utf8")).replace(/^﻿/, ""));
} catch (e) {
  if (e.code !== "ENOENT") fail(`toki.json isn't valid JSON: ${e.message}`);
}
const folder = build ? await buildGame(start, toki.folder) : toki.folder ? resolve(start, toki.folder) : start;
if (godotIsolation && toki.isolation === undefined) toki.isolation = true;
const files = await walk(folder, folder, []).catch((e) => fail(`Can't read ${folder}: ${e.message}`));
const total = files.reduce((n, f) => n + f.size, 0);
console.log(`Toki: ${files.length} files, ${(total / 1024 / 1024).toFixed(1)} MB from ${folder}`);
if (dryRun) {
  for (const f of files) console.log(`  ${f.path} (${f.size} bytes)`);
  process.exit(0);
}
if (!key && process.env.GITHUB_ACTIONS === "true") {
  key = await githubProof();
  if (!key) fail(HINTS.actions_token);
}
if (!key) fail(HINTS.login_required);

const started = await api({ action: "start", slug, toki, files: files.map((f) => ({ path: f.path, size: f.size })) });
console.log(`${started.created ? "New game" : "Game"} “${started.slug}”: uploading…`);
const byPath = new Map(files.map((f) => [f.path, f]));
const queue = [...started.uploads];
let done = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      const f = byPath.get(u.path);
      await put(u.url, f.full, f.size).catch((e) => fail(`Upload of ${u.path} failed: ${e.message}`));
      done++;
      if (done % 25 === 0 || done === started.uploads.length) process.stdout.write(`\r  ${done}/${started.uploads.length} files`);
    }
  }),
);
console.log("");
const finished = await api({ action: "finish", build_id: started.build_id, toki });
console.log(`\n✓ Live on Toki: ${LINK}${finished.game_url}`);
console.log(`  Plays at: ${finished.play_url}`);
if (finished.release?.posted) console.log(`  Posted the update ${finished.release.version} on the game's Updates page.`);
if (started.created) console.log(`  Add a cover picture and check the details: ${LINK}/edit/${finished.slug}`);
