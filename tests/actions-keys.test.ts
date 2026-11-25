// An unknown key id in a token may make Toki look at GitHub's keys again, but only once a minute.
import { generateKeyPairSync, createSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ACTIONS_AUDIENCE, ACTIONS_ISSUER, verifyActionToken } from "../server/actionsAuth";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS = { keys: [{ ...(publicKey.export({ format: "jwk" }) as object), kid: "k1" }] };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const NOW = Date.now();
function token(kid: string) {
  const head = b64({ alg: "RS256", kid });
  const body = b64({ iss: ACTIONS_ISSUER, aud: ACTIONS_AUDIENCE, exp: NOW / 1000 + 300, repository: "lu/x", ref: "refs/heads/main", sha: "a".repeat(40) });
  return `${head}.${body}.${createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey).toString("base64url")}`;
}

describe("GitHub's keys", () => {
  it("are fetched again for an unknown key id at most once a minute", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(JSON.stringify(JWKS));
    }) as unknown as typeof fetch;
    await expect(verifyActionToken(token("other"), { fetch: fakeFetch })).rejects.toThrow(/unknown key/);
    expect(calls).toBe(2); // the first look, and one new look for the unknown key
    for (let i = 0; i < 5; i++) await expect(verifyActionToken(token("other"), { fetch: fakeFetch })).rejects.toThrow(/unknown key/);
    expect(calls).toBe(2);
    expect((await verifyActionToken(token("k1"), { fetch: fakeFetch })).repository).toBe("lu/x");
  });
});
