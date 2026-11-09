// A local HTTPS server that sends only its own certificate, without the intermediate.
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { missingIntermediates, tlsErrorCode, tolerantFetch } from "../server/tls";

const file = (name: string) => readFileSync(new URL(`./fixtures/tls/${name}`, import.meta.url), "utf8");
const root = file("root.pem");
const intermediate = file("int.pem");
const leaf = file("leaf.pem");
const other = file("other.pem");

let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer({ key: file("leaf.key"), cert: leaf }, (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization ?? null, body }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `https://localhost:${(server.address() as AddressInfo).port}/v1/chat`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("incomplete certificate chains", () => {
  it("finds the missing intermediate through the certificate's CA Issuers address", async () => {
    const download = vi.fn(async () => Buffer.from(intermediate));
    expect(await missingIntermediates(new X509Certificate(leaf), { roots: [root], download })).toEqual([new X509Certificate(intermediate).toString()]);
    expect(download).toHaveBeenCalledWith("http://certs.test.invalid/int.crt");
  });

  it("refuses certificates that didn't sign the chain, or that don't lead to a trusted root", async () => {
    expect(await missingIntermediates(new X509Certificate(leaf), { roots: [root], download: async () => Buffer.from(other) })).toEqual([]);
    expect(await missingIntermediates(new X509Certificate(leaf), { roots: [other], download: async () => Buffer.from(intermediate) })).toEqual([]);
    expect(await missingIntermediates(new X509Certificate(leaf), { roots: [root], download: async () => { throw new Error("offline"); } })).toEqual([]);
  });

  it("plain fetch fails on such a server", async () => {
    const err = await fetch(url).catch((e) => e);
    expect(tlsErrorCode(err)).toMatch(/UNABLE_TO/);
  });

  it("tolerantFetch completes the chain and sends the request", async () => {
    const res = await tolerantFetch(
      url,
      { method: "POST", headers: { authorization: "Bearer k", "content-type": "application/json" }, body: '{"a":1}' },
      { roots: [root], download: async () => Buffer.from(intermediate) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ method: "POST", auth: "Bearer k", body: '{"a":1}' });
  });

  it("still fails when the chain can't be completed", async () => {
    const err = await tolerantFetch(url.replace("/v1/chat", "/x"), {}, { roots: [root], download: async () => Buffer.from(other) }).catch((e) => e);
    expect(tlsErrorCode(err)).toMatch(/UNABLE_TO/);
  });
});
