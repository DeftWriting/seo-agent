import type { FactCheckReport, ResearchBrief, UnmetContractRequirement, UnmetContractRequirementKind, VerifiedArticleSource } from "../../types.js";
import { MIN_SECTION_WORDS } from "./lint.js";

const MARKDOWN_LINK = /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanHeading(value: string): string {
  return value.replace(/\[([^\]]+)]\([^)]*\)/g, "$1").replace(/[`*_~]/g, "").trim();
}

export function headingSlug(value: string): string {
  return (
    cleanHeading(value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/[\s-]+/g, "-") || "section"
  );
}

function linkRanges(markdown: string) {
  return [...markdown.matchAll(MARKDOWN_LINK)].map((match) => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, url: match[2]! }));
}

function occurrenceInsideLink(markdown: string, start: number, end: number): boolean {
  return linkRanges(markdown).some((range) => start < range.end && range.start < end);
}

function linkUniqueQuote(markdown: string, quote: string, url: string): string {
  if (!quote || quote.includes("\n") || quote.includes("]") || quote.includes("[")) return markdown;
  const first = markdown.indexOf(quote);
  if (first < 0 || first !== markdown.lastIndexOf(quote) || occurrenceInsideLink(markdown, first, first + quote.length)) return markdown;
  return `${markdown.slice(0, first)}[${quote}](${url})${markdown.slice(first + quote.length)}`;
}

function quoteIsLinked(markdown: string, quote: string): boolean {
  if (!quote) return false;
  let offset = 0;
  while (offset < markdown.length) {
    const index = markdown.indexOf(quote, offset);
    if (index < 0) return false;
    if (occurrenceInsideLink(markdown, index, index + quote.length)) return true;
    offset = index + quote.length;
  }
  return false;
}

function brandCandidates(websiteUrl: string, brief: ResearchBrief): string[] {
  const host = new URL(websiteUrl).hostname.replace(/^www\./, "").split(".")[0] ?? "";
  const inferredHostName = host.replace(/(?:writing|software|platform|online|app|ai)$/i, "");
  return [
    ...new Set(
      [brief.site.name, inferredHostName, host].filter(
        (value): value is string => Boolean(value && value.length >= 3 && value.length <= 80),
      ),
    ),
  ];
}

function linkFirstBrandMention(markdown: string, websiteUrl: string, brief: ResearchBrief): string {
  const ranges = linkRanges(markdown);
  const bareUrlRanges = [...markdown.matchAll(/https?:\/\/[^\s)]+/g)].map((match) => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));
  for (const candidate of brandCandidates(websiteUrl, brief)) {
    const matches = [...markdown.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(candidate)}(?![\\p{L}\\p{N}])`, "giu"))];
    const match = matches.find((item) => {
      const start = item.index ?? 0;
      const lineStart = markdown.lastIndexOf("\n", start) + 1;
      return (
        !markdown.slice(lineStart, start).startsWith("#") &&
        !ranges.some((range) => start < range.end && range.start < start + item[0]!.length) &&
        !bareUrlRanges.some((range) => start < range.end && range.start < start + item[0]!.length)
      );
    });
    if (!match) continue;
    const start = match.index ?? 0;
    return `${markdown.slice(0, start)}[${match[0]}](${websiteUrl})${markdown.slice(start + match[0]!.length)}`;
  }
  return markdown;
}

function stripRejectedLinks(markdown: string, rejectedUrls: Set<string>): string {
  return markdown.replace(MARKDOWN_LINK, (full, label: string, url: string) => (rejectedUrls.has(url) ? label : full));
}

// Demotes every external Markdown link to plain text, keeping the words and dropping only the
// citation markup. Used when nothing about a link can be verified: cutting the citation is the
// allowed remediation, inventing or retroactively certifying it is not.
function stripExternalLinks(markdown: string, siteOrigin: string): string {
  return markdown.replace(MARKDOWN_LINK, (full, label: string, url: string) => {
    try {
      return new URL(url).origin === siteOrigin ? full : label;
    } catch {
      return label;
    }
  });
}

const BARE_URL = /https?:\/\/[^\s)\]]+/g;

// Map order determines priority (later entries win ties): a research fact's own source name is the
// most specific label available, then an existing-page title, then whatever label the fact checker's
// verifiedSources carried, then (via labelForUrl's fallback) the bare hostname.
function sourceLabels(brief: ResearchBrief, sources: VerifiedArticleSource[]): Map<string, string> {
  return new Map<string, string>([
    ...sources.map(({ url, label }) => [url, label] as const),
    ...brief.site.existingPages.map(({ url, title }) => [url, title] as const),
    ...brief.facts.map(({ url, source }) => [url, source] as const),
  ]);
}

function labelForUrl(url: string, labels: Map<string, string>): string {
  const known = labels.get(url)?.replace(/[[\]\n]/g, "").trim();
  if (known) return known;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

// The writer is asked for inline Markdown citations but sometimes drops a raw URL into the prose
// instead. A bare URL renders as its own unreadable link text, so give it the source's name.
function linkBareUrls(markdown: string, labels: Map<string, string>, rejectedUrls: Set<string>): string {
  const ranges = linkRanges(markdown);
  let output = "";
  let cursor = 0;
  for (const match of markdown.matchAll(BARE_URL)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (ranges.some((range) => start < range.end && range.start < end)) continue;
    const trailing = match[0].match(/[.,;:!?]+$/)?.[0] ?? "";
    const url = match[0].slice(0, match[0].length - trailing.length);
    output += markdown.slice(cursor, start);
    output += rejectedUrls.has(url) ? "" : `[${labelForUrl(url, labels)}](${url})`;
    output += trailing;
    cursor = end;
  }
  // Removing a rejected bare URL can leave the parentheses that wrapped it.
  return `${output}${markdown.slice(cursor)}`.replace(/[ \t]*\(\s*\)/g, "").replace(/[ \t]{2,}/g, " ");
}

function withoutGeneratedSection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (start < 0) return markdown.trim();
  let end = start + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end]!)) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Sources must reflect what the shipped body actually links, not only the fact-checker's curated
// verifiedSources: a bare URL the writer typed, or a link that survived stripRejectedLinks without an
// explicit "true"/"valid" verdict, is still a live citation once it is on the page. So the list is the
// union of every external URL linked in the final body and verifiedSources, deduplicated by URL — never
// verifiedSources alone. There is deliberately no count cap: a correctly-cited but long list is a
// cosmetic concern, while silently dropping a source the body links to is the defect this function
// exists to prevent.
//
// Nothing here may fail the run. If the fact checker never actually verified an external source, the
// union above would otherwise let an entirely unaudited body link masquerade as a citation — so that
// specific case is handled by cutting: every external link is demoted back to plain text (the words
// stay, the false claim of sourcing does not) and the miss is recorded as an unmet requirement, rather
// than shipping an unverifiable "Sources" list or refusing to ship at all.
function appendSources(
  markdown: string,
  sources: VerifiedArticleSource[],
  websiteUrl: string,
  brief: ResearchBrief,
): { markdown: string; unmet: UnmetContractRequirement[] } {
  const siteOrigin = new URL(websiteUrl).origin;
  let withoutExisting = withoutGeneratedSection(markdown, "Sources");
  const labels = sourceLabels(brief, sources);
  const verifiedExternal = sources.filter(({ url }) => {
    try {
      return new URL(url).origin !== siteOrigin;
    } catch {
      return false;
    }
  });
  const unmet: UnmetContractRequirement[] = [];
  if (verifiedExternal.length === 0) {
    withoutExisting = stripExternalLinks(withoutExisting, siteOrigin);
    unmet.push({
      requirement: "verified_external_source",
      detail: "No verified external source survived review; unverified external links were cut from the body and Sources lists only the canonical website link.",
    });
  }
  const candidateUrls = [...linkRanges(withoutExisting).map(({ url }) => url), ...sources.map(({ url }) => url)];
  const unique = new Map<string, VerifiedArticleSource>();
  for (const url of candidateUrls) {
    try {
      const normalized = new URL(url).toString();
      if (!unique.has(normalized)) unique.set(normalized, { label: labelForUrl(normalized, labels), url: normalized });
    } catch {
      /* validation happens before this boundary */
    }
  }
  const external = [...unique.values()].filter(({ url }) => new URL(url).origin !== siteOrigin);
  const siteSource = { label: `${brief.site.name?.trim() || new URL(websiteUrl).hostname} website`, url: websiteUrl };
  const items = [...external, siteSource].map(({ label, url }) => `- [${label.replace(/[[\]\n]/g, "")}](${url})`);
  return { markdown: `${withoutExisting}\n\n## Sources\n\n${items.join("\n")}`, unmet };
}

function addTableOfContents(markdown: string): { markdown: string; unmet: UnmetContractRequirement[] } {
  const body = withoutGeneratedSection(markdown, "Table of Contents");
  const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((match) => cleanHeading(match[1]!)).filter(Boolean);
  // Nothing to link: a table of contents over zero headings would be an empty, meaningless section,
  // and there is no content to invent one from. Omit it — it is the optional element here — and
  // record the miss rather than failing the run. (In practice `appendSources` always contributes a
  // "## Sources" heading before this runs, so this path is a defensive fallback, not a normal case.)
  if (headings.length === 0) {
    return { markdown: body.trim(), unmet: [{ requirement: "table_of_contents", detail: "The article has no section headings to list, so no table of contents was added." }] };
  }
  const seen = new Map<string, number>();
  const items = headings.map((heading) => {
    const base = headingSlug(heading);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return `- [${heading}](#${count === 0 ? base : `${base}-${count}`})`;
  });
  const title = body.match(/^#\s+.+$/m);
  const unmet: UnmetContractRequirement[] = [];
  // No H1 to anchor the table of contents after: place it at the very top of the document instead of
  // fabricating a title, and record that the article shipped without one.
  const titleEnd = title?.index !== undefined ? title.index + title[0].length : 0;
  if (title?.index === undefined) {
    unmet.push({ requirement: "title", detail: "The article has no H1 title; the table of contents was placed at the top of the document instead of after a title." });
  }
  return { markdown: `${body.slice(0, titleEnd)}\n\n## Table of Contents\n\n${items.join("\n")}\n\n${body.slice(titleEnd).trimStart()}`.trim(), unmet };
}

// Mirrors the review step's identical floor (see review.ts): a cut may never take a section below
// what lint.ts's own rule set treats as a real section, with headroom for the fact that later passes
// trim a few more words each. Kept as a local constant rather than imported from review.ts to avoid a
// circular import between the two modules; if this drifts from review.ts's own constant, reconcile them.
const MIN_SECTION_WORDS_AFTER_CUTS = MIN_SECTION_WORDS + 40;

function proseWordCount(text: string): number {
  return text.replace(/https?:\/\/\S+/g, "").trim().split(/\s+/).filter(Boolean).length;
}

// Prose word count per `## ` section (including any generated Table of Contents/Sources sections,
// which is harmless here: only the section actually containing the cut position is ever consulted).
function sectionWordCounts(markdown: string) {
  const starts = [...markdown.matchAll(/^##\s+.+$/gm)].map((match) => match.index ?? 0);
  return starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? markdown.length,
    words: proseWordCount(markdown.slice(start, starts[index + 1] ?? markdown.length)),
  }));
}

function occurrences(text: string, find: string): number {
  return find ? text.split(find).length - 1 : 0;
}

// The one remaining fallback for an audited claim that cannot be linked: cut the claim's exact quote
// rather than leave an uncited assertion or fail the run. Only applied when the quote is uniquely
// identifiable (so the cut cannot land on the wrong occurrence) and when removing it would not take
// its section below the same floor the review step enforces; otherwise the claim is left in place and
// reported as unmet — cutting must never trade one guard (source honesty) for another (structure).
function cutUncitedClaim(markdown: string, quote: string): { markdown: string; applied: boolean } {
  if (!quote || occurrences(markdown, quote) !== 1) return { markdown, applied: false };
  const at = markdown.indexOf(quote);
  const section = sectionWordCounts(markdown).findLast((entry) => entry.start <= at);
  if (section && section.words - proseWordCount(quote) < MIN_SECTION_WORDS_AFTER_CUTS) return { markdown, applied: false };
  const cut = `${markdown.slice(0, at)}${markdown.slice(at + quote.length)}`
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n");
  return { markdown: cut, applied: true };
}

// Defense-in-depth guard belonging at the contract boundary, not a normal-case repair: every external
// URL linked in the shipped body is supposed to already have a matching "## Sources" entry, courtesy
// of `appendSources`'s union. A mismatch here (for example a body link's raw text differing from the
// normalized form `appendSources` wrote into Sources) cannot be fixed by inventing a Sources entry, so
// the mismatched link is cut back to plain text instead, and the miss is recorded.
function ensureBodyLinksAppearInSources(markdown: string, siteOrigin: string): { markdown: string; unmet: UnmetContractRequirement[] } {
  const body = withoutGeneratedSection(markdown, "Sources");
  const bodyExternalUrls = [
    ...new Set(
      linkRanges(body)
        .map(({ url }) => url)
        .filter((url) => {
          try {
            return new URL(url).origin !== siteOrigin;
          } catch {
            return false;
          }
        }),
    ),
  ];
  const sourcesLines = markdown.split("\n");
  const sourcesStart = sourcesLines.findIndex((line) => line.trim().toLowerCase() === "## sources");
  const sourcesUrls = new Set(
    sourcesStart < 0 ? [] : [...sourcesLines.slice(sourcesStart).join("\n").matchAll(MARKDOWN_LINK)].map((match) => match[2]!),
  );
  const missing = bodyExternalUrls.filter((url) => !sourcesUrls.has(url));
  if (missing.length === 0) return { markdown, unmet: [] };
  let fixed = markdown;
  for (const url of missing) {
    fixed = fixed.replace(new RegExp(`\\[([^\\]]+)]\\(${escapeRegExp(url)}\\)`, "g"), "$1");
  }
  return {
    markdown: fixed,
    unmet: [{ requirement: "body_link_in_sources", detail: `Cut ${missing.length} body link${missing.length === 1 ? "" : "s"} with no matching Sources entry: ${missing.join(", ")}` }],
  };
}

// Final defensive read of the finished document. `appendSources` and `addTableOfContents` are the
// sole owners of these invariants and already guarantee them on every non-degenerate path, so under
// normal operation none of the checks below should ever add anything new — but a future change to
// either function, or to whatever runs between them, should not be able to silently regress this
// contract without at least being recorded.
function checkArticleContract(markdown: string, websiteUrl: string): { markdown: string; unmet: UnmetContractRequirement[] } {
  const siteOrigin = new URL(websiteUrl).origin;
  const unmet: UnmetContractRequirement[] = [];
  if (!/^## Table of Contents$/m.test(markdown)) {
    unmet.push({ requirement: "table_of_contents", detail: "The final article has no table of contents." });
  }
  const links = [...markdown.matchAll(MARKDOWN_LINK)].map((match) => match[2]!);
  const hasExternalLink = links.some((url) => {
    try {
      return new URL(url).origin !== siteOrigin;
    } catch {
      return false;
    }
  });
  if (!/^## Sources$/m.test(markdown) || !hasExternalLink) {
    unmet.push({ requirement: "verified_external_source", detail: "The final article has no verified external source in Sources." });
  }
  const hasSiteLink = links.some((url) => {
    try {
      return new URL(url).origin === siteOrigin;
    } catch {
      return false;
    }
  });
  if (!hasSiteLink) {
    unmet.push({ requirement: "site_link", detail: "The final article has no link to the website it was written for." });
  }
  const linked = ensureBodyLinksAppearInSources(markdown, siteOrigin);
  return { markdown: linked.markdown, unmet: [...unmet, ...linked.unmet] };
}

function dedupeUnmet(unmet: UnmetContractRequirement[]): UnmetContractRequirement[] {
  const seen = new Set<UnmetContractRequirementKind>();
  return unmet.filter((entry) => {
    if (seen.has(entry.requirement)) return false;
    seen.add(entry.requirement);
    return true;
  });
}

// Deterministic remediation, never abort-on-violation: a drafted, peer-reviewed article already
// exists by the time this runs, and nothing at this stage may refuse to return one. Every requirement
// below is enforced in order (fix -> cut -> omit -> record unmet); anything that cannot be satisfied
// without fabricating a source, a URL, a citation, or prose is instead collected into `unmet` for the
// caller to log, never thrown.
export function enforceArticleContract(input: {
  markdown: string;
  websiteUrl: string;
  brief: ResearchBrief;
  factCheck: FactCheckReport;
  verifiedSources: VerifiedArticleSource[];
}): { markdown: string; unmet: UnmetContractRequirement[] } {
  const unmet: UnmetContractRequirement[] = [];
  const rejectedUrls = new Set(input.factCheck.citations.filter(({ verdict }) => verdict !== "valid").map(({ url }) => url));
  let markdown = stripRejectedLinks(input.markdown, rejectedUrls);
  const reachable = new Set(input.verifiedSources.map(({ url }) => url));
  for (const claim of input.factCheck.claims) {
    const source = claim.sourceUrls.find((url) => reachable.has(url));
    if (claim.verdict === "true" && source) markdown = linkUniqueQuote(markdown, claim.quote, source);
  }
  markdown = linkBareUrls(markdown, sourceLabels(input.brief, input.verifiedSources), rejectedUrls);
  markdown = linkFirstBrandMention(markdown, input.websiteUrl, input.brief);

  const sourced = appendSources(markdown, input.verifiedSources, input.websiteUrl, input.brief);
  markdown = sourced.markdown;
  unmet.push(...sourced.unmet);

  const toc = addTableOfContents(markdown);
  markdown = toc.markdown;
  unmet.push(...toc.unmet);

  for (const claim of input.factCheck.claims) {
    if (claim.verdict === "true" && claim.sourceUrls.some((url) => reachable.has(url)) && markdown.includes(claim.quote) && !quoteIsLinked(markdown, claim.quote)) {
      const cut = cutUncitedClaim(markdown, claim.quote);
      markdown = cut.markdown;
      if (!cut.applied) {
        unmet.push({
          requirement: "audited_claim_citation",
          detail: `An audited factual claim could not be linked and could not be safely cut without emptying its section, so it was left uncited: "${claim.quote.slice(0, 160)}"`,
        });
      }
    }
  }

  const checked = checkArticleContract(markdown, input.websiteUrl);
  markdown = checked.markdown;
  unmet.push(...checked.unmet);

  return { markdown: markdown.trim(), unmet: dedupeUnmet(unmet) };
}
