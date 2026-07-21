import { generateWithDeft } from "../../adapters/deft.js";
import type { ArticlePlan, DraftedSection, ResearchBrief, TokenUsage } from "../../types.js";
import { buildSectionDraftPrompt } from "../prompts.js";

export interface DraftStepOptions {
  topic: string;
  research: ResearchBrief;
  plan: ArticlePlan;
  apiKey: string;
  endpoint?: string;
  thinkingLevel?: "faster" | "smarter";
  concurrency: number;
  signal?: AbortSignal;
  onSectionStart?: (index: number, total: number, heading: string) => void | Promise<void>;
  onSectionComplete?: (index: number, total: number, heading: string) => void | Promise<void>;
}

export async function draftStep(
  options: DraftStepOptions,
): Promise<{ sections: DraftedSection[]; usage: TokenUsage }> {
  const results = new Array<DraftedSection>(options.plan.sections.length);
  const usages = new Array<TokenUsage>(options.plan.sections.length);
  let cursor = 0;
  let completed = 0;
  const workerCount = Math.max(1, Math.min(options.concurrency, options.plan.sections.length));

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= options.plan.sections.length) return;
      const section = options.plan.sections[index];
      if (!section) return;
      await options.onSectionStart?.(index + 1, options.plan.sections.length, section.heading);
      const generation = await generateWithDeft({
        apiKey: options.apiKey,
        endpoint: options.endpoint,
        thinkingLevel: options.thinkingLevel,
        signal: options.signal,
        idempotencyKey: `seo-agent-${crypto.randomUUID()}-${section.id}`,
        prompt: buildSectionDraftPrompt({
          topic: options.topic,
          planTitle: options.plan.title,
          articleSummary: options.plan.summary,
          purpose: options.plan.purpose,
          style: options.plan.style,
          sectionHeading: section.heading,
          sectionSummary: section.summary,
          outline: section.outline,
          facts: section.facts,
          site: options.research.site,
        }),
      });
      results[index] = { ...section, text: generation.text };
      usages[index] = generation.usage;
      completed += 1;
      await options.onSectionComplete?.(completed, options.plan.sections.length, section.heading);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return {
    sections: results,
    usage: usages.reduce(
      (sum, usage) => ({
        promptTokens: sum.promptTokens + usage.promptTokens,
        completionTokens: sum.completionTokens + usage.completionTokens,
        totalTokens: sum.totalTokens + usage.totalTokens,
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    ),
  };
}
