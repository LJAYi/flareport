export interface GitHubTransport {
  rest<T>(method: string, path: string, body?: unknown): Promise<T>;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

export interface UpdateFile {
  path: string;
  content: string;
}

export interface UpdatePullRequestInput {
  expectedBaseSha?: string;
  owner: string;
  repo: string;
  base: string;
  branch: string;
  title: string;
  body: string;
  files: UpdateFile[];
}

interface RefResponse { object: { sha: string } }
interface CommitResponse { sha: string; tree: { sha: string } }
interface ShaResponse { sha: string }
export interface PullResponse { number: number; node_id: string; html_url: string }
export interface CreatedPullRequest extends PullResponse { headSha: string }

export interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  app: { id: number; slug: string };
  status: string;
  conclusion: string | null;
  external_id?: string | null;
  started_at: string;
  completed_at: string | null;
  output?: { summary?: string | null };
}

export interface UpdatePull extends PullResponse {
  state: string;
  draft: boolean;
  merged: boolean;
  merge_commit_sha: string | null;
  mergeable_state: string;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string; repo: { full_name: string } };
}

export interface BranchState {
  protected: boolean;
  commit: { sha: string };
  protection?: { required_status_checks?: { checks?: Array<{ context: string; app_id: number | null }> } };
}

export class GitHubClient {
  private readonly transport: GitHubTransport;

  constructor(transport: GitHubTransport) {
    this.transport = transport;
  }

  getRepository(owner: string, repo: string): Promise<{ default_branch: string; allow_auto_merge?: boolean }> {
    return this.transport.rest("GET", `/repos/${owner}/${repo}`);
  }

  getBranch(owner: string, repo: string, branch: string): Promise<BranchState> {
    return this.transport.rest("GET", `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
  }

  getPull(owner: string, repo: string, number: number): Promise<UpdatePull> {
    return this.transport.rest("GET", `/repos/${owner}/${repo}/pulls/${number}`);
  }

  async pullsForCommit(owner: string, repo: string, sha: string): Promise<Array<{ number: number }>> {
    const pulls = await this.transport.rest<Array<{ number: number }>>("GET", `/repos/${owner}/${repo}/commits/${sha}/pulls?per_page=100`);
    if (pulls.length >= 100) throw new Error("Ambiguous commit-to-PR mapping exceeds reconciliation limit");
    return pulls;
  }

  getCheck(owner: string, repo: string, id: number): Promise<CheckRun> {
    return this.transport.rest("GET", `/repos/${owner}/${repo}/check-runs/${id}`);
  }

  async checksForCommit(owner: string, repo: string, sha: string): Promise<CheckRun[]> {
    const value = await this.transport.rest<{ total_count: number; check_runs: CheckRun[] }>(
      "GET", `/repos/${owner}/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`);
    if (value.total_count > 100) throw new Error("Check list exceeds reconciliation limit");
    return value.check_runs;
  }

  async readJsonFile(owner: string, repo: string, path: string, sha: string): Promise<unknown> {
    try {
      const file = await this.transport.rest<{ type: string; encoding: string; content: string; size: number }>(
        "GET", `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${sha}`);
      if (file.type !== "file" || file.encoding !== "base64" || file.size > 64_000) throw new Error("Invalid repository policy file");
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s/g, "")), c => c.charCodeAt(0))));
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  async mergeExactPull(owner: string, repo: string, number: number, expectedHead: string): Promise<boolean> {
    // Native merge with a commit precondition closes the check-to-merge head-change race.
    const result = await this.transport.rest<{ merged: boolean }>("PUT", `/repos/${owner}/${repo}/pulls/${number}/merge`, {
      sha: expectedHead, merge_method: "squash",
    });
    return result.merged;
  }

  async createUpdatePullRequest(input: UpdatePullRequestInput): Promise<CreatedPullRequest> {
    const prefix = `/repos/${input.owner}/${input.repo}`;
    const baseRef = await this.transport.rest<RefResponse>("GET", `${prefix}/git/ref/heads/${encodeURIComponent(input.base)}`);
    if (input.expectedBaseSha && baseRef.object.sha !== input.expectedBaseSha) throw new Error("Base changed after preparing repository-owned settings; retry");
    const baseCommit = await this.transport.rest<CommitResponse>("GET", `${prefix}/git/commits/${baseRef.object.sha}`);
    const treeEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
    for (const file of [...input.files].sort((left, right) => left.path.localeCompare(right.path))) {
      const blob = await this.transport.rest<ShaResponse>("POST", `${prefix}/git/blobs`, {
        content: file.content,
        encoding: "utf-8",
      });
      treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const tree = await this.transport.rest<ShaResponse>("POST", `${prefix}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree: treeEntries,
    });
    const commit = await this.transport.rest<ShaResponse>("POST", `${prefix}/git/commits`, {
      message: input.title,
      tree: tree.sha,
      parents: [baseRef.object.sha],
    });
    try {
      await this.transport.rest("POST", `${prefix}/git/refs`, {
        ref: `refs/heads/${input.branch}`,
        sha: commit.sha,
      });
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
      const existingRef = await this.transport.rest<RefResponse>(
        "GET",
        `${prefix}/git/ref/heads/${encodeURIComponent(input.branch)}`,
      );
      if (existingRef.object.sha !== commit.sha) {
        throw new Error(`Refusing to use pre-existing update branch ${input.branch}: unexpected tip`);
      }
    }

    const existingPulls = await this.transport.rest<PullResponse[]>(
      "GET",
      `${prefix}/pulls?state=open&head=${encodeURIComponent(`${input.owner}:${input.branch}`)}&base=${encodeURIComponent(input.base)}`,
    );
    const pull = Array.isArray(existingPulls) && existingPulls[0]
      ? existingPulls[0]
      : await this.transport.rest<PullResponse>("POST", `${prefix}/pulls`, {
          title: input.title,
          body: input.body,
          head: input.branch,
          base: input.base,
        });
    return { ...pull, headSha: commit.sha };
  }

  async publishArtifactCheck(owner: string, repo: string, headSha: string, artifactId: string): Promise<void> {
    await this.transport.rest("POST", `/repos/${owner}/${repo}/check-runs`, {
      name: "FlarePort artifact integrity",
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
      external_id: artifactId,
      output: {
        title: "Trusted FlarePort artifact",
        summary: `Artifact ${artifactId} passed FlarePort publication integrity checks.`,
      },
    });
  }

}

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "GitHubApiError";
  }
}
