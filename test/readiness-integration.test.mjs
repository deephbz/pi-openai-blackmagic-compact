import test from "node:test";
import assert from "node:assert/strict";
import { zstdCompressSync } from "node:zlib";
import {
  decodeLiveRequestBody,
  runLiveCanary,
  runLocalAudit,
  withLiveBudget,
} from "../scripts/check-readiness-integration.mjs";

test("native eligibility and persisted replay preserve repaired invariants", async () => {
  const report = await runLocalAudit();

  assert.equal(report.kind, "local");
  assert.equal(report.status, "passed");
  assert.match(report.versions.installedPiCli.version, /^\d+\.\d+\.\d+/);
  assert.equal(report.versions.localPeerSdk.codingAgent.version, report.versions.localPeerSdk.piAi.version);
  assert.equal(report.sdk.nativePrepareCompaction, true);
  assert.ok(report.sdk.generatedHistories.length >= 3);
  assert.ok(report.sdk.generatedHistories.some((history) => history.custom));
  assert.ok(report.sdk.generatedHistories.every((history) => history.nativeEligible));

  const { sequence } = report;
  assert.equal(sequence.coverage.initialEligibility.eligible, true);
  assert.equal(sequence.coverage.initialReadiness.ready, true);
  assert.equal(sequence.coverage.initialReadiness.mutated, false);
  assert.equal(sequence.coverage.sameReadiness.ready, true);
  assert.equal(sequence.coverage.reopenReadiness.ready, true);
  assert.equal(sequence.coverage.crossReadiness.ready, true);
  assert.equal(sequence.coverage.changedSystem.native.eligible, true);
  assert.equal(sequence.coverage.changedSystem.readiness.ready, true);
  assert.equal(sequence.coverage.changedTools.native.eligible, true);

  assert.equal(sequence.requestChecks.sourceContextPreserved, true);
  assert.equal(sequence.requestChecks.currentInstructionPreserved, true);
  assert.equal(sequence.requestChecks.activeToolsPreserved, true);
  assert.equal(sequence.requestChecks.checkpointConsumedAfterCompaction, true);
  assert.equal(sequence.requestChecks.checkpointConsumedAfterReopen, true);
  assert.equal(sequence.requestChecks.checkpointConsumedAfterModelSwitch, true);
  assert.equal(sequence.requestChecks.postCheckpointUserPreserved, true);
  assert.equal(sequence.requestChecks.changedInstructionPreserved, true);
  assert.equal(sequence.requestChecks.activeToolsChangedPreserved, true);
  assert.equal(sequence.requestChecks.knowledgeSurvivedSameModel, true);
  assert.equal(sequence.requestChecks.knowledgeSurvivedAfterReopen, true);
  assert.equal(sequence.requestChecks.knowledgeSurvivedCrossModel, true);

  for (const request of sequence.coverage.outgoing.compact) assert.equal(request.userNonceAbsent, true);
  for (const request of sequence.coverage.outgoing.normal) assert.equal(request.userNonceAbsent, true);
  assert.deepEqual(sequence.redRepros, []);

  const { customContext, uiOnlyTail } = report.branchCases;
  assert.equal(customContext.native.eligible, true);
  assert.equal(customContext.readiness.ready, true);
  assert.equal(customContext.contextVisible, true);
  assert.equal(customContext.outgoingContextVisible, true);
  assert.equal(customContext.remoteApplied, true);

  assert.equal(uiOnlyTail.uiTailOnly.native.eligible, false);
  assert.equal(uiOnlyTail.uiTailOnly.native.sdkFailure, false);
  assert.equal(uiOnlyTail.uiTailOnly.hostIneligibleNoOp, true);
  assert.equal(uiOnlyTail.uiTailOnly.noAttemptWhenIneligible, true);
  assert.equal(uiOnlyTail.uiTailOnly.contextExcludesTail, true);
  assert.equal(uiOnlyTail.uiTailOnly.readinessMatchesNative, false);
  assert.deepEqual(report.observations, [{
    dimension: "ui_only_tail_readiness_relation",
    classification: "host_ineligible_readiness_mismatch",
    nativeEligible: false,
    readinessReady: true,
    noProviderAttempt: true,
  }]);
  assert.equal(uiOnlyTail.descendant.native.eligible, true);
  assert.equal(uiOnlyTail.descendant.readiness.ready, true);
  assert.equal(uiOnlyTail.descendant.uiTailExcludedFromContext, true);
  assert.equal(uiOnlyTail.descendant.uiTailExcludedFromNativeSource, true);
  assert.equal(uiOnlyTail.descendant.checkpointConsumedOnNormalReplay, true);
  assert.equal(uiOnlyTail.descendant.currentInstructionPreserved, true);
  assert.equal(uiOnlyTail.descendant.systemPromptPreservedInNativeSource, true);
});

test("live canary refuses an unknown cumulative call budget", async () => {
  const report = await runLiveCanary();
  assert.equal(report.status, "blocked");
  assert.equal(report.failureClass, "budget_unknown");
  assert.equal(report.limits.totalEgressVerified, false);
  assert.equal(report.limits.egressVerification, "prior_count_required");
  assert.equal("priorObservation" in report.limits, false);
  assert.equal(report.limits.remoteCalls, 0);
});

test("live budget inspects a copy of zstd request bytes and forwards originals", async () => {
  const payload = {
    instructions: "audit-system-v1",
    compaction_trigger: true,
    input: [{ role: "user", content: "synthetic compressed body" }],
  };
  const compressed = zstdCompressSync(Buffer.from(JSON.stringify(payload)));
  const originalBytes = Buffer.from(compressed);
  const requests = [];
  const fetch = withLiveBudget(async (_input, init) => {
    assert.deepEqual(Buffer.from(init.body), originalBytes);
    return new Response("{}", { status: 200 });
  }, requests, 1_000, 1);

  const response = await fetch("https://synthetic.test/responses", {
    method: "POST",
    headers: { "content-encoding": "zstd", accept: "text/event-stream" },
    body: compressed,
  });

  assert.equal(response.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].kind, "compact");
  assert.equal(requests[0].facts.currentInstruction, true);
  assert.equal(requests[0].facts.userNonceAbsent, true);
  assert.deepEqual(compressed, originalBytes);
  assert.equal(await decodeLiveRequestBody(new Request("https://synthetic.test/responses", {
    method: "POST",
    headers: { "content-encoding": "zstd" },
    body: compressed,
  })), JSON.stringify(payload));
});
