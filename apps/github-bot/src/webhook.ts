import { verifyGitHubSignature } from "./crypto.ts";
import type { StateStore } from "./store.ts";
import type { CompletedCheckEvent } from "./automation.ts";

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
  options: {
    onCompletedCheck?: (event: CompletedCheckEvent) => Promise<void>;
    waitUntil?: (promise: Promise<unknown>) => void;
  } = {},
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
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json({ error: "invalid-payload" }, 400);

  if (event === "check_run" && options.onCompletedCheck) {
    const processing = options.onCompletedCheck(payload as CompletedCheckEvent);
    if (options.waitUntil) options.waitUntil(processing.catch(error => console.error("FlarePort check reconciliation failed:", (error as Error).message)));
    else await processing;
  }

  if (event === "installation") {
    if (!Number.isSafeInteger(payload.installation?.id) || payload.installation.id <= 0
      || typeof payload.installation.account?.login !== "string") return json({ error: "invalid-installation" }, 400);
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
