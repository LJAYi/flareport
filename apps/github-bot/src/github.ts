export interface GitHubTransport {
  rest<T>(method: string, path: string, body?: unknown): Promise<T>;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

export interface UpdateFile {
  path: string;
  content: string;
}

export interface UpdatePullRequestInput {
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

export class GitHubClient {
  private readonly transport: GitHubTransport;

  constructor(transport: GitHubTransport) {
    this.transport = transport;
  }

  async createUpdatePullRequest(input: UpdatePullRequestInput): Promise<CreatedPullRequest> {
    const prefix = `/repos/${input.owner}/${input.repo}`;
    const baseRef = await this.transport.rest<RefResponse>("GET", `${prefix}/git/ref/heads/${encodeURIComponent(input.base)}`);
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

  async enableAutoMerge(pullRequestId: string): Promise<void> {
    await this.transport.graphql(
      `mutation EnableFlarePortAutoMerge($pullRequestId: ID!) {
        enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId, mergeMethod: SQUASH}) {
          pullRequest { id }
        }
      }`,
      { pullRequestId },
    );
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
