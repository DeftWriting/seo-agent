import { completeJson } from "../../adapters/llm.js";
import type { ArticleLintFinding, ArticleLintRule, TokenUsage } from "../../types.js";

// Deterministic article quality gate. Every rule here is a mechanical check on the Markdown, so a
// failure is a fact rather than a model opinion. Deliberately a smaller rule set than production's:
// skipped are `bare_source_domain` (the URL-in-prose rule already catches the common case) and the
// ambiguous "paragraph opens with a planted title" heuristic, which production itself flags as
// low-precision and resolves with a dedicated per-paragraph reviewer this CLI does not run. The rules
// kept here are the unambiguous, mechanically-decidable ones.
const MIN_REPEATED_SENTENCE_LENGTH = 60;

function normalize(value: string): string {
  return value.replace(/[`*_~]/g, "").replace(/\s+/g, " ").trim().replace(/[.:?!]+$/, "").toLowerCase();
}

function markdownLinkRanges(markdown: string) {
  return [...markdown.matchAll(/\[[^\]]*]\((https?:\/\/[^\s)]+)\)/g)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function outsideLinks(markdown: string, pattern: RegExp) {
  const ranges = markdownLinkRanges(markdown);
  return [...markdown.matchAll(pattern)].filter((match) => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    return !ranges.some((range) => start < range.end && range.start < end);
  });
}

function sentences(text: string): string[] {
  return text.replace(/\n+/g, " ").split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}

interface Section {
  heading: string;
  body: string;
}

const GENERATED_HEADINGS = new Set(["sources", "table of contents"]);

export function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      if (current) sections.push(current);
      current = { heading: heading[1]!.trim(), body: "" };
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  if (current) sections.push(current);
  return sections.map((section) => ({ ...section, body: section.body.trim() }));
}

export function lintArticle(markdown: string): ArticleLintFinding[] {
  const findings: ArticleLintFinding[] = [];
  // Sources/Table of Contents are deterministically generated, not drafted prose, so they are excluded
  // from every rule below rather than teaching each rule to recognize them individually.
  const sections = splitSections(markdown).filter((section) => !GENERATED_HEADINGS.has(normalize(section.heading)));
  const prose = sections.map((section) => section.body).join("\n\n");

  const seenHeadings = new Set<string>();
  for (const section of sections) {
    const key = normalize(section.heading);
    if (seenHeadings.has(key)) {
      findings.push({ rule: "duplicate_heading", quote: section.heading, detail: "Two sections share the same heading." });
    }
    seenHeadings.add(key);

    const firstLine = section.body.split("\n").find((line) => line.trim().length > 0) ?? "";
    if (key && normalize(firstLine).startsWith(key)) {
      findings.push({
        rule: "heading_restated_in_body",
        quote: firstLine.slice(0, 240),
        detail: `The body of "${section.heading}" opens by restating the heading, which then appears twice.`,
      });
    }
  }

  const title = markdown.match(/^#\s+(.+)$/m)?.[1] ?? "";
  const firstProseLine = prose.split("\n").find((line) => line.trim().length > 0) ?? "";
  if (title && normalize(firstProseLine).startsWith(normalize(title))) {
    findings.push({ rule: "title_restated_in_body", quote: firstProseLine.slice(0, 240), detail: "The article opens by restating its own title." });
  }

  for (const match of outsideLinks(prose, /https?:\/\/[^\s)\]]+/g)) {
    findings.push({ rule: "bare_url_in_prose", quote: match[0], detail: "A raw URL sits in the prose instead of a Markdown link over meaningful words." });
  }

  const seenSentences = new Set<string>();
  for (const sentence of sentences(prose)) {
    if (sentence.length < MIN_REPEATED_SENTENCE_LENGTH) continue;
    const key = normalize(sentence);
    if (seenSentences.has(key)) {
      findings.push({ rule: "repeated_sentence", quote: sentence.slice(0, 240), detail: "This sentence appears more than once in the article." });
    } else {
      seenSentences.add(key);
    }
  }

  for (const match of prose.matchAll(/^\s*-\s+Paragraph\s+\d+\b.*$/gm)) {
    findings.push({ rule: "outline_artifact", quote: match[0].trim().slice(0, 240), detail: "Outline scaffolding leaked into the article body." });
  }

  // A section is drafted independently and can end mid-sentence if the model stops early. Only prose
  // paragraphs are checked; list items, headings, and code blocks are exempt.
  for (const section of sections) {
    for (const block of section.body.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean)) {
      if (/^(?:[-*+]|\d+\.|#{1,6}|>|```|\|)/.test(block)) continue;
      const last = sentences(block).at(-1);
      if (last && !/[.!?)"'”’\]]$/.test(last)) {
        findings.push({ rule: "unterminated_paragraph", quote: last.slice(-240), detail: `A paragraph in "${section.heading}" stops mid-sentence.` });
      }
    }
  }

  return findings;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
}

// Words in `replace` that `find` cannot account for. A zero result means every word in the replacement
// was already somewhere in the text, so the repair could not have introduced new writing.
export function addedWordCount(find: string, replace: string): number {
  const available = new Map<string, number>();
  for (const word of words(find)) available.set(word, (available.get(word) ?? 0) + 1);
  let added = 0;
  for (const word of words(replace)) {
    const count = available.get(word) ?? 0;
    if (count > 0) available.set(word, count - 1);
    else added += 1;
  }
  return added;
}

export interface ArticleRepairEdit {
  rule: string;
  find: string;
  replace: string;
}

function occurrences(text: string, find: string): number {
  return find ? text.split(find).length - 1 : 0;
}

// The repair model may only rearrange, cut, and relabel words the article already contains. Anything
// that would be new writing, non-unique, or overlapping is dropped and left for the linter to re-report.
export function applyRepairEdits(markdown: string, edits: ArticleRepairEdit[]): { markdown: string; applied: ArticleRepairEdit[]; dropped: string[] } {
  const accepted: Array<{ edit: ArticleRepairEdit; index: number }> = [];
  const dropped: string[] = [];
  for (const edit of edits) {
    const index = markdown.indexOf(edit.find);
    let guard = "";
    if (!edit.find.trim()) guard = "empty find";
    else if (occurrences(markdown, edit.find) !== 1) guard = "find not unique";
    else if (edit.find === edit.replace) guard = "no change";
    else if (addedWordCount(markdown, edit.replace) > 0) guard = "introduces new words";
    else if (accepted.some((item) => index < item.index + item.edit.find.length && item.index < index + edit.find.length)) guard = "overlapping edit";
    if (guard) {
      dropped.push(`${edit.find.slice(0, 60)} (${guard})`);
      continue;
    }
    accepted.push({ edit, index });
  }
  let text = markdown;
  for (const { edit, index } of [...accepted].sort((a, b) => b.index - a.index)) {
    text = `${text.slice(0, index)}${edit.replace}${text.slice(index + edit.find.length)}`;
  }
  return {
    markdown: text.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim(),
    applied: accepted.map(({ edit }) => edit),
    dropped,
  };
}

const REPAIR_SYSTEM_PROMPT = `You are the final mechanical corrector for a published SEO article. A deterministic linter has flagged specific defects. Return the smallest set of exact find/replace operations that clears every flagged defect and nothing else.

You are not writing. Every word in a replacement must already appear somewhere in the supplied article; introducing any new word or claim is forbidden and will be rejected. Fix a restated heading or title by deleting the restatement. Fix a bare URL by deleting it and, where the same URL is already linked nearby, wrapping existing meaningful words from that sentence in the Markdown link instead. Fix a repeated sentence by deleting the later copy. Fix leaked outline scaffolding by deleting the fragment. Fix a paragraph that stops mid-sentence by deleting the entire incomplete trailing sentence, so the paragraph ends on its last complete one.

Each "find" must be an exact substring of the article that occurs exactly once, and edits must not overlap. Preserve all Markdown heading lines. Return JSON only: {"edits":[{"rule":"","find":"","replace":""}]}`;

function parseRepairEdits(value: unknown): ArticleRepairEdit[] {
  const root = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  if (!Array.isArray(root.edits)) return [];
  return root.edits
    .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : {}))
    .map((item) => ({
      rule: typeof item.rule === "string" ? item.rule : "",
      find: typeof item.find === "string" ? item.find : "",
      replace: typeof item.replace === "string" ? item.replace : "",
    }))
    .filter((edit) => edit.find);
}

// Bounded at 2 rounds rather than production's 3: this is a smaller rule set with less to loop on, and
// a repair round that does not make progress already breaks out early below.
const MAX_REPAIR_ROUNDS = 2;

export interface LintAndRepairOptions {
  apiKey: string;
  model: string;
  fallbackModel?: string | undefined;
  baseUrl?: string | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: (message: string, round: number, totalRounds: number) => void | Promise<void>;
}

export interface LintAndRepairResult {
  markdown: string;
  rounds: number;
  remaining: ArticleLintFinding[];
  passed: boolean;
  usage: TokenUsage;
}

const EMPTY_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

// Lint, repair, re-lint, until the article is clean or the rounds run out. This never throws for a
// content-quality reason: an unrepaired finding is simply returned in `remaining` for the caller to log,
// because a completed, drafted article must always reach the user (see reviewStep's own try/catch).
export async function lintAndRepairArticle(markdown: string, options: LintAndRepairOptions): Promise<LintAndRepairResult> {
  let current = markdown;
  let rounds = 0;
  let usage = { ...EMPTY_USAGE };
  for (let round = 0; round < MAX_REPAIR_ROUNDS; round += 1) {
    const findings = lintArticle(current);
    if (findings.length === 0) break;
    rounds += 1;
    await options.onProgress?.(`Correcting ${findings.length} article defect${findings.length === 1 ? "" : "s"}`, round + 1, MAX_REPAIR_ROUNDS);
    const response = await completeJson({
      apiKey: options.apiKey,
      model: options.model,
      fallbackModel: options.fallbackModel,
      baseUrl: options.baseUrl,
      signal: options.signal,
      temperature: 0,
      messages: [
        { role: "system", content: REPAIR_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ articleMarkdown: current, lintFindings: findings }) },
      ],
    });
    usage = {
      promptTokens: usage.promptTokens + response.usage.promptTokens,
      completionTokens: usage.completionTokens + response.usage.completionTokens,
      totalTokens: usage.totalTokens + response.usage.totalTokens,
    };
    const repaired = applyRepairEdits(current, parseRepairEdits(response.value));
    if (repaired.markdown === current) break;
    current = repaired.markdown;
  }
  const remaining = lintArticle(current);
  return { markdown: current, rounds, remaining, passed: remaining.length === 0, usage };
}

export type { ArticleLintFinding, ArticleLintRule };
