import { AsyncLocalStorage } from "node:async_hooks";
import {
  SEO_AGENT_STEPS,
  type CostSummary,
  type LlmAttemptFailure,
  type LlmCallCost,
  type StepCostSummary,
  type StepId,
} from "../types.js";

// Per-run OpenRouter and Deft spend accounting. This inverts the hosted product's own rule: a free
// tool serving anonymous visitors must never surface operating cost, but a CLI user supplies their own
// API keys and pays for every call directly, so knowing what a run cost and where the time went is a
// feature they asked for, not telemetry to hide. See CLAUDE.md.
//
// An AsyncLocalStorage meter lets every OpenRouter and Deft call report itself here regardless of how
// deeply it is nested (a parallel section draft, the fact-checker/line-editor fork, a per-paragraph
// line-edit fan-out, a model-failure fallback), without threading a cost accumulator through every
// function signature in the pipeline.
export interface CostMeter {
  calls: LlmCallCost[];
  failures: LlmAttemptFailure[];
  fallbacks: number;
  deftUsd: Map<StepId, number>;
}

interface MeterContext {
  meter: CostMeter;
  step: StepId;
}

const storage = new AsyncLocalStorage<MeterContext>();

function emptyMeter(): CostMeter {
  return { calls: [], failures: [], fallbacks: 0, deftUsd: new Map() };
}

// A zeroed-out summary for the rare fallback path where a caller needs to report a run_failed event
// without ever having had a meter to read from (see serve.ts): a run that failed before its own
// internal cost meter could be consulted has nothing to report but should still shape-match every
// other run_failed event.
export function emptyCostSummary(): CostSummary {
  return summarizeCostMeter(emptyMeter(), {}, 0);
}

/** Opens one cost meter for the whole run and starts `run` inside it, passing the same meter into
 * `run` as a parameter so a caller can read it (for a partial report) even while the run is still in
 * flight or after it has thrown. Everything `run` does — including concurrent fan-outs — reports into
 * this same meter automatically via recordX, however deeply it is nested; the parameter exists so a
 * caller can summarize it directly without waiting on a promise that might never resolve. */
export function runWithCostMeter<T>(run: (meter: CostMeter) => Promise<T>): { meter: CostMeter; promise: Promise<T> } {
  const meter = emptyMeter();
  const promise = storage.run({ meter, step: "research" }, () => run(meter));
  return { meter, promise };
}

/** Tags every cost/failure record made inside `run` with `step`, so the final summary can break
 * spend down per pipeline stage without passing a step parameter into every call site. */
export function withCostStep<T>(step: StepId, run: () => Promise<T>): Promise<T> {
  const context = storage.getStore();
  if (!context) return run();
  return storage.run({ meter: context.meter, step }, run);
}

export function isCostMeterActive(): boolean {
  return storage.getStore() !== undefined;
}

export function recordLlmCost(call: Omit<LlmCallCost, "step">): void {
  const context = storage.getStore();
  if (!context) return;
  context.meter.calls.push({ ...call, step: context.step });
}

export function recordLlmFailure(failure: Omit<LlmAttemptFailure, "step">): void {
  const context = storage.getStore();
  if (!context) return;
  context.meter.failures.push({ ...failure, step: context.step });
}

export function recordLlmFallback(): void {
  const context = storage.getStore();
  if (context) context.meter.fallbacks += 1;
}

// Deft cost is the CLI's other cost source alongside OpenRouter, and the only one that is not an LLM
// "call" in the sense above. The public API exposes only token counts, so the amount is computed from
// Deft's published per-token pricing in adapters/deft.ts, not read from a billed field.
export function recordDeftCost(amountCents: number): void {
  const context = storage.getStore();
  if (!context) return;
  const current = context.meter.deftUsd.get(context.step) ?? 0;
  context.meter.deftUsd.set(context.step, current + amountCents / 100);
}

interface StepAccumulator {
  usd: number;
  deftUsd: number;
  calls: number;
  webSearchRequests: number;
}

export function summarizeCostMeter(
  meter: CostMeter,
  stepDurationsMs: Partial<Record<StepId, number>>,
  elapsedMs: number,
): CostSummary {
  const byStepAcc = new Map<StepId, StepAccumulator>();
  const byModelAcc = new Map<string, { calls: number; usd: number }>();
  let openRouterUsd = 0;
  let unpricedCalls = 0;
  let webSearchRequests = 0;

  const stepEntry = (step: StepId): StepAccumulator => {
    const existing = byStepAcc.get(step);
    if (existing) return existing;
    const created: StepAccumulator = { usd: 0, deftUsd: 0, calls: 0, webSearchRequests: 0 };
    byStepAcc.set(step, created);
    return created;
  };

  for (const call of meter.calls) {
    const entry = stepEntry(call.step);
    entry.usd += call.costUsd ?? 0;
    entry.calls += 1;
    entry.webSearchRequests += call.webSearchRequests;
    if (call.costUsd === null) unpricedCalls += 1;
    else openRouterUsd += call.costUsd;
    webSearchRequests += call.webSearchRequests;
    const modelEntry = byModelAcc.get(call.model) ?? { calls: 0, usd: 0 };
    modelEntry.calls += 1;
    modelEntry.usd += call.costUsd ?? 0;
    byModelAcc.set(call.model, modelEntry);
  }

  let deftUsd = 0;
  for (const [step, usd] of meter.deftUsd) {
    stepEntry(step).deftUsd += usd;
    deftUsd += usd;
  }

  const byStep: StepCostSummary[] = SEO_AGENT_STEPS.map((step) => {
    const entry = byStepAcc.get(step) ?? { usd: 0, deftUsd: 0, calls: 0, webSearchRequests: 0 };
    return {
      step,
      usd: entry.usd,
      deftUsd: entry.deftUsd,
      calls: entry.calls,
      webSearchRequests: entry.webSearchRequests,
      ms: stepDurationsMs[step] ?? 0,
    };
  });

  return {
    totalUsd: openRouterUsd + deftUsd,
    openRouterUsd,
    deftUsd,
    openRouterCalls: meter.calls.length,
    unpricedCalls,
    webSearchRequests,
    failedAttempts: meter.failures.length,
    fallbacksUsed: meter.fallbacks,
    elapsedMs,
    byStep,
    byModel: [...byModelAcc.entries()]
      .map(([model, entry]) => ({ model, ...entry }))
      .sort((a, b) => b.usd - a.usd),
    failures: meter.failures,
  };
}
