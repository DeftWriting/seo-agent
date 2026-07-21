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

export interface ReviewStepOptions {
  markdown: string;
  research: ResearchBrief;
  apiKey: string;
  model: string;
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

export function applyReviewProposal(
  source: string,
  proposal: ReviewProposal,
): { markdown: string; report: Omit<ReviewReport, "deadLinks"> } {
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

export async function reviewStep(
  options: ReviewStepOptions,
): Promise<{ markdown: string; report: ReviewReport; usage: TokenUsage }> {
  await options.onProgress?.("Checking claims and challenging the draft");
  const response = await completeJson({
    apiKey: options.apiKey,
    model: options.model,
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

  return {
    markdown: `${markdown.trim()}\n`,
    report: { ...applied.report, deadLinks },
    usage: response.usage,
  };
}
