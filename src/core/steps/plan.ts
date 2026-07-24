import { completeJson } from "../../adapters/llm.js";
import type { ArticlePlan, OutlineParagraph, ResearchBrief, SourceFact, TokenUsage } from "../../types.js";
import { PLAN_SYSTEM_PROMPT } from "../prompts.js";

export interface PlanStepOptions {
  topic: string;
  url: string;
  research: ResearchBrief;
  apiKey: string;
  model: string;
  fallbackModel?: string | undefined;
  baseUrl?: string;
  signal?: AbortSignal;
}

const MIN_OUTLINE_PARAGRAPHS = 4;
const MAX_OUTLINE_PARAGRAPHS = 6;
const MIN_PARAGRAPH_DETAILS = 2;

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

// The chained writer generates roughly one paragraph per `- Paragraph N` block and then stops, so the
// block count is what actually determines section length. A model reliably returns a JSON array of
// {job, details} objects; it does not reliably reproduce exact multi-line "- Paragraph N: ...\n -
// detail" text formatting inside a JSON string field, and a single collapsed block silently produces a
// stub section (observed: sections at 7-9 words). Asking for structured data and rendering the outline
// text here, rather than asking the model to format it, removed that failure mode.
export function renderParagraphOutline(paragraphs: OutlineParagraph[]): string {
  return paragraphs
    .map((paragraph, index) =>
      [`- Paragraph ${index + 1}: ${paragraph.job}`, ...paragraph.details.map((detail) => ` - ${detail}`)].join("\n"),
    )
    .join("\n\n");
}

function outlineParagraphs(value: unknown): OutlineParagraph[] {
  if (!Array.isArray(value)) return [];
  return value.map(record).map((item) => ({
    job: text(item.job),
    details: Array.isArray(item.details)
      ? item.details.map((detail) => (typeof detail === "string" ? detail.trim() : "")).filter(Boolean)
      : [],
  }));
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
    const paragraphs = outlineParagraphs(section.paragraphs);
    if (
      paragraphs.length < MIN_OUTLINE_PARAGRAPHS ||
      paragraphs.length > MAX_OUTLINE_PARAGRAPHS ||
      paragraphs.some((paragraph) => !paragraph.job || paragraph.details.length < MIN_PARAGRAPH_DETAILS)
    ) {
      throw new Error(
        `Section ${index + 1} must plan ${MIN_OUTLINE_PARAGRAPHS}-${MAX_OUTLINE_PARAGRAPHS} paragraphs with at least ${MIN_PARAGRAPH_DETAILS} details each.`,
      );
    }
    const heading = text(section.heading);
    const summary = text(section.summary);
    if (!heading || !summary) throw new Error(`Section ${index + 1} is missing a heading or summary.`);
    const assignedFacts = facts(section.facts);
    const unapproved = assignedFacts.find((fact) => !approvedFactKeys.has(factKey(fact)));
    if (unapproved) {
      throw new Error(`Section ${index + 1} assigned a fact that is not in the research ledger.`);
    }
    return { id: `S${index + 1}`, heading, summary, paragraphs, outline: renderParagraphOutline(paragraphs), facts: assignedFacts };
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

const MAX_PLAN_ATTEMPTS = 3;

export async function planStep(
  options: PlanStepOptions,
): Promise<{ plan: ArticlePlan; usage: TokenUsage }> {
  const baseInstruction = `Site: ${options.url}\nTarget topic: ${options.topic}\n\nResearch brief:\n${JSON.stringify(options.research, null, 2)}`;
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let lastError: unknown;

  // The planner is a structured-output step, so a response can be valid JSON yet still break a structural
  // rule (wrong section count, too few paragraphs per section, an unapproved fact). `completeJson` already
  // retries model-plus-fallback for transport-level failures; this loop additionally re-asks when the
  // *content* fails `parsePlan`, feeding the exact rejection back so the model can correct it, up to
  // MAX_PLAN_ATTEMPTS. Every attempt's tokens are counted because each one is billed. This mirrors the
  // hosted planner's resilience to an occasional malformed plan rather than failing the whole run — and a
  // failed run has already spent the CLI user's own money — on the first bad output.
  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt += 1) {
    const content =
      lastError instanceof Error
        ? `${baseInstruction}\n\nYour previous response was rejected: ${lastError.message} Return corrected JSON that satisfies every requirement.`
        : baseInstruction;
    const response = await completeJson({
      apiKey: options.apiKey,
      model: options.model,
      fallbackModel: options.fallbackModel,
      baseUrl: options.baseUrl,
      signal: options.signal,
      temperature: 0.2,
      costLabel: "plan",
      messages: [
        { role: "system", content: PLAN_SYSTEM_PROMPT },
        { role: "user", content },
      ],
    });
    usage = {
      promptTokens: usage.promptTokens + response.usage.promptTokens,
      completionTokens: usage.completionTokens + response.usage.completionTokens,
      totalTokens: usage.totalTokens + response.usage.totalTokens,
    };
    try {
      return { plan: parsePlan(response.value, options.research.facts), usage };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("The planner did not return a valid plan.");
}
