import { completeJson } from "../../adapters/llm.js";
import type { ArticlePlan, ResearchBrief, SourceFact, TokenUsage } from "../../types.js";
import { PLAN_SYSTEM_PROMPT } from "../prompts.js";

export interface PlanStepOptions {
  topic: string;
  url: string;
  research: ResearchBrief;
  apiKey: string;
  model: string;
  baseUrl?: string;
  signal?: AbortSignal;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plan response must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function facts(value: unknown): SourceFact[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(record)
    .map((fact) => ({ claim: text(fact.claim), source: text(fact.source), url: text(fact.url) }))
    .filter((fact) => fact.claim && fact.source && fact.url);
}

export function isValidParagraphOutline(outline: string): boolean {
  const blocks = outline.trim().split(/\n\s*\n/).filter(Boolean);
  return (
    blocks.length >= 2 &&
    blocks.every((block, index) => {
      const lines = block.split("\n");
      return (
        new RegExp(`^- Paragraph ${index + 1}:\\s+\\S`).test(lines[0] ?? "") &&
        lines.length >= 2 &&
        lines.slice(1).every((line) => /^ -\s+\S/.test(line))
      );
    })
  );
}

function factKey(fact: SourceFact): string {
  return JSON.stringify([fact.claim.trim(), fact.source.trim(), fact.url.trim()]);
}

export function parsePlan(value: unknown, approvedFacts: SourceFact[]): ArticlePlan {
  const root = record(value);
  const approvedFactKeys = new Set(approvedFacts.map(factKey));
  if (!Array.isArray(root.sections) || root.sections.length < 4 || root.sections.length > 7) {
    throw new Error("The planner must return 4 to 7 sections.");
  }
  const sections = root.sections.map(record).map((section, index) => {
    const outline = text(section.outline);
    if (!isValidParagraphOutline(outline)) {
      throw new Error(`Section ${index + 1} has an invalid paragraph-outline format.`);
    }
    const heading = text(section.heading);
    const summary = text(section.summary);
    if (!heading || !summary) throw new Error(`Section ${index + 1} is missing a heading or summary.`);
    const assignedFacts = facts(section.facts);
    const unapproved = assignedFacts.find((fact) => !approvedFactKeys.has(factKey(fact)));
    if (unapproved) {
      throw new Error(`Section ${index + 1} assigned a fact that is not in the research ledger.`);
    }
    return { id: `S${index + 1}`, heading, summary, outline, facts: assignedFacts };
  });
  const plan = {
    title: text(root.title),
    metaDescription: text(root.metaDescription),
    style: text(root.style),
    summary: text(root.summary),
    purpose: text(root.purpose),
    sections,
  };
  if (!plan.title || !plan.style || !plan.summary || !plan.purpose) {
    throw new Error("The planner omitted required article-level fields.");
  }
  return plan;
}

export async function planStep(
  options: PlanStepOptions,
): Promise<{ plan: ArticlePlan; usage: TokenUsage }> {
  const response = await completeJson({
    apiKey: options.apiKey,
    model: options.model,
    baseUrl: options.baseUrl,
    signal: options.signal,
    temperature: 0.2,
    messages: [
      { role: "system", content: PLAN_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Site: ${options.url}\nTarget topic: ${options.topic}\n\nResearch brief:\n${JSON.stringify(options.research, null, 2)}`,
      },
    ],
  });
  return { plan: parsePlan(response.value, options.research.facts), usage: response.usage };
}
