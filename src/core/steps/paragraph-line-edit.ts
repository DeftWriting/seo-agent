import { completeJson } from "../../adapters/llm.js";
import type {
  ArticlePlan,
  CitationEvidence,
  LineEditCategory,
  LineEditIssue,
  LineEditReport,
  ResearchBrief,
  TokenUsage,
} from "../../types.js";
import { PARAGRAPH_LINE_EDIT_SYSTEM_PROMPT } from "../prompts.js";

// A single paragraph (or, once an article exceeds the call cap, a short run of consecutive paragraphs)
// still needs less context than a request could plausibly need to double-check a whole article, so the
// search budget is intentionally smaller than the fact checker's.
const PARAGRAPH_SEARCH_MAX_RESULTS = 4;
const PARAGRAPH_MAX_TOKENS = 2_000;

export interface ArticleBlock {
  text: string;
  isHeading: boolean;
}

// Splits the article the same way the final-edit step's own paragraph-move logic does (blank-line-
// separated blocks), then labels which blocks are Markdown headings. Headings are never sent out as an
// editable passage: they are structural, not prose, and lint.ts already covers heading-level defects.
export function splitArticleBlocks(markdown: string): ArticleBlock[] {
  return markdown
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((text) => ({ text, isHeading: /^#{1,6}\s+.+$/.test(text) }));
}

// Bounds the line-edit fan-out: at most `maxChunks` groups of one or more *consecutive* paragraphs, so
// a long article never issues an unbounded number of requests. When the article fits under the cap,
// every paragraph gets its own dedicated call, matching a literal "one call per paragraph" contract.
export function chunkParagraphsForLineEdit(paragraphs: string[], maxChunks: number): string[][] {
  if (paragraphs.length === 0) return [];
  const chunkCount = Math.max(1, Math.min(maxChunks, paragraphs.length));
  const size = Math.ceil(paragraphs.length / chunkCount);
  const chunks: string[][] = [];
  for (let start = 0; start < paragraphs.length; start += size) chunks.push(paragraphs.slice(start, start + size));
  return chunks;
}

function extractParagraphUrls(text: string): string[] {
  return [...new Set([...text.matchAll(/https?:\/\/[^\s)]+/g)].map((match) => match[0].replace(/[.,;:!?]+$/, "")))];
}

// Each paragraph call gets fetched-citation evidence only for the citations that actually appear in
// ITS passage, not the whole article's citation set. Repeating every fetched page's excerpt in every
// one of up to `maxParagraphCalls` parallel calls is the single largest avoidable cost driver of
// fanning this step out; a paragraph only ever needs to check the sources it itself cites.
export function selectRelevantCitations(paragraphText: string, citations: CitationEvidence[]): CitationEvidence[] {
  const urls = new Set(extractParagraphUrls(paragraphText));
  return citations.filter((citation) => urls.has(citation.url));
}

function normalizeQuoteChars(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

function issueMatchesScope(quote: string, scope: string): boolean {
  const trimmed = quote.trim();
  if (!trimmed) return false;
  return scope.includes(trimmed) || normalizeQuoteChars(scope).includes(normalizeQuoteChars(trimmed));
}

// Merges every paragraph call's mini-report into one LineEditReport. An issue survives only if its
// quote is actually inside the passage its own call was responsible for — this both defends against a
// call hallucinating a problem outside its scope (which a different call already owns) and de-
// duplicates identical findings reported more than once.
export function mergeLineEditReports(chunks: Array<{ scope: string; report: LineEditReport }>): LineEditReport {
  const seen = new Set<string>();
  const issues: LineEditIssue[] = [];
  for (const { scope, report } of chunks) {
    for (const issue of report.issues) {
      if (!issueMatchesScope(issue.quote, scope)) continue;
      const key = `${normalizeQuoteChars(issue.quote).trim().toLowerCase()}::${issue.problem.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(issue);
    }
  }
  const bounded = issues.slice(0, 200);
  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const issue of bounded) bySeverity[issue.severity] += 1;
  const passageCount = chunks.length;
  const summary =
    bounded.length === 0
      ? `Checked ${passageCount} passage${passageCount === 1 ? "" : "s"} individually and found no issues.`
      : `Checked ${passageCount} passage${passageCount === 1 ? "" : "s"} individually and found ${bounded.length} issue${bounded.length === 1 ? "" : "s"} (${bySeverity.high} high, ${bySeverity.medium} medium, ${bySeverity.low} low severity).`;
  return { summary, issues: bounded };
}

async function runBatched<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  const size = Math.max(1, concurrency);
  for (let start = 0; start < items.length; start += size) {
    results.push(...(await Promise.all(items.slice(start, start + size).map(worker))));
  }
  return results;
}

const SEVERITIES = new Set(["low", "medium", "high"]);
const CATEGORIES = new Set<LineEditCategory>(["grammar", "spelling", "word_choice", "consistency", "style", "formatting", "sense"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseLineEditReport(value: unknown): LineEditReport {
  const root = record(value);
  const issues = Array.isArray(root.issues)
    ? root.issues.map(record).map((issue): LineEditIssue => ({
        severity: (SEVERITIES.has(text(issue.severity)) ? text(issue.severity) : "medium") as LineEditIssue["severity"],
        category: (CATEGORIES.has(text(issue.category) as LineEditCategory) ? text(issue.category) : "sense") as LineEditCategory,
        quote: text(issue.quote),
        problem: text(issue.problem),
        suggestedFix: text(issue.suggestedFix),
      }))
    : [];
  return { summary: text(root.summary), issues };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

const EMPTY_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

export interface ParagraphLineEditOptions {
  websiteUrl: string;
  topic: string;
  markdown: string;
  research: ResearchBrief;
  plan: ArticlePlan;
  fetchedCitations: CitationEvidence[];
  apiKey: string;
  model: string;
  fallbackModel?: string | undefined;
  baseUrl?: string | undefined;
  signal?: AbortSignal | undefined;
  maxParagraphCalls: number;
  concurrency: number;
  // Fires as each individual paragraph call resolves — not once per concurrency batch — so a caller
  // sees genuine "N of M done" progress for calls that are actually still in flight together.
  onProgress?: (completed: number, total: number) => void | Promise<void>;
}

// Replaces a single whole-article line-edit call: fans out one call per paragraph (grouping paragraphs
// only when the article exceeds the configured call cap), each scoped to its own passage with the rest
// of the article as read-only context, and merges the reports back into one LineEditReport.
export async function runParagraphLineEditReview(
  options: ParagraphLineEditOptions,
): Promise<{ report: LineEditReport; usage: TokenUsage }> {
  const paragraphs = splitArticleBlocks(options.markdown)
    .filter((block) => !block.isHeading)
    .map((block) => block.text);
  const chunks = chunkParagraphsForLineEdit(paragraphs, options.maxParagraphCalls);
  let completedCount = 0;

  const results = await runBatched(chunks, options.concurrency, async (chunk) => {
    const paragraphToEdit = chunk.join("\n\n");
    const relevantCitations = selectRelevantCitations(paragraphToEdit, options.fetchedCitations);
    const completion = await completeJson({
      apiKey: options.apiKey,
      model: options.model,
      fallbackModel: options.fallbackModel,
      baseUrl: options.baseUrl,
      signal: options.signal,
      temperature: 0,
      maxTokens: PARAGRAPH_MAX_TOKENS,
      costLabel: "line_edit",
      plugins: [{ id: "web", engine: "exa", max_results: PARAGRAPH_SEARCH_MAX_RESULTS }],
      messages: [
        { role: "system", content: PARAGRAPH_LINE_EDIT_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            publication: { websiteUrl: options.websiteUrl, topic: options.topic },
            researchedWebsiteAndMarket: options.research,
            approvedArticlePlan: options.plan,
            articleContextForCoherenceOnly: options.markdown,
            paragraphToEdit,
            fetchedCitationEvidenceForThisParagraph: relevantCitations,
          }),
        },
      ],
    });
    completedCount += 1;
    await options.onProgress?.(completedCount, chunks.length);
    return { scope: paragraphToEdit, report: parseLineEditReport(completion.value), usage: completion.usage };
  });

  return {
    report: mergeLineEditReports(results.map(({ scope, report }) => ({ scope, report }))),
    usage: results.reduce((sum, result) => addUsage(sum, result.usage), EMPTY_USAGE),
  };
}
