import assert from "node:assert/strict";
import test from "node:test";
import { GitHubApiError, GitHubClient, type GitHubTransport } from "../../apps/github-bot/src/github.ts";

test("creates an update branch, commits deterministic files, and opens a gated PR", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const graphqlCalls: Array<Record<string, unknown>> = [];
  const transport: GitHubTransport = {
    async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      if (path.includes("git/ref/heads")) return { object: { sha: "base-sha" } } as T;
      if (method === "GET" && path.includes("/git/commits/")) return { sha: "base-sha", tree: { sha: "base-tree" } } as T;
      if (method === "POST" && path.endsWith("/git/blobs")) return { sha: `blob-${calls.length}` } as T;
      if (method === "POST" && path.endsWith("/git/trees")) return { sha: "tree-sha" } as T;
      if (method === "POST" && path.endsWith("/git/commits")) return { sha: "commit-sha" } as T;
      if (path.endsWith("/pulls")) return { number: 7, node_id: "PR_node", html_url: "https://example.test/pr/7" } as T;
      return {} as T;
    },
    async graphql<T>(_query: string, variables: Record<string, unknown>): Promise<T> {
      graphqlCalls.push(variables);
      return {} as T;
    },
  };
  const pull = await new GitHubClient(transport).createUpdatePullRequest({
    owner: "octo", repo: "app", base: "main", branch: "flareport/update-1", title: "Update", body: "Notes",
    files: [{ path: "z.txt", content: "z" }, { path: "a.txt", content: "a" }],
  });
  assert.equal(pull.number, 7);
  const blobs = calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/blobs"));
  assert.equal(blobs.length, 2);
  assert.deepEqual((blobs[0]!.body as { content: string }).content, "a");
  assert.deepEqual((blobs[1]!.body as { content: string }).content, "z");
  assert.equal(calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/commits")).length, 1);
  assert.deepEqual(graphqlCalls, []);
});

test("tolerates an existing update branch", async () => {
  let refReads = 0;
  const transport: GitHubTransport = {
    async rest<T>(method: string, path: string): Promise<T> {
      if (path.includes("git/ref/heads")) {
        refReads += 1;
        return { object: { sha: refReads === 1 ? "base-sha" : "commit-sha" } } as T;
      }
      if (method === "GET" && path.includes("/git/commits/")) return { sha: "base-sha", tree: { sha: "base-tree" } } as T;
      if (method === "POST" && path.endsWith("/git/trees")) return { sha: "tree-sha" } as T;
      if (method === "POST" && path.endsWith("/git/commits")) return { sha: "commit-sha" } as T;
      if (method === "POST" && path.endsWith("git/refs")) throw new GitHubApiError(422, "exists");
      if (path.endsWith("/pulls")) return { number: 1, node_id: "id", html_url: "url" } as T;
      return { sha: "existing" } as T;
    },
    async graphql<T>(): Promise<T> { return {} as T; },
  };
  const result = await new GitHubClient(transport).createUpdatePullRequest({
    owner: "octo", repo: "app", base: "main", branch: "existing", title: "Update", body: "", files: [],
  });
  assert.equal(result.number, 1);
});

test("rejects a pre-existing update branch whose tip differs from the expected base", async () => {
  let refReads = 0;
  const transport: GitHubTransport = {
    async rest<T>(method: string, path: string): Promise<T> {
      if (path.includes("git/ref/heads")) {
        refReads += 1;
        return { object: { sha: refReads === 1 ? "base-sha" : "attacker-sha" } } as T;
      }
      if (method === "GET" && path.includes("/git/commits/")) return { sha: "base-sha", tree: { sha: "base-tree" } } as T;
      if (method === "POST" && path.endsWith("/git/trees")) return { sha: "tree-sha" } as T;
      if (method === "POST" && path.endsWith("/git/commits")) return { sha: "commit-sha" } as T;
      if (method === "POST" && path.endsWith("git/refs")) throw new GitHubApiError(422, "exists");
      return {} as T;
    },
    async graphql<T>(): Promise<T> { return {} as T; },
  };
  await assert.rejects(
    new GitHubClient(transport).createUpdatePullRequest({
      owner: "octo", repo: "app", base: "main", branch: "claimed", title: "Update", body: "", files: [],
    }),
    /unexpected tip/,
  );
});
