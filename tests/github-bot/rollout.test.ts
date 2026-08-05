import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRollout, updateDecision } from "../../apps/github-bot/src/rollout.ts";
import type { RepositoryRegistration, RolloutState } from "../../apps/github-bot/src/types.ts";

const repository: RepositoryRegistration = {
  installationId: 1,
  owner: "octo",
  repo: "nodewarden",
  template: "nodewarden",
  mode: "staged-auto",
  channel: "stable",
  enabled: true,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};
const eventBinding = {
  artifactId: "a".repeat(64),
  version: "1.2.0",
  upstreamCommit: "b".repeat(40),
};

function rollout(): RolloutState {
  return {
    template: "nodewarden",
    version: "1.2.0",
    artifactId: eventBinding.artifactId,
    upstreamCommit: eventBinding.upstreamCommit,
    phase: "canary",
    phaseStartedAt: "2026-08-01T00:00:00.000Z",
    config: {
      canaryBasisPoints: 100,
      earlyBasisPoints: 2500,
      canary: { minimumSuccesses: 2, minimumEvents: 2, observationMs: 1_000, maximumFailureRate: 0.2 },
      early: { minimumSuccesses: 3, minimumEvents: 3, observationMs: 2_000, maximumFailureRate: 0.2 },
    },
    events: [],
  };
}

test("manual and auto policies ignore staged auto-merge gating", () => {
  const state = rollout();
  assert.deepEqual(updateDecision({ ...repository, mode: "manual" }, state), {
    createPullRequest: true, autoMerge: false, reason: "manual-review",
  });
  assert.deepEqual(updateDecision({ ...repository, mode: "auto" }, state), {
    createPullRequest: true, autoMerge: false, reason: "repository-auto-pending-checks",
  });
  assert.equal(updateDecision(repository, state).createPullRequest, false);
});

test("staged rollout advances only after unique successes and observation window", () => {
  const state = rollout();
  state.events = [
    { ...eventBinding, repositoryKey: "a/a", result: "success", occurredAt: "2026-08-01T00:00:01.000Z" },
    { ...eventBinding, repositoryKey: "b/b", result: "success", occurredAt: "2026-08-01T00:00:01.000Z" },
  ];
  const early = evaluateRollout(state, new Date("2026-08-01T00:00:02.000Z"));
  assert.equal(early.phase, "early");
  assert.equal(updateDecision({ ...repository, channel: "early" }, early).autoMerge, false);
  assert.equal(updateDecision(repository, early).createPullRequest, false);
});

test("failure rate trips the rollout circuit breaker", () => {
  const state = rollout();
  state.events = [
    { ...eventBinding, repositoryKey: "a/a", result: "success", occurredAt: "2026-08-01T00:00:01.000Z" },
    { ...eventBinding, repositoryKey: "b/b", result: "failure", occurredAt: "2026-08-01T00:00:01.000Z" },
  ];
  const paused = evaluateRollout(state, new Date("2026-08-01T00:00:02.000Z"));
  assert.equal(paused.phase, "paused");
  assert.match(paused.pausedReason ?? "", /failure-rate/);
  assert.equal(updateDecision({ ...repository, channel: "canary" }, paused).createPullRequest, false);
});

test("only the latest event per repository counts", () => {
  const state = rollout();
  state.events = [
    { ...eventBinding, repositoryKey: "a/a", result: "failure", occurredAt: "2026-08-01T00:00:00.100Z" },
    { ...eventBinding, repositoryKey: "a/a", result: "success", occurredAt: "2026-08-01T00:00:01.000Z" },
    { ...eventBinding, repositoryKey: "b/b", result: "success", occurredAt: "2026-08-01T00:00:01.000Z" },
  ];
  assert.equal(evaluateRollout(state, new Date("2026-08-01T00:00:02.000Z")).phase, "early");
});
