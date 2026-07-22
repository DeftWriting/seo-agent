import { runWithCostMeter, summarizeCostMeter, withCostStep } from "../adapters/cost-meter.js";
import type {
  SeoAgentEvent,
  SeoAgentEventHandler,
  SeoAgentResult,
  SeoAgentRunOptions,
  StepId,
  TokenUsage,
} from "../types.js";
import { draftStep } from "./steps/draft.js";
import { planStep } from "./steps/plan.js";
import { researchStep } from "./steps/research.js";
import { reviewStep } from "./steps/review.js";
import { structuralStep } from "./steps/structural.js";

const EMPTY_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function addUsage(current: TokenUsage, addition: TokenUsage): TokenUsage {
  return {
    promptTokens: current.promptTokens + addition.promptTokens,
    completionTokens: current.completionTokens + addition.completionTokens,
    totalTokens: current.totalTokens + addition.totalTokens,
  };
}

function normalizedWebsiteUrl(input: string): string {
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(input.trim())
    ? input.trim()
    : `https://${input.trim()}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Website URL must use HTTP or HTTPS.");
  }
  url.hash = "";
  return url.toString();
}

function requiredKey(explicit: string | undefined, environmentName: string): string {
  const value = explicit?.trim() || process.env[environmentName]?.trim();
  if (!value) throw new Error(`Missing ${environmentName}. Pass it explicitly or set it in the environment.`);
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function runSeoAgent(
  options: SeoAgentRunOptions,
  onEvent?: SeoAgentEventHandler,
): Promise<SeoAgentResult> {
  const startedAt = new Date().toISOString();
  const runStartedMs = Date.now();
  let activeStep: StepId | undefined;
  const stepDurationsMs: Partial<Record<StepId, number>> = {};
  const emit = async (event: SeoAgentEvent): Promise<void> => {
    await onEvent?.(event);
  };
  const event = <T extends Omit<SeoAgentEvent, "at">>(value: T): T & { at: string } => ({
    ...value,
    at: new Date().toISOString(),
  });
  const websiteUrl = normalizedWebsiteUrl(options.url);
  const topic = options.topic.trim();
  if (!topic) throw new Error("Topic must not be empty.");
  const openRouterApiKey = requiredKey(options.openRouterApiKey, "OPENROUTER_API_KEY");
  const deftApiKey = requiredKey(options.deftApiKey, "DEFT_API_KEY");
  const sharedOpenRouterModel = process.env.SEO_AGENT_OPENROUTER_MODEL?.trim() || undefined;
  // Fallbacks deliberately cross provider families: the one schema rejection this kind of pipeline has
  // hit in practice was one provider refusing a strict JSON schema, which a same-provider fallback would
  // fail identically. A fallback only ever runs when the primary attempt fails (see adapters/llm.ts),
  // so it costs nothing on the normal path.
  const sharedFallbackModel = process.env.SEO_AGENT_OPENROUTER_FALLBACK_MODEL?.trim() || undefined;
  // Cost/quality knobs (see types.ts). Kept deliberately to two, both documented in README: skip peer
  // review entirely, or cap the line editor's per-paragraph fan-out. Everything else stays full quality
  // by default, matching the product owner's "make it as good as we know how" instruction.
  const skipReview = options.skipReview ?? process.env.SEO_AGENT_SKIP_REVIEW === "1";
  const lineEditMaxCalls = Math.max(1, Math.min(options.lineEditMaxCalls ?? positiveEnvInt("SEO_AGENT_LINE_EDIT_MAX_CALLS", 8), 40));
  let usage = { ...EMPTY_USAGE };

  await emit(event({ type: "run_started", url: websiteUrl, topic }));

  async function timedStep<T>(step: StepId, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await withCostStep(step, run);
    } finally {
      stepDurationsMs[step] = (stepDurationsMs[step] ?? 0) + (Date.now() - started);
    }
  }

  const { promise } = runWithCostMeter(async (meter): Promise<SeoAgentResult> => {
    try {
      options.signal?.throwIfAborted();
      activeStep = "research";
      await emit(event({ type: "step_started", step: activeStep, message: "Researching the site and search landscape" }));
      const research = await timedStep("research", () =>
        researchStep({
          url: websiteUrl,
          topic,
          apiKey: openRouterApiKey,
          model: options.researchModel ?? sharedOpenRouterModel ?? "google/gemini-3-flash-preview",
          fallbackModel: options.researchFallbackModel ?? sharedFallbackModel ?? "openai/gpt-5.4-mini",
          maxPages: Math.max(1, Math.min(options.maxPages ?? 12, 25)),
          ...(options.openRouterBaseUrl ? { baseUrl: options.openRouterBaseUrl } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          onProgress: (message) => emit(event({ type: "step_progress", step: "research", message })),
        }),
      );
      usage = addUsage(usage, research.usage);
      await emit(event({ type: "step_complete", step: activeStep, message: "Research brief ready" }));

      activeStep = "plan";
      await emit(event({ type: "step_started", step: activeStep, message: "Planning the article" }));
      const planned = await timedStep("plan", () =>
        planStep({
          topic,
          url: websiteUrl,
          research: research.brief,
          apiKey: openRouterApiKey,
          model: options.planModel ?? sharedOpenRouterModel ?? "google/gemini-3-flash-preview",
          fallbackModel: options.planFallbackModel ?? sharedFallbackModel ?? "openai/gpt-5.4-mini",
          ...(options.openRouterBaseUrl ? { baseUrl: options.openRouterBaseUrl } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      );
      usage = addUsage(usage, planned.usage);
      await emit(
        event({
          type: "step_complete",
          step: activeStep,
          message: `Planned ${planned.plan.sections.length} sections`,
        }),
      );

      activeStep = "draft";
      await emit(event({ type: "step_started", step: activeStep, message: "Drafting sections in parallel with Deft" }));
      const drafted = await timedStep("draft", () =>
        draftStep({
          topic,
          research: research.brief,
          plan: planned.plan,
          apiKey: deftApiKey,
          concurrency: Math.max(1, Math.min(options.sectionConcurrency ?? 4, 12)),
          thinkingLevel: options.thinkingLevel ?? "faster",
          ...(options.deftApiUrl ? { endpoint: options.deftApiUrl } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          onSectionStart: (index, total, heading) =>
            emit(
              event({
                type: "step_progress",
                step: "draft",
                message: `Drafting section ${index}/${total}: ${heading}`,
                completed: index - 1,
                total,
              }),
            ),
          onSectionComplete: (completed, total, heading) =>
            emit(
              event({
                type: "step_progress",
                step: "draft",
                message: `Finished ${heading}`,
                completed,
                total,
              }),
            ),
        }),
      );
      usage = addUsage(usage, drafted.usage);
      await emit(event({ type: "step_complete", step: activeStep, message: "All section drafts are ready" }));

      activeStep = "structural";
      await emit(event({ type: "step_started", step: activeStep, message: "Cutting and arranging the draft" }));
      const draftedPlan = {
        ...planned.plan,
        title: drafted.title,
        sections: drafted.sections.map(({ text: _text, ...section }) => section),
      };
      const structural = await timedStep("structural", () =>
        structuralStep({
          plan: draftedPlan,
          sections: drafted.sections,
          apiKey: openRouterApiKey,
          model: options.editModel ?? sharedOpenRouterModel ?? "google/gemini-3-flash-preview",
          fallbackModel: options.editFallbackModel ?? sharedFallbackModel ?? "openai/gpt-5.4-nano",
          ...(options.openRouterBaseUrl ? { baseUrl: options.openRouterBaseUrl } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      );
      usage = addUsage(usage, structural.usage);
      for (const warning of structural.result.rejectedOperations) {
        await emit(event({ type: "warning", step: activeStep, message: warning }));
      }
      await emit(event({ type: "step_complete", step: activeStep, message: "Structure finalized without model-written prose" }));

      activeStep = "review";
      await emit(
        event({
          type: "step_started",
          step: activeStep,
          message: skipReview ? "Running deterministic lint and repair only (review skipped)" : "Fact-checking and reviewing the article",
        }),
      );
      const sectionConcurrency = Math.max(1, Math.min(options.sectionConcurrency ?? 4, 12));
      const reviewed = await timedStep("review", () =>
        reviewStep({
          websiteUrl,
          topic,
          markdown: structural.result.markdown,
          research: research.brief,
          plan: draftedPlan,
          apiKey: openRouterApiKey,
          model: options.reviewModel ?? sharedOpenRouterModel ?? "openai/gpt-5.4-mini",
          fallbackModel: options.reviewFallbackModel ?? sharedFallbackModel ?? "openai/gpt-5.4-nano",
          skipReview,
          lineEditMaxCalls,
          // Reuses the same knob as parallel Deft section drafting rather than adding a dedicated env
          // var, matching this repo's convention of a few shared controls over many per-step ones.
          lineEditConcurrency: sectionConcurrency,
          ...(options.openRouterBaseUrl ? { baseUrl: options.openRouterBaseUrl } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          onProgress: (message) => emit(event({ type: "step_progress", step: "review", message })),
          onLineEditProgress: (completed, total) =>
            emit(
              event({
                type: "step_progress",
                step: "review",
                message: `Line editing paragraph ${completed}/${total}`,
                completed,
                total,
              }),
            ),
        }),
      );
      usage = addUsage(usage, reviewed.usage);
      for (const dropped of reviewed.report.finalEdit.droppedEdits) {
        await emit(event({ type: "warning", step: activeStep, message: `Dropped unsafe edit: ${dropped.guard}` }));
      }
      for (const dropped of reviewed.report.finalEdit.droppedCuts) {
        await emit(event({ type: "warning", step: activeStep, message: `Dropped unsafe cut: ${dropped.guard}` }));
      }
      for (const dropped of reviewed.report.finalEdit.droppedMoves) {
        await emit(event({ type: "warning", step: activeStep, message: `Dropped unsafe move: ${dropped.guard}` }));
      }
      if (!reviewed.report.lint.passed) {
        await emit(
          event({
            type: "warning",
            step: activeStep,
            message: `Shipped with ${reviewed.report.lint.remaining.length} unresolved lint finding${reviewed.report.lint.remaining.length === 1 ? "" : "s"} after ${reviewed.report.lint.rounds} repair round${reviewed.report.lint.rounds === 1 ? "" : "s"}.`,
          }),
        );
      }
      for (const unmet of reviewed.report.contract.unmet) {
        await emit(event({ type: "warning", step: activeStep, message: `Unmet article requirement (${unmet.requirement}): ${unmet.detail}` }));
      }
      await emit(event({ type: "step_complete", step: activeStep, message: "Article ready" }));

      const result: SeoAgentResult = {
        url: websiteUrl,
        topic,
        research: research.brief,
        plan: draftedPlan,
        sections: drafted.sections,
        structural: structural.result,
        review: reviewed.report,
        markdown: reviewed.markdown,
        usage,
        cost: summarizeCostMeter(meter, stepDurationsMs, Date.now() - runStartedMs),
        startedAt,
        completedAt: new Date().toISOString(),
      };
      await emit(event({ type: "run_complete", result }));
      return result;
    } catch (error) {
      await emit(
        event({
          type: "run_failed",
          ...(activeStep ? { step: activeStep } : {}),
          error: messageOf(error),
          partialCost: summarizeCostMeter(meter, stepDurationsMs, Date.now() - runStartedMs),
        }),
      );
      throw error;
    }
  });

  return promise;
}

export type {
  SeoAgentEvent,
  SeoAgentEventHandler,
  SeoAgentResult,
  SeoAgentRunOptions,
} from "../types.js";
