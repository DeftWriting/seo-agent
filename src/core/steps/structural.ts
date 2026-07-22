import { completeJson } from "../../adapters/llm.js";
import type {
  ArticlePlan,
  DraftedSection,
  StructuralOperation,
  StructuralResult,
  TokenUsage,
} from "../../types.js";
import { STRUCTURAL_SYSTEM_PROMPT } from "../prompts.js";
import { isFullSentenceMatch } from "./sentence-cuts.js";

export interface StructuralStepOptions {
  plan: ArticlePlan;
  sections: DraftedSection[];
  apiKey: string;
  model: string;
  fallbackModel?: string | undefined;
  baseUrl?: string;
  signal?: AbortSignal;
}

interface IndexedParagraph {
  id: string;
  sectionId: string;
  text: string;
}

const NON_PROSE_BLOCK = /^(?:[-*+]|\d+\.|#{1,6}|>|```|\|)/;
const SENTENCE_END = /[.!?][)"'”’\]]*(?:\s|$)/g;

// Cutting is the structural editor's only power, and an adversarial editor will sometimes cut too much.
// Cap it at just over a third of the draft's paragraphs; the least aggressive cuts are restored until
// the article is back within budget (see applyStructuralOperations).
const MAX_CUT_RATIO = 0.35;

// A drafted section can end mid-sentence at its own generation boundary. The fragment is not a
// sentence, so the editor's sentence-cut power cannot reach it; strip it here, before the model ever
// sees the paragraph, so editing only ever reasons about complete prose.
export function withoutTrailingFragment(text: string): string {
  const trimmed = text.trimEnd();
  if (NON_PROSE_BLOCK.test(trimmed) || /[.!?)"'”’\]]$/.test(trimmed)) return trimmed;
  const complete = [...trimmed.matchAll(SENTENCE_END)].at(-1);
  // With no complete sentence to fall back on, keep the paragraph rather than delete it outright.
  if (!complete) return trimmed;
  return trimmed.slice(0, (complete.index ?? 0) + complete[0].length).trimEnd();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim())
    : [];
}

function parseOperations(value: unknown): StructuralOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Structural editor response must be a JSON object.");
  }
  const root = value as Record<string, unknown>;
  return {
    sectionOrder: stringList(root.sectionOrder),
    order: stringList(root.order),
    cuts: stringList(root.cuts),
    sentenceCuts: stringList(root.sentenceCuts),
  };
}

function indexParagraphs(sections: DraftedSection[]): IndexedParagraph[] {
  let next = 1;
  return sections.flatMap((section) =>
    section.text
      .trim()
      .split(/\n\s*\n/)
      .map((text) => withoutTrailingFragment(text.trim()))
      .filter(Boolean)
      .map((text) => ({ id: `P${next++}`, sectionId: section.id, text })),
  );
}

function exactCount(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let position = 0;
  while ((position = haystack.indexOf(needle, position)) >= 0) {
    count += 1;
    position += needle.length;
  }
  return count;
}

export function applyStructuralOperations(
  plan: ArticlePlan,
  sections: DraftedSection[],
  operations: StructuralOperation,
): StructuralResult {
  const paragraphs = indexParagraphs(sections);
  const paragraphById = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const rejectedOperations: string[] = [];

  const sectionOrder = [...new Set(operations.sectionOrder)].filter((id) => {
    if (sectionById.has(id)) return true;
    rejectedOperations.push(`Unknown section ID: ${id}`);
    return false;
  });
  for (const section of sections) if (!sectionOrder.includes(section.id)) sectionOrder.push(section.id);

  const order = [...new Set(operations.order)].filter((id) => {
    if (paragraphById.has(id)) return true;
    rejectedOperations.push(`Unknown paragraph ID in order: ${id}`);
    return false;
  });
  for (const paragraph of paragraphs) if (!order.includes(paragraph.id)) order.push(paragraph.id);

  const cuts = new Set(
    [...new Set(operations.cuts)].filter((id) => {
      if (paragraphById.has(id)) return true;
      rejectedOperations.push(`Unknown paragraph ID in cuts: ${id}`);
      return false;
    }),
  );
  // The editor is adversarial by design, so it will sometimes cut too much: gut most of the draft, or
  // empty a whole section. Cutting is its only power, so the guard is a deterministic cut budget with
  // graduated restoration — the least aggressive cuts (in draft order) are restored, rather than
  // rejecting every cut outright the moment the budget is crossed.
  const maxCuts = Math.floor(paragraphs.length * MAX_CUT_RATIO);
  let restoredCount = 0;
  for (const paragraph of paragraphs) {
    if (cuts.size <= maxCuts) break;
    if (cuts.delete(paragraph.id)) restoredCount += 1;
  }
  // A cut budget alone does not stop every planned section from being emptied by a few well-placed
  // cuts. Every planned section must keep at least one paragraph, so restore the first cut paragraph
  // in any section left with none.
  for (const sectionId of new Set(paragraphs.map((paragraph) => paragraph.sectionId))) {
    if (paragraphs.some((paragraph) => paragraph.sectionId === sectionId && !cuts.has(paragraph.id))) continue;
    const first = paragraphs.find((paragraph) => paragraph.sectionId === sectionId && cuts.has(paragraph.id));
    if (first && cuts.delete(first.id)) restoredCount += 1;
  }
  if (restoredCount > 0) {
    rejectedOperations.push(`Restored ${restoredCount} cut paragraph${restoredCount === 1 ? "" : "s"} to keep every section and stay within the cut budget.`);
  }

  const mutable = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph.text]));
  for (const sentence of [...new Set(operations.sentenceCuts)]) {
    const matches = [...mutable.entries()].filter(([, text]) => exactCount(text, sentence) === 1);
    if (matches.length !== 1) {
      rejectedOperations.push(`Sentence cut did not match exactly once: ${sentence.slice(0, 80)}`);
      continue;
    }
    const match = matches[0];
    if (!match) continue;
    const [id, text] = match;
    if (!isFullSentenceMatch(text, sentence)) {
      rejectedOperations.push(`Sentence cut was not a complete sentence: ${sentence.slice(0, 80)}`);
      continue;
    }
    const remainder = text.replace(sentence, "").replace(/ {2,}/g, " ").trim();
    // A sentence cut that would empty the paragraph is a paragraph cut in disguise, and paragraph cuts
    // are already bounded above; skip it rather than silently deleting a whole paragraph here.
    if (!remainder) {
      rejectedOperations.push(`Sentence cut would have emptied its paragraph: ${sentence.slice(0, 80)}`);
      continue;
    }
    mutable.set(id, remainder);
  }

  const rank = new Map(order.map((id, index) => [id, index]));
  const rendered = [`# ${plan.title}`];
  for (const sectionId of sectionOrder) {
    const section = sectionById.get(sectionId);
    if (!section) continue;
    const content = paragraphs
      .filter((paragraph) => paragraph.sectionId === sectionId && !cuts.has(paragraph.id))
      .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
      .map((paragraph) => mutable.get(paragraph.id)?.trim())
      .filter((paragraph): paragraph is string => Boolean(paragraph));
    if (content.length) rendered.push(`## ${section.heading}`, ...content);
  }

  return {
    markdown: `${rendered.join("\n\n").trim()}\n`,
    operations: { ...operations, sectionOrder, order, cuts: [...cuts] },
    rejectedOperations,
  };
}

export async function structuralStep(
  options: StructuralStepOptions,
): Promise<{ result: StructuralResult; usage: TokenUsage }> {
  const paragraphs = indexParagraphs(options.sections);
  const indexedDraft = options.sections
    .map((section) => {
      const body = paragraphs
        .filter((paragraph) => paragraph.sectionId === section.id)
        .map((paragraph) => `[${paragraph.id}] ${paragraph.text}`)
        .join("\n\n");
      return `[${section.id}] ${section.heading}\n\n${body}`;
    })
    .join("\n\n---\n\n");
  const response = await completeJson({
    apiKey: options.apiKey,
    model: options.model,
    fallbackModel: options.fallbackModel,
    baseUrl: options.baseUrl,
    signal: options.signal,
    temperature: 0,
    costLabel: "structural_edit",
    messages: [
      { role: "system", content: STRUCTURAL_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Article plan:\n${JSON.stringify(options.plan, null, 2)}\n\nID-indexed draft:\n${indexedDraft}`,
      },
    ],
  });
  return {
    result: applyStructuralOperations(options.plan, options.sections, parseOperations(response.value)),
    usage: response.usage,
  };
}
