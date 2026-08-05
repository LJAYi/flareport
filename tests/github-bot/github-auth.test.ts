import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createAppJwt, getInstallationAccessToken, GitHubHttpTransport } from "../../apps/github-bot/src/github-auth.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1 = privateKey.export({ format: "pem", type: "pkcs1" }).toString();

test("creates a GitHub App JWT from the PKCS#1 key GitHub provides", async () => {
  const jwt = await createAppJwt({ appId: "12345", privateKey: pkcs1 }, new Date("2026-08-05T00:00:00.000Z"));
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as { iss: string; exp: number; iat: number };
  assert.equal(claims.iss, "12345");
  assert.equal(claims.exp - claims.iat, 540);
  assert.ok(signature && signature.length > 100);
});

test("exchanges an app JWT for an installation token using a mocked fetch", async () => {
  let authorization = "";
  const token = await getInstallationAccessToken(
    { appId: "12345", privateKey: pkcs1 },
    77,
    async (input, init) => {
      assert.equal(String(input), "https://api.github.com/app/installations/77/access_tokens");
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ token: "installation-token" });
    },
    new Date("2026-08-05T00:00:00.000Z"),
  );
  assert.equal(token, "installation-token");
  assert.match(authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
});

test("HTTP transport applies installation authentication and surfaces REST responses", async () => {
  const transport = new GitHubHttpTransport("token", async (input, init) => {
    assert.equal(String(input), "https://api.github.com/repos/octo/app");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer token");
    return Response.json({ id: 1 });
  });
  assert.deepEqual(await transport.rest("GET", "/repos/octo/app"), { id: 1 });
});
