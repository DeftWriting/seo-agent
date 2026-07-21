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

export interface ParsedDraftedSection {
  articleTitle?: string;
  heading: string;
  body: string;
}

export function parseDraftedSection(text: string, includeArticleTitle: boolean): ParsedDraftedSection {
  const lines = text.trim().split(/\r?\n/);
  let cursor = 0;
  const nextNonemptyLine = (): string | undefined => {
    while (cursor < lines.length && !(lines[cursor] ?? "").trim()) cursor += 1;
    const line = lines[cursor];
    cursor += 1;
    return line?.trim();
  };

  let articleTitle: string | undefined;
  if (includeArticleTitle) {
    const titleLine = nextNonemptyLine();
    const titleMatch = /^#(?!#)\s+(.+)$/.exec(titleLine ?? "");
    if (!titleMatch?.[1]?.trim()) throw new Error("Deft section 1 did not return the required article title.");
    articleTitle = titleMatch[1].trim();
  }
  const headingLine = nextNonemptyLine();
  const headingMatch = /^##(?!#)\s+(.+)$/.exec(headingLine ?? "");
  if (!headingMatch?.[1]?.trim()) throw new Error("Deft did not return the required section heading.");
  const body = lines.slice(cursor).join("\n").trim();
  if (!body) throw new Error("Deft returned a section heading without a body.");
  return {
    ...(articleTitle ? { articleTitle } : {}),
    heading: headingMatch[1].trim(),
    body,
  };
}

export async function draftStep(
  options: DraftStepOptions,
): Promise<{ title: string; sections: DraftedSection[]; usage: TokenUsage }> {
  const results = new Array<DraftedSection>(options.plan.sections.length);
  let articleTitle: string | undefined;
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
          includeArticleTitle: index === 0,
        }),
      });
      const parsed = parseDraftedSection(generation.text, index === 0);
      if (parsed.articleTitle) articleTitle = parsed.articleTitle;
      results[index] = { ...section, heading: parsed.heading, text: parsed.body };
      usages[index] = generation.usage;
      completed += 1;
      await options.onSectionComplete?.(completed, options.plan.sections.length, section.heading);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (!articleTitle) throw new Error("Deft did not return an article title.");
  return {
    title: articleTitle,
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
