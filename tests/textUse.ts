// Which texts the code uses and which files come in which download, for tests/texts.test.ts.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
export const src = join(root, "src");
export const app = join(src, "App.tsx");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(f) ? [p] : [];
  });
}

/** Source files, except the texts themselves. */
export const codeFiles = files(src).filter((p) => !p.startsWith(join(src, "lib", "texts")) && p !== join(src, "lib", "i18n.tsx"));

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const p of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

/** A page in src/App.tsx that loads on demand: page(() => import("./pages/X")..., "player", ...). */
export interface LaterPage {
  file: string;
  groups: string[];
}
export function laterPages(): LaterPage[] {
  const text = readFileSync(app, "utf8");
  return [...text.matchAll(/^const \w+ = page\(\(\) => import\("([^"]+)"\)[^\n]*?\)\)((?:, "\w+")*)\);$/gm)].map((m) => ({
    file: resolveImport(app, m[1])!,
    groups: [...m[2].matchAll(/"(\w+)"/g)].map((g) => g[1]),
  }));
}

/**
 * The files a file brings along: what it imports (not type-only imports, which aren't code), and
 * what it loads with import() — except the pages of src/App.tsx, which load their texts first.
 */
function imports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm)) {
    if (!m[1]) out.push(m[2]);
  }
  for (const line of text.split("\n")) {
    if (file === app && /^const \w+ = page\(/.test(line)) continue;
    for (const m of line.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  }
  return out.map((s) => resolveImport(file, s)).filter((p): p is string => !!p);
}

/** A file and every file it brings along, and they bring along... */
export function closureOf(start: string): Set<string> {
  const seen = new Set<string>();
  const todo = [start];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    todo.push(...imports(f));
  }
  return seen;
}

/** Files that can show without a page of src/App.tsx having loaded texts first. */
export const firstDownload = () => closureOf(join(src, "main.tsx"));

/** The text keys a file may use: written out ("game.play") or built (`cat.${c}` may use every "cat." key). */
export function keysUsedBy(file: string, keys: string[]): string[] {
  const text = readFileSync(file, "utf8");
  const literals = new Set<string>();
  for (const m of text.matchAll(/"([^"\n\\]*)"|'([^'\n\\]*)'|`([^`\\]*)`/g)) literals.add(m[1] ?? m[2] ?? m[3]);
  const prefixes: string[] = [];
  for (const m of text.matchAll(/`([^`$\\]*)\$\{/g)) if (m[1]) prefixes.push(m[1]);
  return keys.filter((k) => literals.has(k) || prefixes.some((p) => k.startsWith(p)));
}

/** The keys of a texts object in a file: `const <name> ... = { "key": "text", ... };` */
export function textKeys(file: string, name: string): string[] {
  const text = readFileSync(file, "utf8");
  const start = text.search(new RegExp(`^(?:export )?const ${name}\\b[^\\n]*= \\{$`, "m"));
  if (start < 0) throw new Error(`no texts ${name} in ${file}`);
  const body = text.slice(start, text.indexOf("\n};", start));
  return [...body.matchAll(/^ {2}"([^"]+)": /gm)].map((m) => m[1]);
}

export const rel = (p: string) => relative(root, p);
