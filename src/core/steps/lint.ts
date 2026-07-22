import { completeJson } from "../../adapters/llm.js";
import type { ArticleLintFinding, ArticleLintRule, TokenUsage } from "../../types.js";

// Deterministic article quality gate. Every rule here is a mechanical check on the Markdown, so a
// failure is a fact rather than a model opinion. Deliberately a smaller rule set than production's:
// skipped are `bare_source_domain` (the URL-in-prose rule already catches the common case),
// `unbalanced_link_markup` (article-contract.ts's own link insertion is careful enough that this has
// not been observed here), and `empty_section` (the structural and review cut guards already refuse to
// take a section below a floor, so a section reaching the linter empty would mean one of those guards
// regressed, not a new independent failure mode to detect here). The rules kept are the ones that are
// either unambiguous and mechanically decidable, or — for `paragraph_opens_with_heading` — ambiguous in
// a way this pipeline now has a reader to resolve (see below).
export const MIN_SECTION_WORDS = 60;
const MIN_REPEATED_SENTENCE_LENGTH = 60;

// Rules a text model can resolve by cutting or relabelling existing material. `duplicate_heading`
// describes missing/duplicated structure rather than a deletable fragment, so it is reported but never
// sent out for "fixing" — same as production.
const REPAIRABLE_RULES = new Set<ArticleLintRule>([
  "heading_restated_in_body",
  "title_restated_in_body",
  "bare_url_in_prose",
  "repeated_sentence",
  "outline_artifact",
  "unterminated_paragraph",
  "paragraph_opens_with_heading",
]);

export function isRepairableLintFinding(finding: ArticleLintFinding): boolean {
  return REPAIRABLE_RULES.has(finding.rule);
}

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

// ---- paragraph_opens_with_heading: detecting a planted title/kicker/byline vs. ordinary prose ----
//
// A paragraph that opens with a source document's own headline, kicker, or byline reads, structurally,
// exactly like ordinary prose that happens to start with a capitalized proper noun phrase — "The United
// Nations Security Council convened an emergency session" is not a defect, but "The Modern Guide to
// Widgets There is a growing community" is. Only grammar tells them apart, not shape, so this rule is
// deliberately conservative: it only fires past a threshold long enough that a legitimate leading noun
// phrase essentially never crosses it, except when a colon proves a kicker, which is unambiguous at any
// length. The genuinely ambiguous middle ground is left to the per-paragraph line editor (see
// paragraph-line-edit.ts), which reads the passage rather than pattern-matching it.

const TITLE_CASE_CONNECTORS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "if", "in", "into",
  "nor", "of", "off", "on", "onto", "or", "over", "per", "so", "than", "the",
  "to", "up", "via", "with", "yet",
]);

// A colon-terminated kicker ("The Modern Guide to Widgets:") is unambiguous, so a short run is enough.
// Without that colon the run has to be long before it means anything: an institutional name flowing
// into its verb — "The United Nations Security Council convened", "The World Health Organization
// recommends" — is ordinary prose and reaches four capitalized words on its own. Missing a short bare
// title costs a miss; flagging a real noun phrase costs a repair round and risks deleting live prose.
const MAX_LEADING_CAPS_BEFORE_KICKER = 3;
const MAX_LEADING_CAPS_BEFORE_HEADING = 6;

function isTitleCaseWord(core: string): boolean {
  if (/^\p{Lu}{2,}$/u.test(core)) return true; // an acronym (AI, SEO, GEO) reads as capitalized either way
  return core.split("-").every((part) => part.length > 0 && /^\p{Lu}[\p{L}'’]*$/u.test(part));
}

// Walks tokens from the start of `text`, returning how many were capitalized (the title-cased run) and
// how many tokens total were consumed. Lowercase connectors and numerals/roman numerals are consumed
// without counting as capitalized, so a "(Part 1 of 4)" volume marker or a "By Jane Doe" byline extends
// the run instead of ending it. A comma/semicolon or a real sentence terminator ends the run there: an
// enumerated list is ordinary prose, not a planted heading.
function leadingCapitalizedRun(text: string): { capitalized: number; consumed: number; tokenCount: number; kicker: boolean } {
  const tokens = text.split(/\s+/).filter(Boolean);
  let capitalized = 0;
  let consumed = 0;
  for (const token of tokens) {
    const core = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!core) break;
    const numeral = /^(?:\d+|[ivxlcdm]+)$/i.test(core);
    const titleCase = isTitleCaseWord(core);
    if (!titleCase && !numeral && !TITLE_CASE_CONNECTORS.has(core.toLowerCase())) break;
    if (titleCase) capitalized += 1;
    consumed += 1;
    // A colon ends a kicker and is the boundary the fragment must stop at, or the reported quote runs
    // on into the real sentence and a verbatim deletion would take its first words with it.
    if (/:/.test(token)) return { capitalized, consumed, tokenCount: tokens.length, kicker: true };
    if (/[,;]/.test(token) || /[.!?]$/.test(token)) break;
  }
  return { capitalized, consumed, tokenCount: tokens.length, kicker: false };
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

      // A paragraph opening with a Markdown link is a deliberate citation embed, not source-document
      // chrome, so it is exempt. Research reads other people's published pages, and their own
      // title/byline sometimes rides along into a drafted paragraph as if it were the first sentence.
      if (!block.startsWith("[")) {
        const { capitalized, consumed, tokenCount, kicker } = leadingCapitalizedRun(block);
        const threshold = kicker ? MAX_LEADING_CAPS_BEFORE_KICKER : MAX_LEADING_CAPS_BEFORE_HEADING;
        if (capitalized > threshold && consumed < tokenCount) {
          const fragment = block.split(/\s+/).slice(0, consumed).join(" ");
          findings.push({
            rule: "paragraph_opens_with_heading",
            quote: fragment.slice(0, 240),
            detail: `A paragraph in "${section.heading}" opens with what reads as a planted title, heading, byline, or kicker instead of its real first sentence.`,
          });
        }
      }
    }
  }

  return findings;
}

// URLs are stripped before tokenizing: without this, wrapping an already-linked or otherwise-present
// URL in `[label](url)` would count the URL's own domain fragments ("https", "example", "com") as
// brand-new words, even though the guard's actual job is to police new *prose*, not new addresses. A
// new URL's reachability and provenance are policed separately (see review.ts's `unverified_new_url`
// guard), so this tokenizer only needs to reason about words a human would read as writing.
function words(text: string): string[] {
  const withoutUrls = text.replace(/https?:\/\/[^\s)]+/gi, "");
  return withoutUrls.toLowerCase().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
}

// Words in `replace` that `find` cannot account for. An empty result means every word in the
// replacement was already somewhere in the text, so the repair could not have introduced new writing.
export function addedWords(find: string, replace: string): string[] {
  const available = new Map<string, number>();
  for (const word of words(find)) available.set(word, (available.get(word) ?? 0) + 1);
  const added: string[] = [];
  for (const word of words(replace)) {
    const count = available.get(word) ?? 0;
    if (count > 0) available.set(word, count - 1);
    else added.push(word);
  }
  return added;
}

export function addedWordCount(find: string, replace: string): number {
  return addedWords(find, replace).length;
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
// A new URL gets its own explicit guard rather than riding on the word-count guard: `words()` (and so
// `addedWordCount`) deliberately strips URLs before tokenizing, so a URL's own domain fragments never
// count as new prose — but that means a brand-new URL needs a check of its own, or repair could smuggle
// one in for free.
export function applyRepairEdits(markdown: string, edits: ArticleRepairEdit[]): { markdown: string; applied: ArticleRepairEdit[]; dropped: string[] } {
  const accepted: Array<{ edit: ArticleRepairEdit; index: number }> = [];
  const dropped: string[] = [];
  const knownUrls = new Set([...markdown.matchAll(/https?:\/\/[^\s)\]]+/g)].map((match) => match[0]));
  for (const edit of edits) {
    const index = markdown.indexOf(edit.find);
    const newUrls = [...edit.replace.matchAll(/https?:\/\/[^\s)\]]+/g)].map((match) => match[0]).filter((url) => !knownUrls.has(url));
    let guard = "";
    if (!edit.find.trim()) guard = "empty find";
    else if (occurrences(markdown, edit.find) !== 1) guard = "find not unique";
    else if (edit.find === edit.replace) guard = "no change";
    else if (addedWordCount(markdown, edit.replace) > 0) guard = "introduces new words";
    else if (newUrls.length > 0) guard = "introduces new url";
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

You are not writing. Every word in a replacement must already appear somewhere in the supplied article; introducing any new word or claim is forbidden and will be rejected. Fix a restated heading or title by deleting the restatement. Fix a paragraph that opens with a planted title, heading, byline, or kicker (a source document's headline, a "Part II"-style volume marker, a "By Jane Doe" byline, or similar fragment glued onto the front of the paragraph) by deleting exactly that leading fragment, so the paragraph begins at its real first sentence; do not touch the real sentence itself. Fix a bare URL by deleting it and, where the same URL is already linked nearby, wrapping existing meaningful words from that sentence in the Markdown link instead. Fix a repeated sentence by deleting the later copy. Fix leaked outline scaffolding by deleting the fragment. Fix a paragraph that stops mid-sentence by deleting the entire incomplete trailing sentence, so the paragraph ends on its last complete one.

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

// Matches production's 3-round cap now that the rule set includes the same ambiguous case
// (`paragraph_opens_with_heading`) production uses 3 rounds for.
const MAX_REPAIR_ROUNDS = 3;

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
// Only repairable findings (see isRepairableLintFinding) are ever sent to the repair model; an
// unrepairable one (duplicate_heading, which describes missing/duplicated structure rather than a
// deletable fragment) is reported straight through to `remaining` instead.
export async function lintAndRepairArticle(markdown: string, options: LintAndRepairOptions): Promise<LintAndRepairResult> {
  let current = markdown;
  let rounds = 0;
  let usage = { ...EMPTY_USAGE };
  for (let round = 0; round < MAX_REPAIR_ROUNDS; round += 1) {
    const findings = lintArticle(current);
    const repairable = findings.filter(isRepairableLintFinding);
    if (repairable.length === 0) break;
    rounds += 1;
    await options.onProgress?.(`Correcting ${repairable.length} article defect${repairable.length === 1 ? "" : "s"}`, round + 1, MAX_REPAIR_ROUNDS);
    const response = await completeJson({
      apiKey: options.apiKey,
      model: options.model,
      fallbackModel: options.fallbackModel,
      baseUrl: options.baseUrl,
      signal: options.signal,
      temperature: 0,
      costLabel: "lint_repair",
      messages: [
        { role: "system", content: REPAIR_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ articleMarkdown: current, lintFindings: repairable }) },
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
