export type UpdateMode = "manual" | "auto" | "staged-auto";
export type UpdateChannel = "canary" | "early" | "stable";
export type RolloutPhase = "canary" | "early" | "stable" | "paused" | "completed";
export type DeploymentResult = "success" | "failure" | "rollback";

export interface RepositoryRegistration {
  installationId: number;
  owner: string;
  repo: string;
  template: string;
  mode: UpdateMode;
  channel: UpdateChannel;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StageGate {
  minimumSuccesses: number;
  minimumEvents: number;
  observationMs: number;
  maximumFailureRate: number;
}

export interface RolloutConfig {
  canaryBasisPoints: number;
  earlyBasisPoints: number;
  canary: StageGate;
  early: StageGate;
}

export interface RolloutEvent {
  repositoryKey: string;
  artifactId: string;
  version: string;
  upstreamCommit: string;
  result: DeploymentResult;
  occurredAt: string;
}

export interface RolloutState {
  template: string;
  version: string;
  artifactId: string;
  upstreamCommit: string;
  phase: RolloutPhase;
  phaseStartedAt: string;
  config: RolloutConfig;
  events: RolloutEvent[];
  pausedReason?: string;
}

export interface TrustedArtifact {
  id: string;
  template: string;
  version: string;
  upstreamCommit: string;
  contentHash: string;
  baseBranch: string;
  releaseNotes: string;
  files: Array<{ path: string; content: string }>;
  createdAt: string;
}

export interface DispatchRecord {
  repositoryKey: string;
  artifactId: string;
  branch: string;
  headSha: string;
  pullRequestNumber: number;
  pullRequestNodeId: string;
  pullRequestUrl: string;
  createdAt: string;
}

export interface InstallationRecord {
  installationId: number;
  account: string;
  active: boolean;
  updatedAt: string;
}
