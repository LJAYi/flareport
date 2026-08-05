import { GitHubApiError, GitHubClient, type GitHubTransport } from "./github.ts";

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
}

export async function createAppJwt(
  credentials: GitHubAppCredentials,
  now = new Date(),
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000) - 60;
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    iat: issuedAt,
    exp: issuedAt + 9 * 60,
    iss: credentials.appId,
  })));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(credentials.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

export async function getInstallationAccessToken(
  credentials: GitHubAppCredentials,
  installationId: number,
  fetcher: Fetcher = fetch,
  now = new Date(),
): Promise<string> {
  const jwt = await createAppJwt(credentials, now);
  const response = await fetcher(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(`Bearer ${jwt}`),
  });
  if (!response.ok) throw new GitHubApiError(response.status, await response.text());
  const body = await response.json() as { token?: string };
  if (!body.token) throw new Error("GitHub installation token response did not include a token");
  return body.token;
}

export class GitHubHttpTransport implements GitHubTransport {
  private readonly token: string;
  private readonly fetcher: Fetcher;

  constructor(token: string, fetcher: Fetcher = fetch) {
    this.token = token;
    this.fetcher = fetcher;
  }

  async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.request<T>(`https://api.github.com${path}`, method, body);
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.request<{ data?: T; errors?: Array<{ message: string }> }>(
      "https://api.github.com/graphql", "POST", { query, variables },
    );
    if (response.errors?.length) throw new Error(response.errors.map((error) => error.message).join("; "));
    if (!response.data) throw new Error("GitHub GraphQL response did not include data");
    return response.data;
  }

  private async request<T>(url: string, method: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: githubHeaders(`Bearer ${this.token}`) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.fetcher(url, init);
    if (!response.ok) throw new GitHubApiError(response.status, await response.text());
    return await response.json() as T;
  }
}

export async function installationClient(
  credentials: GitHubAppCredentials,
  installationId: number,
  fetcher: Fetcher = fetch,
): Promise<GitHubClient> {
  const token = await getInstallationAccessToken(credentials, installationId, fetcher);
  return new GitHubClient(new GitHubHttpTransport(token, fetcher));
}

function githubHeaders(authorization: string): Headers {
  return new Headers({
    accept: "application/vnd.github+json",
    authorization,
    "content-type": "application/json",
    "user-agent": "flareport-github-bot",
    "x-github-api-version": "2022-11-28",
  });
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const normalized = pem.replace(/\\n/g, "\n").trim();
  const isPkcs1 = normalized.includes("BEGIN RSA PRIVATE KEY");
  const base64 = normalized.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g, "");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return (isPkcs1 ? wrapPkcs1(bytes) : bytes).buffer as ArrayBuffer;
}

function wrapPkcs1(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  const privateKey = der(0x04, pkcs1);
  return der(0x30, concat(version, rsaAlgorithm, privateKey));
}

function der(tag: number, value: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(tag), derLength(value.length), value);
}

function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8) bytes.unshift(remaining & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(arrays.reduce((length, array) => length + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
