#!/usr/bin/env node
// Toki upload script: puts a web game on Toki (https://www.playtoki.app) from a folder.
// Needs Node.js 18 or newer and nothing else.
//
//   TOKI_KEY=toki_… node toki-upload.mjs path/to/game-folder
//
// The folder holds the game's index.html (a web export from Godot, Unity, GameMaker, Phaser, …).
// A toki.json next to it can set the title, description, controls, version and update notes:
// see https://www.playtoki.app/agents.md. Get a key on Toki: My games → Upload keys.
//
// Options: --key <key> (instead of TOKI_KEY), --game <slug> (which game; else toki.json's slug,
// else its title), --dry-run (only show what would be uploaded).
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const TOKI = (process.env.TOKI_URL || "https://www.playtoki.app").replace(/\/+$/, "");
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
const key = opt("key") || process.env.TOKI_KEY || "";
const slug = opt("game") || process.env.TOKI_GAME || undefined;
const dryRun = flag("dry-run");
const start = resolve(args[0] || ".");

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
};

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
const folder = toki.folder ? resolve(start, toki.folder) : start;
const files = await walk(folder, folder, []).catch((e) => fail(`Can't read ${folder}: ${e.message}`));
const total = files.reduce((n, f) => n + f.size, 0);
console.log(`Toki: ${files.length} files, ${(total / 1024 / 1024).toFixed(1)} MB from ${folder}`);
if (dryRun) {
  for (const f of files) console.log(`  ${f.path} (${f.size} bytes)`);
  process.exit(0);
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
console.log(`\n✓ Live on Toki: ${TOKI}${finished.game_url}`);
console.log(`  Plays at: ${finished.play_url}`);
if (finished.release?.posted) console.log(`  Posted the update ${finished.release.version} on the game's Updates page.`);
if (started.created) console.log(`  Add a cover picture and check the details: ${TOKI}/edit/${finished.slug}`);
