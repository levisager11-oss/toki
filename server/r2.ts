// Cloudflare R2 through its S3-compatible API: signed upload links for the browser (so game
// files go straight to Cloudflare, never through Vercel), and listing, writing and deleting
// files for the server. Signing is AWS Signature Version 4, done by hand to keep Toki small.
import { createHash, createHmac } from "node:crypto";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** The domain whose subdomains serve the games, e.g. "playtoki.app" → snake.playtoki.app */
  domain: string;
}

export const r2Configured = (c: Partial<R2Config> | null | undefined): c is R2Config =>
  !!(c?.accountId && c.accessKeyId && c.secretAccessKey && c.bucket && c.domain);

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** Percent-encoding the way S3 wants it (RFC 3986; "/" kept in paths). */
export function encode(s: string, keepSlash = false): string {
  const out = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? out.replace(/%2F/g, "/") : out;
}

function signingKey(secret: string, date: string, region: string, service: string) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), "aws4_request");
}

export interface SignInput {
  method: string;
  host: string;
  /** Already encoded, starting with "/" */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  service?: string;
  now?: Date;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** A presigned URL: anyone with it may do exactly this request until it expires. */
export function presign(input: SignInput & { expires: number }): string {
  const region = input.region ?? "auto";
  const service = input.service ?? "s3";
  const time = stamp(input.now ?? new Date());
  const date = time.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const headers: Record<string, string> = { host: input.host };
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v.trim();
  const names = Object.keys(headers).sort();
  const query: Record<string, string> = {
    ...input.query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKeyId}/${scope}`,
    "X-Amz-Date": time,
    "X-Amz-Expires": String(input.expires),
    "X-Amz-SignedHeaders": names.join(";"),
  };
  const qs = Object.keys(query).sort().map((k) => `${encode(k)}=${encode(query[k])}`).join("&");
  const canonical = [input.method, input.path, qs, names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", time, scope, sha256(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(input.secretAccessKey, date, region, service)).update(toSign).digest("hex");
  return `https://${input.host}${input.path}?${qs}&X-Amz-Signature=${signature}`;
}

/** Headers for a request the server makes itself (signed in the Authorization header). */
export function signHeaders(input: SignInput & { body?: string | Uint8Array }): Record<string, string> {
  const region = input.region ?? "auto";
  const service = input.service ?? "s3";
  const time = stamp(input.now ?? new Date());
  const date = time.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const payload = sha256(input.body ?? "");
  const headers: Record<string, string> = { host: input.host, "x-amz-date": time, "x-amz-content-sha256": payload };
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v.trim();
  const names = Object.keys(headers).sort();
  const query = input.query ?? {};
  const qs = Object.keys(query).sort().map((k) => `${encode(k)}=${encode(query[k])}`).join("&");
  const canonical = [input.method, input.path, qs, names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), payload].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", time, scope, sha256(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(input.secretAccessKey, date, region, service)).update(toSign).digest("hex");
  const { host: _host, ...rest } = headers;
  return { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

export class R2Error extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface R2Object {
  key: string;
  size: number;
}

export function r2(config: R2Config, fetchImpl: typeof fetch = fetch) {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const keyPath = (key: string) => `/${encode(config.bucket)}/${encode(key, true)}`;
  const creds = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };

  async function call(method: string, path: string, opts: { query?: Record<string, string>; body?: string; headers?: Record<string, string> } = {}) {
    const headers = signHeaders({ method, host, path, query: opts.query, headers: opts.headers, body: opts.body, ...creds });
    const qs = opts.query ? `?${Object.keys(opts.query).sort().map((k) => `${encode(k)}=${encode(opts.query![k])}`).join("&")}` : "";
    const res = await fetchImpl(`https://${host}${path}${qs}`, { method, headers, body: opts.body, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (!res.ok) throw new R2Error(`R2 ${res.status}: ${/<Message>([^<]*)/.exec(text)?.[1] ?? text.slice(0, 200)}`, res.status);
    return text;
  }

  return {
    /** A link the browser may PUT exactly this many bytes to, for an hour. */
    uploadUrl: (key: string, size: number, now?: Date) =>
      presign({ method: "PUT", host, path: keyPath(key), headers: { "content-length": String(size) }, expires: 3600, now, ...creds }),

    put: (key: string, body: string, contentType = "application/json") =>
      call("PUT", keyPath(key), { body, headers: { "content-type": contentType } }).then(() => undefined),

    async remove(key: string) {
      await call("DELETE", keyPath(key)).catch((e) => {
        if (!(e instanceof R2Error && e.status === 404)) throw e;
      });
    },

    /** Every file whose name starts with prefix (up to `max`). */
    async list(prefix: string, max = 10_000): Promise<R2Object[]> {
      const out: R2Object[] = [];
      let token: string | undefined;
      do {
        const query: Record<string, string> = { "list-type": "2", prefix, "max-keys": "1000" };
        if (token) query["continuation-token"] = token;
        const xml = await call("GET", `/${encode(config.bucket)}`, { query });
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1];
          const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] ?? 0);
          if (key) out.push({ key: unxml(key), size });
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
        if (token) token = unxml(token);
      } while (token && out.length < max);
      return out;
    },

    /** Deletes many files, 1000 per request. */
    async removeMany(keys: string[]) {
      for (let i = 0; i < keys.length; i += 1000) {
        const part = keys.slice(i, i + 1000);
        const body = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${part.map((k) => `<Object><Key>${xml(k)}</Key></Object>`).join("")}</Delete>`;
        const md5 = createHash("md5").update(body).digest("base64");
        await call("POST", `/${encode(config.bucket)}`, { query: { delete: "" }, body, headers: { "content-md5": md5, "content-type": "application/xml" } });
      }
    },
  };
}

export type R2 = ReturnType<typeof r2>;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");
