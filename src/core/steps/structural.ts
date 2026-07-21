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
  baseUrl?: string;
  signal?: AbortSignal;
}

interface IndexedParagraph {
  id: string;
  sectionId: string;
  text: string;
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
      .map((text) => text.trim())
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

  let cuts = new Set(
    [...new Set(operations.cuts)].filter((id) => {
      if (paragraphById.has(id)) return true;
      rejectedOperations.push(`Unknown paragraph ID in cuts: ${id}`);
      return false;
    }),
  );
  if (paragraphs.length && cuts.size / paragraphs.length > 0.4) {
    rejectedOperations.push("Paragraph cuts rejected because they exceeded 40% of the draft.");
    cuts = new Set();
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
    mutable.set(id, text.replace(sentence, "").replace(/ {2,}/g, " ").trim());
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
    baseUrl: options.baseUrl,
    signal: options.signal,
    temperature: 0,
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
