// Some servers send an incomplete certificate chain: they leave out (or send the wrong) intermediate
// certificate between their own certificate and a trusted root. Browsers fill the gap by fetching
// the missing certificate from the address written in the server's certificate ("CA Issuers").
// Node.js doesn't, so its fetch fails with "unable to verify the first certificate".
//
// tolerantFetch does what browsers do: on exactly that error, it fetches the missing intermediates,
// checks their signatures, and repeats the request with them. The connection is still fully
// verified: the chain must end at one of Node's trusted root certificates, as always.
import { X509Certificate } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { connect, rootCertificates } from "node:tls";

const CHAIN_ERRORS = new Set(["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_GET_ISSUER_CERT"]);
const MAX_INTERMEDIATES = 3;
const STEP_TIMEOUT_MS = 10_000;

/** The TLS error code inside a fetch error (fetch wraps it in "fetch failed"), if any. */
export function tlsErrorCode(e: unknown): string | null {
  for (let x = e as { code?: unknown; cause?: unknown } | undefined, i = 0; x && i < 5; x = x.cause as typeof x, i++) {
    if (typeof x.code === "string") return x.code;
  }
  return null;
}

export interface TlsOptions {
  /** Trusted roots (PEM); Node's own by default. For tests. */
  roots?: readonly string[];
  /** Downloads a certificate from a "CA Issuers" address. For tests. */
  download?: (url: string) => Promise<Buffer>;
}

/** The server's own certificate, without checking it (only to read where its issuer can be found). */
function serverCertificate(host: string, port: number): Promise<X509Certificate> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, servername: host, rejectUnauthorized: false, timeout: STEP_TIMEOUT_MS }, () => {
      const raw = socket.getPeerCertificate().raw;
      socket.end();
      try {
        resolve(new X509Certificate(raw));
      } catch (e) {
        reject(e);
      }
    });
    socket.on("timeout", () => socket.destroy(new Error("timeout")));
    socket.on("error", reject);
  });
}

function issuerAddress(cert: X509Certificate): string | null {
  const m = /CA Issuers - URI:(\S+)/.exec(cert.infoAccess ?? "");
  return m && /^https?:\/\//.test(m[1]) ? m[1] : null;
}

const issuedBy = (cert: X509Certificate, issuer: X509Certificate) => cert.checkIssued(issuer) && cert.verify(issuer.publicKey);

function download(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("https:") ? https : http).get(url, { timeout: STEP_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`certificate download: ${res.statusCode}`));
      }
      const parts: Buffer[] = [];
      let size = 0;
      res.on("data", (d: Buffer) => {
        size += d.length;
        if (size > 64_000) req.destroy(new Error("certificate too large"));
        else parts.push(d);
      });
      res.on("end", () => resolve(Buffer.concat(parts)));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/**
 * The intermediates between this certificate and a trusted root, found through "CA Issuers"
 * addresses. Each one must have signed the one before; empty if no trusted root is reached.
 */
export async function missingIntermediates(cert: X509Certificate, opts: TlsOptions = {}): Promise<string[]> {
  const roots = (opts.roots ?? rootCertificates).map((p) => new X509Certificate(p));
  const found: string[] = [];
  for (let current = cert; ; ) {
    if (roots.some((r) => issuedBy(current, r))) return found;
    const url = issuerAddress(current);
    if (!url || found.length >= MAX_INTERMEDIATES) return [];
    let issuer: X509Certificate;
    try {
      issuer = new X509Certificate(await (opts.download ?? download)(url)); // DER or PEM
    } catch {
      return [];
    }
    if (!issuer.ca || !issuedBy(current, issuer)) return [];
    found.push(issuer.toString());
    current = issuer;
  }
}

// Per server: the trusted roots plus the intermediates it forgets to send.
const extraCa = new Map<string, Promise<string[] | null>>();

async function caFor(host: string, port: number, opts: TlsOptions): Promise<string[] | null> {
  // Only the real setup is remembered (tests bring their own roots).
  const key = opts.roots || opts.download ? null : `${host}:${port}`;
  let ca = key ? extraCa.get(key) : undefined;
  if (!ca) {
    ca = serverCertificate(host, port)
      .then((cert) => missingIntermediates(cert, opts))
      .then((list) => (list.length ? [...(opts.roots ?? rootCertificates), ...list] : null))
      .catch(() => null);
    if (key) {
      extraCa.set(key, ca);
      // Failures are tried again next time; found chains are kept while this server instance runs.
      ca.then((v) => v === null && extraCa.delete(key));
    }
  }
  return ca;
}

/** One HTTPS request with the given trusted certificates, answered as a fetch Response. */
function requestWithCa(url: URL, init: RequestInit, ca: string[]): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const req = https.request(url, { method: init.method ?? "GET", headers, ca, signal: init.signal ?? undefined }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (d: Buffer) => parts.push(d));
      res.on("end", () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : v);
        const status = res.statusCode ?? 500;
        resolve(new Response([204, 304].includes(status) ? null : Buffer.concat(parts), { status, headers: h }));
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (typeof init.body === "string") req.write(init.body);
    else if (init.body != null) return req.destroy(new Error("only text bodies are supported"));
    req.end();
  });
}

/** fetch, but it also works with HTTPS servers that send an incomplete certificate chain. */
export async function tolerantFetch(input: string | URL, init: RequestInit = {}, opts: TlsOptions = {}): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (e) {
    const url = new URL(String(input));
    if (url.protocol !== "https:" || !CHAIN_ERRORS.has(tlsErrorCode(e) ?? "")) throw e;
    const ca = await caFor(url.hostname, Number(url.port) || 443, opts);
    if (!ca) throw e;
    return requestWithCa(url, init, ca);
  }
}
