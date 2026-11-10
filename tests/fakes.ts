// Small in-memory stand-ins for the database's REST API and for Cloudflare R2, for the hosting tests.
import type { Db } from "../server/db";
import type { R2 } from "../server/r2";

export type Row = Record<string, unknown>;

function match(row: Row, key: string, cond: string): boolean {
  const [op, ...rest] = cond.split(".");
  const v = decodeURIComponent(rest.join("."));
  const x = row[key];
  switch (op) {
    case "eq": return String(x) === v;
    case "neq": return String(x) !== v;
    case "is": return v === "null" ? x === null || x === undefined : String(x) === v;
    case "in": return v.slice(1, -1).split(",").includes(String(x));
    case "gt": return x !== null && String(x) > v;
    case "lt": return x !== null && String(x) < v;
    case "lte": return x !== null && String(x) <= v;
    case "cs": return Array.isArray(x) && v.slice(1, -1).split(",").every((s) => x.includes(s));
    default: throw new Error(`op ${op}`);
  }
}

export function fakeDb(tables: Record<string, Row[]>): Db {
  const filter = (table: string, query: string) => {
    let rows = tables[table] ?? (tables[table] = []);
    let limit = Infinity;
    let order: string | null = null;
    for (const part of query.split("&").filter(Boolean)) {
      const i = part.indexOf("=");
      const k = part.slice(0, i);
      const v = part.slice(i + 1);
      if (k === "select") continue;
      if (k === "limit") limit = Number(v);
      else if (k === "order") order = v;
      else if (k === "or") {
        const alts = v.slice(1, -1).split(",").map((a) => a.split("."));
        rows = rows.filter((r) => alts.some(([col, ...c]) => match(r, col, c.join("."))));
      } else rows = rows.filter((r) => match(r, k, v));
    }
    if (order) {
      const [col, dir] = order.split(".");
      rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (dir === "desc" ? -1 : 1));
    }
    return rows.slice(0, limit);
  };
  let n = 0;
  return {
    rpc: async () => { throw new Error("no rpc"); },
    select: async <T>(table: string, query: string) => filter(table, query) as T[],
    insert: async <T>(table: string, row: Row | Row[]) => {
      const list = (Array.isArray(row) ? row : [row]).map((r) => ({ id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, created_at: new Date(Date.now() + n).toISOString(), screenshots: [], ...r }));
      (tables[table] ??= []).push(...list);
      return list as T[];
    },
    update: async <T>(table: string, query: string, patch: Row) => {
      const rows = filter(table, query);
      if (table === "games" && "hosted_site" in patch && tables.games.some((g) => g.hosted_site === patch.hosted_site)) throw Object.assign(new Error("dup"), { code: "23505" });
      for (const r of rows) Object.assign(r, patch);
      return rows as T[];
    },
    remove: async (table: string, query: string) => {
      const gone = new Set(filter(table, query));
      tables[table] = tables[table].filter((r) => !gone.has(r));
      return null;
    },
  };
}

export function fakeStore(files: Map<string, number>, pointers: Map<string, string>, texts = new Map<string, string>()): R2 {
  return {
    uploadUrl: (key: string, size: number) => `https://r2.test/${key}?size=${size}`,
    put: async (key: string, body: string) => {
      if (key.startsWith("sites/")) pointers.set(key, body);
      else {
        files.set(key, Buffer.byteLength(body));
        texts.set(key, body);
      }
    },
    getText: async (key: string) => texts.get(key) ?? "",
    copy: async (from: string, to: string) => {
      files.set(to, files.get(from)!);
      if (texts.has(from)) texts.set(to, texts.get(from)!);
    },
    remove: async (key: string) => void (files.delete(key), pointers.delete(key)),
    list: async (prefix: string) => [...files].filter(([k]) => k.startsWith(prefix)).map(([key, size]) => ({ key, size })),
    removeMany: async (keys: string[]) => keys.forEach((k) => files.delete(k)),
  };
}

