import { safeFetch } from "../../adapters/fetcher.js";
import { completeJson } from "../../adapters/llm.js";
import type {
  AdversarialIssue,
  AdversarialSeverity,
  ArticlePlan,
  BoundedReviewResult,
  CitationEvidence,
  ClaimVerdict,
  CitationVerdict,
  FactCheckClaim,
  FactCheckCitation,
  FactCheckReport,
  FinalEditEdit,
  FinalEditIssue,
  FinalEditMove,
  FinalEditOutput,
  LineEditReport,
  ResearchBrief,
  ReviewReport,
  TokenUsage,
  VerifiedArticleSource,
} from "../../types.js";
import { FACT_CHECK_SYSTEM_PROMPT, FINAL_EDIT_SYSTEM_PROMPT } from "../prompts.js";
import { addedWords, lintAndRepairArticle, MIN_SECTION_WORDS } from "./lint.js";
import { enforceArticleContract } from "./article-contract.js";
import { runParagraphLineEditReview } from "./paragraph-line-edit.js";
import { isFullSentenceMatch } from "./sentence-cuts.js";

export interface ReviewStepOptions {
  websiteUrl: string;
  topic: string;
  markdown: string;
  research: ResearchBrief;
  plan: ArticlePlan;
  apiKey: string;
  model: string;
  fallbackModel?: string | undefined;
  baseUrl?: string | undefined;
  signal?: AbortSignal | undefined;
  // Cost/quality trade-off (see types.ts SeoAgentRunOptions.skipReview): skips the fact checker, line
  // editor, and final edit call entirely and goes straight to deterministic lint/repair and the article
  // contract. Never skips the deterministic gate itself — a run this cheap still cannot ship leaked
  // scaffolding, but it ships with no adversarial fact/line check and no verified citations.
  skipReview: boolean;
  lineEditMaxCalls: number;
  lineEditConcurrency: number;
  onProgress?: (message: string) => void | Promise<void>;
  onLineEditProgress?: (completed: number, total: number) => void | Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const SEVERITIES = new Set<AdversarialSeverity>(["low", "medium", "high"]);
function severity(value: unknown): AdversarialSeverity {
  const candidate = text(value);
  return (SEVERITIES.has(candidate as AdversarialSeverity) ? candidate : "medium") as AdversarialSeverity;
}

const CITATION_VERDICTS = new Set<CitationVerdict>(["valid", "invalid", "misleading", "unverified"]);
const CLAIM_VERDICTS = new Set<ClaimVerdict>(["true", "false", "needs_modification", "unverified"]);

function parseAdversarialIssues(value: unknown): AdversarialIssue[] {
  return Array.isArray(value)
    ? value.map(record).map((issue): AdversarialIssue => ({
        severity: severity(issue.severity),
        quote: text(issue.quote),
        problem: text(issue.problem),
        suggestedFix: text(issue.suggestedFix),
      }))
    : [];
}

function parseFactCheckReport(value: unknown): FactCheckReport {
  const root = record(value);
  const citations: FactCheckCitation[] = Array.isArray(root.citations)
    ? root.citations
        .map(record)
        .map((citation): FactCheckCitation => ({
          url: text(citation.url),
          verdict: (CITATION_VERDICTS.has(text(citation.verdict) as CitationVerdict) ? text(citation.verdict) : "unverified") as CitationVerdict,
          evidence: text(citation.evidence),
          suggestedFix: text(citation.suggestedFix),
        }))
        .filter((citation) => citation.url)
    : [];
  const claims: FactCheckClaim[] = Array.isArray(root.claims)
    ? root.claims
        .map(record)
        .map((claim): FactCheckClaim => ({
          quote: text(claim.quote),
          verdict: (CLAIM_VERDICTS.has(text(claim.verdict) as ClaimVerdict) ? text(claim.verdict) : "unverified") as ClaimVerdict,
          evidence: text(claim.evidence),
          sourceUrls: Array.isArray(claim.sourceUrls) ? claim.sourceUrls.filter((url): url is string => typeof url === "string" && Boolean(url)) : [],
          suggestedFix: text(claim.suggestedFix),
        }))
        .filter((claim) => claim.quote)
    : [];
  return { summary: text(root.summary), citations, claims, issues: parseAdversarialIssues(root.issues) };
}

function parseFinalEditOutput(value: unknown): FinalEditOutput {
  const root = record(value);
  const edits: FinalEditEdit[] = Array.isArray(root.edits)
    ? root.edits
        .map(record)
        .map((edit): FinalEditEdit => ({ find: text(edit.find), replace: text(edit.replace), type: text(edit.type), reason: text(edit.reason) }))
        .filter((edit) => edit.find)
    : [];
  const cutSentences = Array.isArray(root.cutSentences) ? root.cutSentences.filter((sentence): sentence is string => typeof sentence === "string" && Boolean(sentence)) : [];
  const moves: FinalEditMove[] = Array.isArray(root.moves)
    ? root.moves
        .map(record)
        .map((move): FinalEditMove => ({
          paragraph: text(move.paragraph),
          afterParagraph: typeof move.afterParagraph === "string" ? move.afterParagraph : null,
          reason: text(move.reason),
        }))
        .filter((move) => move.paragraph)
    : [];
  const issues: FinalEditIssue[] = Array.isArray(root.issues)
    ? root.issues.map(record).map((issue): FinalEditIssue => ({ severity: severity(issue.severity), kind: text(issue.kind), quote: text(issue.quote), note: text(issue.note) }))
    : [];
  return { edits, cutSentences, moves, issues };
}

const SIMPLE_ADDED_WORDS = new Set([
  "a", "an", "and", "as", "at", "be", "but", "by", "for", "from", "if", "in", "is", "it", "not", "of", "on", "or", "that", "the", "to", "was", "were", "with",
]);

function occurrences(text: string, find: string): number {
  return find ? text.split(find).length - 1 : 0;
}

// Aggressive cutting is a feature: a shorter article with the filler, dangling references, and
// unsupported claims removed is a better article, and the editor is usually right about which sentence
// has to go. So there is deliberately no cap on how much may be cut. What cutting may not do is destroy
// the article's structure — an emptied section is not a tighter section, it is a missing one. The floor
// is per section, derived from lint.ts's own MIN_SECTION_WORDS, with headroom rather than sitting
// exactly on it: later stages (the repair loop, the contract's link stripping) each remove a few more
// words, and a section left on the threshold crosses it before the article ships.
const MIN_SECTION_WORDS_AFTER_CUTS = MIN_SECTION_WORDS + 40;

function proseWordCount(text: string): number {
  return text.replace(/https?:\/\/\S+/g, "").trim().split(/\s+/).filter(Boolean).length;
}

function sectionWordCounts(markdown: string) {
  const starts = [...markdown.matchAll(/^##\s+.+$/gm)].map((match) => match.index ?? 0);
  return starts.map((start, index) => ({ start, words: proseWordCount(markdown.slice(start, starts[index + 1] ?? markdown.length)) }));
}

function headingRanges(markdown: string) {
  return [...markdown.matchAll(/^#{1,6}\s+.+$/gm)].map((match) => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));
}

function proseLength(text: string): number {
  return text.replace(/https?:\/\/[^\s)]+/gi, "").replace(/[[\]()`*_#]/g, "").length;
}

function sameMarkdownHeadingLevel(find: string, replace: string): boolean {
  const before = find.match(/^(#{1,6})\s+[^\n]+$/);
  const after = replace.match(/^(#{1,6})\s+[^\n]+$/);
  return Boolean(before && after && before[1] === after[1] && proseLength(replace) <= proseLength(find));
}

// Mirrors lint.ts's own word tokenizer (letters/digits, with an internal apostrophe or hyphen allowed)
// so "same words, in the same order" here means exactly what it means for the added-word guard below.
function wordSequence(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
}

// A correction that adds no word, removes no word, and reorders nothing — only quotation marks, colons,
// dashes, sentence-ending punctuation, and capitalization may differ — cannot introduce a new claim,
// because the exact same words in the exact same order are exactly what the draft already said. This is
// how a run-on is split into two sentences and how quoted or first-person source material spliced into
// the writer's own voice gets properly quoted: by punctuating existing prose, never by writing new
// prose. It is verified here from the text itself, not merely from a model's self-reported edit `type`,
// so a mislabeled edit gets no special treatment and still needs to earn its way past the guards below.
export function isPunctuationOnlyChange(find: string, replace: string): boolean {
  const before = wordSequence(find);
  const after = wordSequence(replace);
  return before.length > 0 && before.length === after.length && before.every((word, index) => word === after[index]);
}

export function extractMarkdownUrls(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(/https?:\/\/[^\s)]+/g)].map((match) => match[0].replace(/[.,;:!?]+$/, "")))];
}

function applyParagraphMoves(markdown: string, moves: FinalEditMove[]) {
  const blocks = markdown.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const applied: FinalEditMove[] = [];
  const dropped: Array<FinalEditMove & { guard: string }> = [];
  const moved = new Set<string>();
  for (const move of moves) {
    let guard = "";
    const sourceMatches = blocks.filter((block) => block === move.paragraph).length;
    const targetMatches = move.afterParagraph === null ? 1 : blocks.filter((block) => block === move.afterParagraph).length;
    if (sourceMatches !== 1) guard = "paragraph_not_unique";
    else if (/^#{1,6}\s/.test(move.paragraph)) guard = "heading_move_forbidden";
    else if (move.afterParagraph !== null && (/^#{1,6}\s/.test(move.afterParagraph) || move.afterParagraph === move.paragraph)) guard = "invalid_move_target";
    else if (targetMatches !== 1) guard = "target_not_unique";
    else if (moved.has(move.paragraph)) guard = "paragraph_already_moved";
    if (guard) {
      dropped.push({ ...move, guard });
      continue;
    }
    const sourceIndex = blocks.indexOf(move.paragraph);
    const [paragraph] = blocks.splice(sourceIndex, 1);
    const targetIndex = move.afterParagraph === null && /^#\s/.test(blocks[0] ?? "") ? 1 : move.afterParagraph === null ? 0 : blocks.indexOf(move.afterParagraph) + 1;
    blocks.splice(targetIndex, 0, paragraph!);
    moved.add(move.paragraph);
    applied.push(move);
  }
  return { markdown: blocks.join("\n\n"), applied, dropped };
}

// Applies the final edit call's deterministic operations and guards every single one of them. Never
// accepts a model-rewritten document — only exact, unique, non-overlapping edits against the markdown
// already in hand, bounded so a fix cannot smuggle in new claims, new URLs, or a gutted section.
export function applyBoundedReview(
  markdown: string,
  output: FinalEditOutput,
  options: { allowedNewUrls?: Set<string> } = {},
): BoundedReviewResult {
  const moved = applyParagraphMoves(markdown, output.moves ?? []);
  let current = moved.markdown;
  const applied: FinalEditEdit[] = [];
  const dropped: Array<FinalEditEdit & { guard: string }> = [];
  const accepted: Array<{ edit: FinalEditEdit; index: number }> = [];
  const headings = headingRanges(current);
  let totalAddedWords = 0;
  for (const edit of output.edits) {
    let guard = "";
    const index = current.indexOf(edit.find);
    const punctuationOnly = isPunctuationOnlyChange(edit.find, edit.replace);
    const novelWords = addedWords(markdown, edit.replace);
    const originalUrls = new Set(extractMarkdownUrls(edit.find));
    const newUrls = extractMarkdownUrls(edit.replace).filter((url) => !originalUrls.has(url));
    if (occurrences(current, edit.find) !== 1) guard = "find_not_unique";
    else if (headings.some((heading) => index < heading.end && heading.start < index + edit.find.length) && !sameMarkdownHeadingLevel(edit.find, edit.replace)) guard = "heading_edit_forbidden";
    else if (accepted.some((item) => index < item.index + item.edit.find.length && item.index < index + edit.find.length)) guard = "overlapping_edit";
    // Punctuation-only edits are exempt from the new-word budget and the simple-word allowlist: they are
    // independently proven, above, to add and remove no word, so they cannot be the vector for a new
    // claim that those two guards exist to catch. They still must be unique, non-overlapping, introduce
    // no unverified URL, and stay within the length allowance below.
    else if (!punctuationOnly && totalAddedWords + novelWords.length > 2) guard = "too_many_new_words";
    else if (!punctuationOnly && novelWords.some((word) => !SIMPLE_ADDED_WORDS.has(word))) guard = "non_simple_new_word";
    else if (newUrls.some((url) => !options.allowedNewUrls?.has(url))) guard = "unverified_new_url";
    else if (proseLength(edit.replace) > proseLength(edit.find) + 20) guard = "replacement_too_long";
    if (guard) {
      dropped.push({ ...edit, guard });
      continue;
    }
    if (!punctuationOnly) totalAddedWords += novelWords.length;
    accepted.push({ edit, index });
    applied.push(edit);
  }
  for (const { edit, index } of accepted.sort((a, b) => b.index - a.index)) {
    current = `${current.slice(0, index)}${edit.replace}${current.slice(index + edit.find.length)}`;
  }
  // Cut as much as the editor can justify — but never past the point where a section stops being one.
  const cutsApplied: string[] = [];
  const droppedCuts: Array<{ sentence: string; guard: string }> = [];
  for (const sentence of output.cutSentences) {
    if (!isFullSentenceMatch(current, sentence)) {
      droppedCuts.push({ sentence, guard: "not_a_full_sentence" });
      continue;
    }
    // Measured against the current text, not the original: earlier cuts have already shifted every
    // offset, and a stale section map silently charges one section for another section's cuts.
    const at = current.indexOf(sentence);
    const section = sectionWordCounts(current).findLast(({ start }) => start <= at);
    if (section && section.words - proseWordCount(sentence) < MIN_SECTION_WORDS_AFTER_CUTS) {
      droppedCuts.push({ sentence, guard: "would_empty_section" });
      continue;
    }
    current = current.replace(sentence, "").replace(/ +\n/g, "\n").replace(/ {2,}/g, " ");
    cutsApplied.push(sentence);
  }
  return { markdown: current.trim(), applied, dropped, cutsApplied, droppedCuts, movesApplied: moved.applied, droppedMoves: moved.dropped };
}

function visibleText(value: string): string {
  return value
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4_000);
}

async function fetchCitationEvidence(url: string, signal: AbortSignal | undefined): Promise<CitationEvidence> {
  try {
    const result = await safeFetch(url, { method: "GET", signal, maxBytes: 2 * 1024 * 1024 });
    return { url, finalUrl: result.url, status: result.status, reachable: result.ok, excerpt: visibleText(result.text), error: null };
  } catch (error) {
    return { url, finalUrl: null, status: null, reachable: false, excerpt: "", error: error instanceof Error ? error.message : "Fetch failed" };
  }
}

async function fetchEvidenceBatch(urls: string[], signal: AbortSignal | undefined): Promise<CitationEvidence[]> {
  const results: CitationEvidence[] = [];
  for (let index = 0; index < urls.length; index += 6) {
    results.push(...(await Promise.all(urls.slice(index, index + 6).map((url) => fetchCitationEvidence(url, signal)))));
  }
  return results;
}

async function citationEvidence(markdown: string, signal: AbortSignal | undefined): Promise<CitationEvidence[]> {
  return fetchEvidenceBatch(extractMarkdownUrls(markdown).slice(0, 40), signal);
}

function editorialContext(input: { websiteUrl: string; topic: string; research: ResearchBrief; plan: ArticlePlan }) {
  return {
    publication: {
      websiteUrl: input.websiteUrl,
      topic: input.topic,
      objective:
        "Publish a new professional article on this website that attracts qualified new readers, helps them understand the company, product, positioning, and distinctive value, and supports eventual conversion without becoming a hard sell. The article should naturally position the website/company/product as a relevant solution or contribution to the topic only where the research supports it; it must not invent claims.",
    },
    researchedWebsiteAndMarket: input.research,
    approvedArticlePlan: input.plan,
  };
}

async function runFactChecker(input: {
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
}): Promise<{ report: FactCheckReport; usage: TokenUsage }> {
  const response = await completeJson({
    apiKey: input.apiKey,
    model: input.model,
    fallbackModel: input.fallbackModel,
    baseUrl: input.baseUrl,
    signal: input.signal,
    temperature: 0,
    maxTokens: 9_000,
    costLabel: "fact_check",
    plugins: [{ id: "web", engine: "exa", max_results: 10 }],
    messages: [
      { role: "system", content: FACT_CHECK_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ ...editorialContext(input), articleMarkdown: input.markdown, fetchedCitationEvidence: input.fetchedCitations }) },
    ],
  });
  return { report: parseFactCheckReport(response.value), usage: response.usage };
}

async function runFinalEdit(input: {
  websiteUrl: string;
  topic: string;
  markdown: string;
  research: ResearchBrief;
  plan: ArticlePlan;
  factChecker: FactCheckReport;
  lineEditor: LineEditReport;
  verifiedSuggestedSources: CitationEvidence[];
  apiKey: string;
  model: string;
  fallbackModel?: string | undefined;
  baseUrl?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<{ output: FinalEditOutput; usage: TokenUsage }> {
  const response = await completeJson({
    apiKey: input.apiKey,
    model: input.model,
    fallbackModel: input.fallbackModel,
    baseUrl: input.baseUrl,
    signal: input.signal,
    temperature: 0,
    maxTokens: 7_000,
    costLabel: "final_edit",
    messages: [
      { role: "system", content: FINAL_EDIT_SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          ...editorialContext(input),
          articleMarkdown: input.markdown,
          adversarialPeerReviews: { factChecker: input.factChecker, lineEditor: input.lineEditor },
          verifiedSuggestedSources: input.verifiedSuggestedSources,
          requiredOutputContract:
            "Every web-derived assertion that remains must have an inline Markdown citation to a verified supporting URL, anchored on the specific entity, statistic, or claim it supports. More citations are better than fewer. The first company, website, or product mention must link to the supplied website URL. Uncited claims must be cut. A deterministic Sources section and linked Table of Contents will be added after your surgical corrections.",
        }),
      },
    ],
  });
  return { output: parseFinalEditOutput(response.value), usage: response.usage };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens, totalTokens: a.totalTokens + b.totalTokens };
}

const EMPTY_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const EMPTY_FACT_CHECK: FactCheckReport = { summary: "Skipped: review was disabled for this run.", citations: [], claims: [], issues: [] };
const EMPTY_LINE_EDIT: LineEditReport = { summary: "Skipped: review was disabled for this run.", issues: [] };

export async function reviewStep(options: ReviewStepOptions): Promise<{ markdown: string; report: ReviewReport; usage: TokenUsage }> {
  let usage = { ...EMPTY_USAGE };
  let boundedMarkdown = options.markdown;
  let factChecker = EMPTY_FACT_CHECK;
  let lineEditor = EMPTY_LINE_EDIT;
  let finalEdit: ReviewReport["finalEdit"] = { issues: [], appliedEdits: [], droppedEdits: [], cutSentences: [], droppedCuts: [], moves: [], droppedMoves: [] };
  let verifiedSources: VerifiedArticleSource[] = [];

  if (!options.skipReview) {
    await options.onProgress?.("Fetching evidence for the article's own citations");
    const fetchedCitations = await citationEvidence(options.markdown, options.signal);

    await options.onProgress?.("Running an adversarial fact checker and line editor in parallel");
    const [factCheckResult, lineEditResult] = await Promise.all([
      runFactChecker({
        websiteUrl: options.websiteUrl,
        topic: options.topic,
        markdown: options.markdown,
        research: options.research,
        plan: options.plan,
        fetchedCitations,
        apiKey: options.apiKey,
        model: options.model,
        fallbackModel: options.fallbackModel,
        baseUrl: options.baseUrl,
        signal: options.signal,
      }),
      runParagraphLineEditReview({
        websiteUrl: options.websiteUrl,
        topic: options.topic,
        markdown: options.markdown,
        research: options.research,
        plan: options.plan,
        fetchedCitations,
        apiKey: options.apiKey,
        model: options.model,
        fallbackModel: options.fallbackModel,
        baseUrl: options.baseUrl,
        signal: options.signal,
        maxParagraphCalls: options.lineEditMaxCalls,
        concurrency: options.lineEditConcurrency,
        ...(options.onLineEditProgress ? { onProgress: options.onLineEditProgress } : {}),
      }),
    ]);
    factChecker = factCheckResult.report;
    lineEditor = lineEditResult.report;
    usage = addUsage(usage, addUsage(factCheckResult.usage, lineEditResult.usage));

    const suggestedUrls = [
      ...new Set([
        ...extractMarkdownUrls(options.markdown),
        ...factChecker.citations.filter(({ verdict }) => verdict === "valid").map(({ url }) => url),
        ...factChecker.claims.flatMap(({ sourceUrls }) => sourceUrls),
        ...options.research.facts.map(({ url }) => url),
      ]),
    ].slice(0, 40);
    await options.onProgress?.("Verifying sources named or suggested by the fact checker");
    const suggestedEvidence = await fetchEvidenceBatch(suggestedUrls, options.signal);
    const allowedNewUrls = new Set(suggestedEvidence.filter(({ reachable }) => reachable).map(({ url }) => url));
    const factCheckerApprovedUrls = new Set([
      ...factChecker.citations.filter(({ verdict }) => verdict === "valid").map(({ url }) => url),
      ...factChecker.claims.filter(({ verdict }) => verdict === "true").flatMap(({ sourceUrls }) => sourceUrls),
    ]);
    const sourceLabels = new Map<string, string>([
      ...options.research.facts.map(({ url, source }) => [url, source] as const),
      ...options.research.site.existingPages.map(({ url, title }) => [url, title] as const),
    ]);
    verifiedSources = suggestedEvidence
      .filter(({ reachable, url }) => reachable && factCheckerApprovedUrls.has(url))
      .map(({ url, finalUrl }) => ({ label: sourceLabels.get(url) ?? new URL(finalUrl ?? url).hostname.replace(/^www\./, ""), url }));

    await options.onProgress?.("Resolving both reports with a bounded final edit");
    const final = await runFinalEdit({
      websiteUrl: options.websiteUrl,
      topic: options.topic,
      markdown: options.markdown,
      research: options.research,
      plan: options.plan,
      factChecker,
      lineEditor,
      verifiedSuggestedSources: suggestedEvidence,
      apiKey: options.apiKey,
      model: options.model,
      fallbackModel: options.fallbackModel,
      baseUrl: options.baseUrl,
      signal: options.signal,
    });
    usage = addUsage(usage, final.usage);
    const bounded = applyBoundedReview(options.markdown, final.output, { allowedNewUrls });
    boundedMarkdown = bounded.markdown;
    finalEdit = {
      issues: final.output.issues,
      appliedEdits: bounded.applied,
      droppedEdits: bounded.dropped,
      cutSentences: bounded.cutsApplied,
      droppedCuts: bounded.droppedCuts,
      moves: bounded.movesApplied,
      droppedMoves: bounded.droppedMoves,
    };
  }

  // Finalization must never take down a completed draft: everything below only ever remediates
  // (mechanical correction, then the deterministic article contract), and if anything here fails
  // unexpectedly the run still returns the bounded review markdown already in hand rather than losing a
  // finished article.
  let finalMarkdown = boundedMarkdown;
  let lint: ReviewReport["lint"] = { rounds: 0, passed: true, remaining: [] };
  let contractUnmet: ReviewReport["contract"]["unmet"] = [];
  try {
    const lintOutcome = await lintAndRepairArticle(boundedMarkdown, {
      apiKey: options.apiKey,
      model: options.model,
      fallbackModel: options.fallbackModel,
      baseUrl: options.baseUrl,
      signal: options.signal,
      onProgress: (message, round, total) => options.onProgress?.(`${message} (${round}/${total})`),
    });
    usage = addUsage(usage, lintOutcome.usage);
    lint = { rounds: lintOutcome.rounds, passed: lintOutcome.passed, remaining: lintOutcome.remaining };
    if (!lintOutcome.passed) {
      console.warn(
        "SEO agent article shipped with unresolved lint findings:",
        JSON.stringify(lintOutcome.remaining.map(({ rule, quote }) => ({ rule, quote: quote.slice(0, 120) }))),
      );
    }

    const contract = enforceArticleContract({
      markdown: lintOutcome.markdown,
      websiteUrl: options.websiteUrl,
      brief: options.research,
      factCheck: factChecker,
      verifiedSources,
    });
    contractUnmet = contract.unmet;
    if (contract.unmet.length > 0) {
      console.warn("SEO agent article shipped with unmet contract requirements:", JSON.stringify(contract.unmet));
    }
    finalMarkdown = contract.markdown;
  } catch (error) {
    console.error(
      "SEO agent finalization failed; returning the bounded review draft instead of failing the run:",
      error instanceof Error ? error.message : error,
    );
  }

  return {
    markdown: `${finalMarkdown.trim()}\n`,
    report: { factChecker, lineEditor, finalEdit, lint, contract: { unmet: contractUnmet }, skipped: options.skipReview },
    usage,
  };
}
