import { generateWithDeft } from "../../adapters/deft.js";
import type { ArticlePlan, DraftedSection, PlannedSection, ResearchBrief, TokenUsage } from "../../types.js";
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

// The writer occasionally returns a stub for a section instead of the ~500 words the plan asked for:
// the heading again, the planner's own summary sentence, or a couple of lines. The floor is well under
// the requested length so it only catches real collapses, and the check is on the section body alone
// (URLs stripped) so a citation-heavy paragraph is not penalized for its links.
const MIN_SECTION_WORDS = 150;
const MAX_SECTION_ATTEMPTS = 2;

export function sectionWordCount(text: string): number {
  return text.replace(/https?:\/\/\S+/g, "").trim().split(/\s+/).filter(Boolean).length;
}

function normalizeForComparison(value: string): string {
  return value.replace(/[`*_~#]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function isCollapsedSection(body: string, section: Pick<PlannedSection, "heading" | "summary">): boolean {
  const normalized = normalizeForComparison(body);
  return (
    sectionWordCount(body) < MIN_SECTION_WORDS ||
    normalized === normalizeForComparison(section.heading) ||
    normalized === normalizeForComparison(section.summary)
  );
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

  function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
    return {
      promptTokens: a.promptTokens + b.promptTokens,
      completionTokens: a.completionTokens + b.completionTokens,
      totalTokens: a.totalTokens + b.totalTokens,
    };
  }

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= options.plan.sections.length) return;
      const section = options.plan.sections[index];
      if (!section) return;
      await options.onSectionStart?.(index + 1, options.plan.sections.length, section.heading);

      // A section can come back thin (a stub well under the requested length) or the Deft request
      // itself can fail transiently. Both are retried here, up to MAX_SECTION_ATTEMPTS, and every
      // attempt's usage counts toward the total since each one costs money even when discarded; the
      // longest attempt is kept.
      let best: ParsedDraftedSection | undefined;
      let sectionUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_SECTION_ATTEMPTS; attempt += 1) {
        try {
          const generation = await generateWithDeft({
            apiKey: options.apiKey,
            endpoint: options.endpoint,
            thinkingLevel: options.thinkingLevel,
            signal: options.signal,
            idempotencyKey: `seo-agent-${crypto.randomUUID()}-${section.id}-${attempt}`,
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
          sectionUsage = addUsage(sectionUsage, generation.usage);
          const parsed = parseDraftedSection(generation.text, index === 0);
          if (!best || sectionWordCount(parsed.body) > sectionWordCount(best.body)) best = parsed;
          if (!isCollapsedSection(parsed.body, section)) break;
          if (attempt < MAX_SECTION_ATTEMPTS) {
            await options.onSectionStart?.(index + 1, options.plan.sections.length, `${section.heading} (rewriting a thin section)`);
          }
        } catch (error) {
          lastError = error;
        }
      }
      if (!best) {
        throw lastError instanceof Error
          ? lastError
          : new Error(`Section ${index + 1} (${section.heading}) failed to generate.`);
      }

      if (best.articleTitle) articleTitle = best.articleTitle;
      results[index] = { ...section, heading: best.heading, text: best.body };
      usages[index] = sectionUsage;
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
