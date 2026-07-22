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

export async function runSeoAgent(
  options: SeoAgentRunOptions,
  onEvent?: SeoAgentEventHandler,
): Promise<SeoAgentResult> {
  const startedAt = new Date().toISOString();
  let activeStep: StepId | undefined;
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
  let usage = { ...EMPTY_USAGE };

  await emit(event({ type: "run_started", url: websiteUrl, topic }));

  try {
    options.signal?.throwIfAborted();
    activeStep = "research";
    await emit(event({ type: "step_started", step: activeStep, message: "Researching the site and search landscape" }));
    const research = await researchStep({
      url: websiteUrl,
      topic,
      apiKey: openRouterApiKey,
      model: options.researchModel ?? sharedOpenRouterModel ?? "google/gemini-3-flash-preview",
      fallbackModel: options.researchFallbackModel ?? sharedFallbackModel ?? "openai/gpt-5.4-mini",
      maxPages: Math.max(1, Math.min(options.maxPages ?? 12, 25)),
      ...(options.openRouterBaseUrl ? { baseUrl: options.openRouterBaseUrl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: (message) =>
        emit(event({ type: "step_progress", step: "research", message })),
    });
    usage = addUsage(usage, research.usage);
    await emit(event({ type: "step_complete", step: activeStep, message: "Research brief ready" }));

    activeStep = "plan";
    await emit(event({ type: "step_started", step: activeStep, message: "Planning the article" }));
    const planned = await planStep({
      topic,
      url: websiteUrl,
      research: research.brief,
      apiKey: openRouterApiKey,
      model: options.planModel ?? sharedOpenRouterModel ?? "deepseek/deepseek-v4-pro",
      fallbackModel: options.planFallbackModel ?? sharedFallbackModel ?? "openai/gpt-5.4-mini",
      ...(options.openRouterBaseUrl ? { baseUrl: options.openRouterBaseUrl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
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
    const drafted = await draftStep({
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
    });
    usage = addUsage(usage, drafted.usage);
    await emit(event({ type: "step_complete", step: activeStep, message: "All section drafts are ready" }));

    activeStep = "structural";
    await emit(event({ type: "step_started", step: activeStep, message: "Cutting and arranging the draft" }));
    const draftedPlan = {
      ...planned.plan,
      title: drafted.title,
      sections: drafted.sections.map(({ text: _text, ...section }) => section),
    };
    const structural = await structuralStep({
      plan: draftedPlan,
      sections: drafted.sections,
      apiKey: openRouterApiKey,
      model: options.editModel ?? sharedOpenRouterModel ?? "google/gemini-3-flash-preview",
      fallbackModel: options.editFallbackModel ?? sharedFallbackModel ?? "openai/gpt-5.4-nano",
      ...(options.openRouterBaseUrl ? { baseUrl: options.openRouterBaseUrl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    usage = addUsage(usage, structural.usage);
    for (const warning of structural.result.rejectedOperations) {
      await emit(event({ type: "warning", step: activeStep, message: warning }));
    }
    await emit(event({ type: "step_complete", step: activeStep, message: "Structure finalized without model-written prose" }));

    activeStep = "review";
    await emit(event({ type: "step_started", step: activeStep, message: "Fact-checking and reviewing the article" }));
    const reviewed = await reviewStep({
      markdown: structural.result.markdown,
      research: research.brief,
      apiKey: openRouterApiKey,
      model: options.reviewModel ?? sharedOpenRouterModel ?? "openai/gpt-5.4-mini",
      fallbackModel: options.reviewFallbackModel ?? sharedFallbackModel ?? "openai/gpt-5.4-nano",
      ...(options.openRouterBaseUrl ? { baseUrl: options.openRouterBaseUrl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: (message) => emit(event({ type: "step_progress", step: "review", message })),
    });
    usage = addUsage(usage, reviewed.usage);
    for (const rejected of reviewed.report.rejectedChanges) {
      await emit(event({ type: "warning", step: activeStep, message: `Dropped unsafe edit: ${rejected.reason}` }));
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
      }),
    );
    throw error;
  }
}

export type {
  SeoAgentEvent,
  SeoAgentEventHandler,
  SeoAgentResult,
  SeoAgentRunOptions,
} from "../types.js";
