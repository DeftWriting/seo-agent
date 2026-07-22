import assert from "node:assert/strict";
import test from "node:test";
import {
  isCostMeterActive,
  recordDeftCost,
  recordLlmCost,
  recordLlmFailure,
  recordLlmFallback,
  runWithCostMeter,
  summarizeCostMeter,
  withCostStep,
  type CostMeter,
} from "./cost-meter.js";

test("isCostMeterActive is false outside any meter and true inside one", async () => {
  assert.equal(isCostMeterActive(), false);
  const { promise } = runWithCostMeter(async () => {
    assert.equal(isCostMeterActive(), true);
    return "done";
  });
  await promise;
});

test("recordLlmCost and recordDeftCost are no-ops outside an active meter", () => {
  // Should not throw even though nothing is listening.
  recordLlmCost({ label: "openrouter", model: "test-model", costUsd: 1, webSearchRequests: 0, inputTokens: 10, outputTokens: 10 });
  recordDeftCost(50);
  recordLlmFailure({ model: "test-model", reason: "timeout", ms: 10, attempt: 1 });
  recordLlmFallback();
});

test("recordLlmCost tags calls with the step active at record time, including inside a concurrent fan-out", async () => {
  const { meter, promise } = runWithCostMeter(async () => {
    await withCostStep("research", async () => {
      recordLlmCost({ label: "search", model: "model-a", costUsd: 0.01, webSearchRequests: 1, inputTokens: 100, outputTokens: 50 });
    });
    await withCostStep("review", async () => {
      // A parallel fan-out (the fact-checker/line-editor fork) must still tag every call with the
      // step active when each call runs, not the step active when the outer function was entered.
      await Promise.all([
        (async () => recordLlmCost({ label: "fact_check", model: "model-b", costUsd: 0.02, webSearchRequests: 2, inputTokens: 200, outputTokens: 100 }))(),
        (async () => recordLlmCost({ label: "line_edit", model: "model-b", costUsd: 0.03, webSearchRequests: 0, inputTokens: 150, outputTokens: 60 }))(),
      ]);
    });
  });
  await promise;
  assert.equal(meter.calls.length, 3);
  assert.equal(meter.calls.filter((call) => call.step === "research").length, 1);
  assert.equal(meter.calls.filter((call) => call.step === "review").length, 2);
});

test("the meter still holds everything recorded before a run throws", async () => {
  const { meter, promise } = runWithCostMeter(async () => {
    await withCostStep("plan", async () => {
      recordLlmCost({ label: "plan", model: "model-a", costUsd: 0.05, webSearchRequests: 0, inputTokens: 10, outputTokens: 10 });
    });
    throw new Error("boom");
  });
  await assert.rejects(promise, /boom/);
  assert.equal(meter.calls.length, 1);
  assert.equal(meter.calls[0]?.step, "plan");
});

function emptyMeter(): CostMeter {
  return { calls: [], failures: [], fallbacks: 0, deftUsd: new Map() };
}

test("summarizeCostMeter sums OpenRouter and Deft cost per step and overall", () => {
  const meter = emptyMeter();
  meter.calls.push(
    { step: "research", label: "search", model: "model-a", costUsd: 0.01, webSearchRequests: 1, inputTokens: 100, outputTokens: 50 },
    { step: "review", label: "fact_check", model: "model-b", costUsd: 0.02, webSearchRequests: 2, inputTokens: 200, outputTokens: 100 },
    { step: "review", label: "line_edit", model: "model-b", costUsd: null, webSearchRequests: 0, inputTokens: 50, outputTokens: 20 },
  );
  meter.deftUsd.set("draft", 0.5);
  meter.fallbacks = 1;
  meter.failures.push({ step: "review", model: "model-b", reason: "rate_limited", ms: 500, attempt: 1 });

  const summary = summarizeCostMeter(meter, { research: 1_000, review: 2_000, draft: 3_000 }, 7_000);

  assert.equal(summary.openRouterCalls, 3);
  assert.equal(summary.unpricedCalls, 1);
  assert.equal(summary.webSearchRequests, 3);
  assert.equal(summary.fallbacksUsed, 1);
  assert.equal(summary.failedAttempts, 1);
  assert.ok(Math.abs(summary.openRouterUsd - 0.03) < 1e-9);
  assert.equal(summary.deftUsd, 0.5);
  assert.ok(Math.abs(summary.totalUsd - 0.53) < 1e-9);
  assert.equal(summary.elapsedMs, 7_000);

  const research = summary.byStep.find((entry) => entry.step === "research");
  assert.equal(research?.calls, 1);
  assert.equal(research?.ms, 1_000);
  const review = summary.byStep.find((entry) => entry.step === "review");
  assert.equal(review?.calls, 2);
  assert.ok(Math.abs((review?.usd ?? 0) - 0.02) < 1e-9);
  const draft = summary.byStep.find((entry) => entry.step === "draft");
  assert.equal(draft?.deftUsd, 0.5);
  assert.equal(draft?.calls, 0);

  const modelB = summary.byModel.find((entry) => entry.model === "model-b");
  assert.equal(modelB?.calls, 2);
  assert.ok(Math.abs((modelB?.usd ?? 0) - 0.02) < 1e-9);
  // Highest spend first.
  assert.equal(summary.byModel[0]?.model, "model-b");
});

test("summarizeCostMeter reports every pipeline step even when it made no calls", () => {
  const summary = summarizeCostMeter(emptyMeter(), {}, 0);
  assert.deepEqual(
    summary.byStep.map((entry) => entry.step),
    ["research", "plan", "draft", "structural", "review"],
  );
  assert.equal(summary.totalUsd, 0);
});
