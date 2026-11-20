import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { inlineLinks } from "../lib/inlineLinks";
import { useTitle } from "../lib/useTitle";
import { SITE_URL } from "../lib/site";
import { scriptTag } from "../lib/integration";
import { githubWorkflow } from "../lib/hosting";
import snippet from "../../public/toki-save.js?raw";

// The developer docs (/docs): how to put a game on Toki and add Toki's features by hand, for
// developers who write their own code. Its texts are docs.body in src/lib/texts/dev*.ts: "## "
// starts a section ("## Title {#id}" gives it an address for links like /docs#scores), "### " a
// smaller heading, lines starting with "- " become a list, `code` is code, [text](/path) a link
// inside Toki, and a line [[name]] is one of the code blocks below (the same in both languages).
// When public/toki-save.js or src/lib/integration.ts gets something new, explain it here too
// (tests/docs.test.ts checks that every toki.… call is in here).

/** Uploads and downloads use the www address (the short one forwards there). */
const WWW = SITE_URL.replace("://", "://www.");

export const DOC_CODE: Record<string, { lang: string; code: string }> = {
  script: { lang: "html", code: scriptTag(snippet) },
  saves: {
    lang: "js",
    code: `// Every time the game saves (e.g. to IndexedDB), keep a copy in localStorage too:
localStorage.setItem("my-game-save", JSON.stringify(save));

// When the game starts, load that copy if it's there:
const copy = localStorage.getItem("my-game-save");
if (copy) loadSave(JSON.parse(copy));`,
  },
  scores: {
    lang: "js",
    code: `// When a round ends:
window.toki?.score(points);

// A best time: send milliseconds (set the game's list to "time" on Toki).
window.toki?.score(timeInMs);

// One of the game's other lists, by its id on Toki:
window.toki?.score(points, "hard");`,
  },
  achievements: {
    lang: "js",
    code: `// When the player earns one, with its id as on Toki:
window.toki?.achievement("first-win");`,
  },
  rooms: {
    lang: "js",
    code: `// The player opened or joined a room:
window.toki?.room(roomCode);

// They left it, or it closed:
window.toki?.room(null);

// A friend accepted an invite: Toki opens the game with ?room=CODE.
const invited = new URLSearchParams(location.search).get("room");
if (invited) joinRoom(invited);`,
  },
  host: {
    lang: "js",
    code: `// Let Toki open a room when the player invites friends before there is one:
window.toki?.onHost(() => {
  if (!inRoom()) createRoom(); // then call toki.room(code) as always
});`,
  },
  name: {
    lang: "js",
    code: `// Use the player's Toki name in rooms instead of asking for one:
window.toki?.onName((name) => setPlayerName(name));

// window.toki?.name has it too (null until Toki said).`,
  },
  godot: {
    lang: "gdscript",
    code: `func send_score(points: int) -> void:
	if OS.has_feature("web"):
		JavaScriptBridge.eval("window.toki?.score(%d)" % points)`,
  },
  tokiJson: {
    lang: "json",
    code: `{
  "title": "Moon Hop",
  "slug": "moon-hop",
  "description": "Hop across the moon and collect every star.",
  "controls": "Arrow keys to move, Space to jump",
  "category": "platformer",
  "engine": "Godot",
  "version": "1.1",
  "update_title": "Faster and prettier",
  "notes": ["Faster loading", "New level: the dark side"],
  "cover_image": "cover.png",
  "screenshots": ["shots/1.png", "shots/2.png"],
  "score_order": "high",
  "score_format": "points",
  "achievements": [
    { "id": "first-star", "name": "First star", "description": "Collect your first star.", "icon": "⭐" }
  ],
  "boards": [
    { "id": "speedrun", "name": "Speedrun", "score_order": "low", "score_format": "time" }
  ]
}`,
  },
  upload: {
    lang: "bash",
    code: `curl -fsSL ${WWW}/toki-upload.mjs -o toki-upload.mjs
TOKI_KEY="toki_…" node toki-upload.mjs path/to/build

# Build first (npm, pnpm, yarn or bun; or a Godot project), then upload:
TOKI_KEY="toki_…" node toki-upload.mjs --build

# Only show what would be uploaded:
node toki-upload.mjs path/to/build --dry-run`,
  },
  workflow: { lang: "yaml", code: githubWorkflow(WWW) },
};

/** Inline `code` and [links](/path) in a line of text. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code> : <Fragment key={i}>{inlineLinks(part)}</Fragment>,
  );
}

function CodeBlock({ name }: { name: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const block = DOC_CODE[name];
  if (!block) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the code is shown */
    }
  };
  return (
    <div className={`doc-code${name === "script" ? " tall" : ""}`}>
      <button type="button" className="btn" onClick={copy} aria-live="polite">{copied ? t("saveSupport.copied") : t("docs.copy")}</button>
      <pre><code className={`lang-${block.lang}`}>{block.code}</code></pre>
    </div>
  );
}

/** The sections of docs.body: their headings with their addresses, for the contents list. */
export function docSections(body: string): { id: string; title: string }[] {
  return [...body.matchAll(/^## (.+?) \{#([a-z0-9-]+)\}$/gm)].map((m) => ({ title: m[1], id: m[2] }));
}

function Body({ text }: { text: string }) {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return (
    <>
      {blocks.map((b, i) => {
        const code = /^\[\[([a-zA-Z]+)\]\]$/.exec(b);
        if (code) return <CodeBlock key={i} name={code[1]} />;
        const h2 = /^## (.+?)(?: \{#([a-z0-9-]+)\})?$/.exec(b);
        if (h2) return <h2 key={i} id={h2[2]}>{h2[1]}</h2>;
        if (b.startsWith("### ")) return <h3 key={i}>{b.slice(4)}</h3>;
        const lines = b.split("\n");
        if (lines.every((l) => l.startsWith("- "))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.slice(2))}</li>)}</ul>;
        return <p key={i}>{inline(b)}</p>;
      })}
    </>
  );
}

export function Docs() {
  const { t } = useI18n();
  useTitle(t("docs.title"));
  const { hash } = useLocation();
  const body = t("docs.body");
  // Opened as /docs#scores: that section.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash, body]);
  return (
    <article className="legal docs">
      <h1 className="h">{t("docs.title")}</h1>
      <p className="lead">{t("docs.lead")}</p>
      <nav className="doc-toc" aria-label={t("docs.contents")}>
        <ol>
          {docSections(body).map((s) => <li key={s.id}><a href={`#${s.id}`}>{s.title}</a></li>)}
        </ol>
      </nav>
      <Body text={body} />
    </article>
  );
}
