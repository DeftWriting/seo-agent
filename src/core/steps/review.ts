import { isReachablePublicUrl } from "../../adapters/fetcher.js";
import { completeJson } from "../../adapters/llm.js";
import type {
  ResearchBrief,
  ReviewEdit,
  ReviewIssue,
  ReviewProposal,
  ReviewReport,
  TokenUsage,
} from "../../types.js";
import { REVIEW_SYSTEM_PROMPT } from "../prompts.js";
import { lintAndRepairArticle } from "./lint.js";
import { isFullSentenceMatch } from "./sentence-cuts.js";

export interface ReviewStepOptions {
  markdown: string;
  research: ResearchBrief;
  apiKey: string;
  model: string;
  fallbackModel?: string | undefined;
  baseUrl?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void | Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseProposal(value: unknown): ReviewProposal {
  const root = record(value);
  const edits = Array.isArray(root.edits)
    ? root.edits.map(record).map((edit) => ({
        find: text(edit.find),
        replace: text(edit.replace),
        type: text(edit.type),
        reason: text(edit.reason),
      })).filter((edit) => edit.find)
    : [];
  const cutSentences = Array.isArray(root.cutSentences)
    ? root.cutSentences.filter((item): item is string => typeof item === "string" && Boolean(item))
    : [];
  const issues: ReviewIssue[] = Array.isArray(root.issues)
    ? root.issues.map(record).map((issue) => ({
        severity: ["low", "medium", "high"].includes(text(issue.severity))
          ? (text(issue.severity) as ReviewIssue["severity"])
          : "medium",
        kind: text(issue.kind),
        quote: text(issue.quote),
        note: text(issue.note),
      }))
    : [];
  return { edits, cutSentences, issues };
}

function countExact(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = haystack.indexOf(needle, cursor)) >= 0) {
    count += 1;
    cursor += needle.length;
  }
  return count;
}

function words(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
}

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

// A shorter article with filler and dangling references removed is usually a better article, so cuts
// are not capped by count. What a cut may never do is take a "## " section below the point where it
// stops being a section: this floor plus headroom is that line, applied per section and recomputed
// against the *current* markdown on every cut so an earlier cut in one section is never charged to
// the wrong one.
const MIN_SECTION_WORDS_AFTER_CUTS = 60;

function proseWordCount(text: string): number {
  return text.replace(/https?:\/\/\S+/g, "").trim().split(/\s+/).filter(Boolean).length;
}

function sectionWordCounts(markdown: string): Array<{ start: number; words: number }> {
  const starts = [...markdown.matchAll(/^##\s+.+$/gm)].map((match) => match.index ?? 0);
  return starts.map((start, index) => ({
    start,
    words: proseWordCount(markdown.slice(start, starts[index + 1] ?? markdown.length)),
  }));
}

export function applyReviewProposal(
  source: string,
  proposal: ReviewProposal,
): { markdown: string; report: Omit<ReviewReport, "deadLinks" | "lint"> } {
  let markdown = source;
  const appliedEdits: ReviewEdit[] = [];
  const appliedCuts: string[] = [];
  const rejectedChanges: Array<{ change: string; reason: string }> = [];

  for (const edit of proposal.edits) {
    if (countExact(markdown, edit.find) !== 1) {
      rejectedChanges.push({ change: edit.find, reason: "Find text did not match exactly once." });
      continue;
    }
    if (edit.replace.length > edit.find.length + 30) {
      rejectedChanges.push({ change: edit.find, reason: "Replacement exceeded the character-growth limit." });
      continue;
    }
    if (addedWordCount(edit.find, edit.replace) > 3) {
      rejectedChanges.push({ change: edit.find, reason: "Replacement added more than three new words." });
      continue;
    }
    markdown = markdown.replace(edit.find, edit.replace);
    appliedEdits.push(edit);
  }

  for (const sentence of [...new Set(proposal.cutSentences)]) {
    if (countExact(markdown, sentence) !== 1) {
      rejectedChanges.push({ change: sentence, reason: "Cut text did not match exactly once." });
      continue;
    }
    if (!isFullSentenceMatch(markdown, sentence)) {
      rejectedChanges.push({ change: sentence, reason: "Cut text was not a complete sentence." });
      continue;
    }
    // Recomputed against the current markdown, not the original: earlier cuts already shifted every
    // offset, so a section map built once would attribute a later cut to the wrong section.
    const at = markdown.indexOf(sentence);
    const containingSections = sectionWordCounts(markdown).filter((entry) => entry.start <= at);
    const section = containingSections[containingSections.length - 1];
    if (section && section.words - proseWordCount(sentence) < MIN_SECTION_WORDS_AFTER_CUTS) {
      rejectedChanges.push({ change: sentence, reason: "Cutting this sentence would leave its section with almost no body text." });
      continue;
    }
    markdown = markdown.replace(sentence, "").replace(/ {2,}/g, " ");
    appliedCuts.push(sentence);
  }
  return {
    markdown: `${markdown.trim()}\n`,
    report: {
      proposal,
      appliedEdits,
      appliedCuts,
      rejectedChanges,
      issues: proposal.issues,
    },
  };
}

function markdownUrls(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g)]
    .map((match) => match[1])
    .filter((url): url is string => Boolean(url));
}

function unlinkUrl(markdown: string, url: string): string {
  return markdown.replaceAll(new RegExp(`\\[([^\\]]*)\\]\\(${escapeRegExp(url)}\\)`, "g"), "$1");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Every external URL the shipped body actually links needs a matching Sources entry — not only the
// ones the review model happened to discuss, since a bare-URL fix or a citation the writer inserted on
// its own is still a live citation once it is on the page. Labels reuse whatever the research already
// knows about that URL (a fact's source name, an existing page's title), falling back to the hostname.
function sourceLabel(url: string, research: ResearchBrief): string {
  const fact = research.facts.find((candidate) => candidate.url === url);
  if (fact?.source) return fact.source;
  const page = research.site.existingPages.find((candidate) => candidate.url === url);
  if (page?.title) return page.title;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function withSourcesSection(markdown: string, research: ResearchBrief): string {
  if (/^##\s+Sources\s*$/im.test(markdown)) return markdown;
  const urls = [...new Set(markdownUrls(markdown))];
  if (urls.length === 0) return markdown;
  const items = urls.map((url) => `- [${sourceLabel(url, research)}](${url})`);
  return `${markdown.trim()}\n\n## Sources\n\n${items.join("\n")}\n`;
}

export async function reviewStep(
  options: ReviewStepOptions,
): Promise<{ markdown: string; report: ReviewReport; usage: TokenUsage }> {
  await options.onProgress?.("Checking claims and challenging the draft");
  const response = await completeJson({
    apiKey: options.apiKey,
    model: options.model,
    fallbackModel: options.fallbackModel,
    baseUrl: options.baseUrl,
    signal: options.signal,
    temperature: 0,
    plugins: [{ id: "web", engine: "exa", max_results: 10 }],
    messages: [
      { role: "system", content: REVIEW_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Approved research facts:\n${JSON.stringify(options.research.facts, null, 2)}\n\nDraft:\n${options.markdown}`,
      },
    ],
  });
  const applied = applyReviewProposal(options.markdown, parseProposal(response.value));

  await options.onProgress?.("Checking links without sending private-network requests");
  const urls = [...new Set(markdownUrls(applied.markdown))];
  const checks = await Promise.all(
    urls.map(async (url) => ({ url, reachable: await isReachablePublicUrl(url, options.signal) })),
  );
  const deadLinks = checks.filter((check) => !check.reachable).map((check) => check.url);
  let markdown = applied.markdown;
  for (const url of deadLinks) markdown = unlinkUrl(markdown, url);

  // Finalization must never take down a completed, reviewed draft: everything below only ever
  // remediates (mechanical correction, then an honest bibliography of what actually got linked), and
  // if anything here fails unexpectedly the run still returns the bounded review markdown already in
  // hand rather than losing a finished article.
  let finalMarkdown = markdown;
  let usage = response.usage;
  let lint: ReviewReport["lint"] = { rounds: 0, passed: true, remaining: [] };
  try {
    const lintOutcome = await lintAndRepairArticle(markdown, {
      apiKey: options.apiKey,
      model: options.model,
      fallbackModel: options.fallbackModel,
      baseUrl: options.baseUrl,
      signal: options.signal,
      onProgress: (message, round, total) => options.onProgress?.(`${message} (${round}/${total})`),
    });
    usage = {
      promptTokens: usage.promptTokens + lintOutcome.usage.promptTokens,
      completionTokens: usage.completionTokens + lintOutcome.usage.completionTokens,
      totalTokens: usage.totalTokens + lintOutcome.usage.totalTokens,
    };
    lint = { rounds: lintOutcome.rounds, passed: lintOutcome.passed, remaining: lintOutcome.remaining };
    finalMarkdown = withSourcesSection(lintOutcome.markdown, options.research);
  } catch (error) {
    console.error(
      "SEO agent finalization failed; returning the bounded review draft instead of failing the run:",
      error instanceof Error ? error.message : error,
    );
  }

  return {
    markdown: `${finalMarkdown.trim()}\n`,
    report: { ...applied.report, deadLinks, lint },
    usage,
  };
}
