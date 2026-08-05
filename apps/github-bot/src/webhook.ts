import { verifyGitHubSignature } from "./crypto.ts";
import type { StateStore } from "./store.ts";

interface InstallationPayload {
  action: string;
  installation: { id: number; account: { login: string } };
}

interface RepositoriesPayload extends InstallationPayload {
  repositories_added?: Array<{ full_name: string }>;
  repositories_removed?: Array<{ full_name: string }>;
}

export async function handleGitHubWebhook(
  request: Request,
  secret: string,
  store: StateStore,
): Promise<Response> {
  const rawBody = await request.text();
  const valid = await verifyGitHubSignature(secret, rawBody, request.headers.get("x-hub-signature-256"));
  if (!valid) return json({ error: "invalid-signature" }, 401);
  const event = request.headers.get("x-github-event") ?? "unknown";
  if (event === "ping") return json({ ok: true, event });

  let payload: InstallationPayload | RepositoriesPayload;
  try {
    payload = JSON.parse(rawBody) as InstallationPayload | RepositoriesPayload;
  } catch {
    return json({ error: "invalid-json" }, 400);
  }

  if (event === "installation") {
    await store.putInstallation({
      installationId: payload.installation.id,
      account: payload.installation.account.login,
      active: payload.action !== "deleted" && payload.action !== "suspend",
      updatedAt: new Date().toISOString(),
    });
  }
  if (event === "installation_repositories") {
    const repositoryPayload = payload as RepositoriesPayload;
    for (const fullName of repositoryPayload.repositories_removed?.map((repo) => repo.full_name) ?? []) {
      const [owner, repo] = fullName.split("/");
      if (!owner || !repo) continue;
      const existing = await store.getRepository(owner, repo);
      if (existing) await store.putRepository({ ...existing, enabled: false, updatedAt: new Date().toISOString() });
    }
  }
  return json({ ok: true, event }, 202);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
