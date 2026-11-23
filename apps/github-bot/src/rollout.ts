import { deterministicBucket } from "./crypto.ts";
import type {
  RepositoryRegistration,
  RolloutConfig,
  RolloutEvent,
  RolloutPhase,
  RolloutState,
  UpdateChannel,
} from "./types.ts";

export const DEFAULT_ROLLOUT_CONFIG: RolloutConfig = {
  canaryBasisPoints: 100,
  earlyBasisPoints: 2_500,
  canary: { minimumSuccesses: 10, minimumEvents: 10, observationMs: 12 * 60 * 60 * 1000, maximumFailureRate: 0.05 },
  early: { minimumSuccesses: 100, minimumEvents: 100, observationMs: 24 * 60 * 60 * 1000, maximumFailureRate: 0.05 },
};

export function cohortFor(repositoryKey: string, template: string): UpdateChannel {
  const bucket = deterministicBucket(`${template}:${repositoryKey.toLowerCase()}`);
  if (bucket < DEFAULT_ROLLOUT_CONFIG.canaryBasisPoints) return "canary";
  if (bucket < DEFAULT_ROLLOUT_CONFIG.earlyBasisPoints) return "early";
  return "stable";
}

const phaseRank: Record<Exclude<RolloutPhase, "paused" | "completed">, number> = {
  canary: 0,
  early: 1,
  stable: 2,
};
const channelRank: Record<UpdateChannel, number> = { canary: 0, early: 1, stable: 2 };

export function updateDecision(
  repository: RepositoryRegistration,
  rollout: RolloutState,
): { createPullRequest: boolean; autoMerge: boolean; reason: string } {
  if (!repository.enabled) return { createPullRequest: false, autoMerge: false, reason: "repository-disabled" };
  if (repository.mode === "manual") return { createPullRequest: true, autoMerge: false, reason: "manual-review" };
  if (rollout.phase === "paused") return { createPullRequest: false, autoMerge: false, reason: "rollout-paused" };
  // Dispatch never merges. The automation handler verifies local opt-in and exact-head checks separately.
  if (repository.mode === "auto") return { createPullRequest: true, autoMerge: false, reason: "repository-auto-pending-checks" };
  if (rollout.phase !== "canary" && rollout.phaseEvidence !== "github-checks") {
    return { createPullRequest: false, autoMerge: false, reason: "unverified-legacy-rollout-phase" };
  }
  if (rollout.phase === "completed") return { createPullRequest: true, autoMerge: false, reason: "rollout-completed-pending-checks" };
  const eligible = channelRank[repository.channel] <= phaseRank[rollout.phase];
  return eligible
    ? { createPullRequest: true, autoMerge: false, reason: `eligible-${rollout.phase}-pending-checks` }
    : { createPullRequest: false, autoMerge: false, reason: `waiting-for-${repository.channel}` };
}

export function isRepositoryInCurrentPhase(repository: RepositoryRegistration, rollout: RolloutState): boolean {
  if (rollout.phase === "paused") return false;
  if (rollout.phase === "completed") return true;
  return channelRank[repository.channel] <= phaseRank[rollout.phase];
}

function latestEvents(state: RolloutState): RolloutEvent[] {
  const latestByRepository = new Map<string, RolloutEvent>();
  for (const event of state.events) {
    const previous = latestByRepository.get(event.repositoryKey.toLowerCase());
    if (!previous || Date.parse(event.occurredAt) >= Date.parse(previous.occurredAt)) {
      latestByRepository.set(event.repositoryKey.toLowerCase(), event);
    }
  }
  return [...latestByRepository.values()];
}

export function evaluateRollout(state: RolloutState, now = new Date()): RolloutState {
  const phase = state.phase;
  if (phase !== "canary" && phase !== "early" && phase !== "stable") return structuredClone(state);
  const next = structuredClone(state);
  const allEvents = latestEvents(next);
  const events = allEvents.filter(event => Date.parse(event.occurredAt) >= Date.parse(next.phaseStartedAt));
  const failures = events.filter((event) => event.result !== "success").length;
  const successes = events.length - failures;
  const gate = next.config[phase === "canary" ? "canary" : "early"];
  // A phase switch must not erase failures delivered late from an earlier phase.
  const failureRate = allEvents.length === 0 ? 0 : allEvents.filter(event => event.result !== "success").length / allEvents.length;
  const minimumFailureSamples = Math.min(next.config.canary.minimumEvents, gate.minimumEvents);

  if (allEvents.length >= minimumFailureSamples && failureRate > gate.maximumFailureRate) {
    next.phase = "paused";
    next.pausedReason = `failure-rate-${failureRate.toFixed(4)}-exceeded-${gate.maximumFailureRate}`;
    return next;
  }
  if (phase === "stable") return next;

  const firstObservation = Math.min(...events.map(event => Date.parse(event.occurredAt)));
  const observedFor = now.getTime() - Math.max(Date.parse(next.phaseStartedAt), firstObservation);
  if (events.length >= gate.minimumEvents && successes >= gate.minimumSuccesses && observedFor >= gate.observationMs) {
    next.phase = phase === "canary" ? "early" : "stable";
    next.phaseStartedAt = now.toISOString();
  }
  return next;
}
