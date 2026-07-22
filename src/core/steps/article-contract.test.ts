import assert from "node:assert/strict";
import test from "node:test";
import type { FactCheckReport, ResearchBrief } from "../../types.js";
import { enforceArticleContract, headingSlug } from "./article-contract.js";

const research: ResearchBrief = {
  site: {
    name: "Example Co",
    product: "widgets",
    audience: "buyers",
    positioning: "quality-first",
    voice: "direct",
    existingPages: [],
  },
  serp: { competitors: [], gaps: [], questions: [] },
  facts: [{ claim: "Widgets improved output by 40%", source: "Widget Research Institute", url: "https://research.example.com/study" }],
};

function factCheck(partial: Partial<FactCheckReport> = {}): FactCheckReport {
  return { summary: "", citations: [], claims: [], issues: [], ...partial };
}

test("enforceArticleContract links an audited true claim to its verified source", () => {
  const markdown = "# A Guide to Widgets\n\n## Section\n\nWidgets improved output by 40% according to internal testing.";
  const result = enforceArticleContract({
    markdown,
    websiteUrl: "https://example.com",
    brief: research,
    factCheck: factCheck({ claims: [{ quote: "Widgets improved output by 40%", verdict: "true", evidence: "", sourceUrls: ["https://research.example.com/study"], suggestedFix: "" }] }),
    verifiedSources: [{ label: "Widget Research Institute", url: "https://research.example.com/study" }],
  });
  assert.match(result.markdown, /\[Widgets improved output by 40%]\(https:\/\/research\.example\.com\/study\)/);
});

test("enforceArticleContract strips a rejected citation link back to plain text", () => {
  const markdown = "# A Guide to Widgets\n\n## Section\n\nSee [a bad source](https://bad.example.com/page) for details.";
  const result = enforceArticleContract({
    markdown,
    websiteUrl: "https://example.com",
    brief: research,
    factCheck: factCheck({ citations: [{ url: "https://bad.example.com/page", verdict: "invalid", evidence: "", suggestedFix: "" }] }),
    verifiedSources: [],
  });
  assert.doesNotMatch(result.markdown, /bad\.example\.com/);
  assert.match(result.markdown, /See a bad source for details\./);
});

test("enforceArticleContract links the first brand mention to the canonical site URL", () => {
  const markdown = "# A Guide to Widgets\n\n## Section\n\nExample Co makes reliable widgets for everyday use.";
  const result = enforceArticleContract({ markdown, websiteUrl: "https://example.com", brief: research, factCheck: factCheck(), verifiedSources: [] });
  assert.match(result.markdown, /\[Example Co]\(https:\/\/example\.com\)/);
});

test("enforceArticleContract appends a Sources section listing the site and every verified external source, and a linked Table of Contents after the H1", () => {
  const markdown = "# A Guide to Widgets\n\n## First Section\n\nSome body text about widgets and their many everyday uses in the home.\n\n## Second Section\n\nMore body text describing another aspect of widgets in daily life.";
  const result = enforceArticleContract({
    markdown,
    websiteUrl: "https://example.com",
    brief: research,
    factCheck: factCheck(),
    verifiedSources: [{ label: "Widget Research Institute", url: "https://research.example.com/study" }],
  });
  assert.match(result.markdown, /## Sources/);
  assert.match(result.markdown, /- \[Widget Research Institute]\(https:\/\/research\.example\.com\/study\)/);
  assert.match(result.markdown, /- \[Example Co website]\(https:\/\/example\.com\)/);
  const tocIndex = result.markdown.indexOf("## Table of Contents");
  const titleIndex = result.markdown.indexOf("# A Guide to Widgets");
  const firstSectionIndex = result.markdown.indexOf("## First Section");
  assert.ok(titleIndex < tocIndex && tocIndex < firstSectionIndex);
  assert.match(result.markdown, /- \[First Section]\(#first-section\)/);
});

test("enforceArticleContract strips external links and records unmet when no source is verified", () => {
  const markdown = "# A Guide to Widgets\n\n## Section\n\nSee [an unverified claim](https://unverified.example.com/page) here.";
  const result = enforceArticleContract({ markdown, websiteUrl: "https://example.com", brief: research, factCheck: factCheck(), verifiedSources: [] });
  assert.doesNotMatch(result.markdown, /unverified\.example\.com/);
  assert.ok(result.unmet.some((entry) => entry.requirement === "verified_external_source"));
});

test("enforceArticleContract leaves an uncitable audited claim in place and reports it unmet when the quote is not unique enough to link or safely cut", () => {
  const markdown =
    "# A Guide to Widgets\n\n## Section\n\nWidgets improved output by 40% in this case study. Widgets improved output by 40% in a separate case study too.";
  const result = enforceArticleContract({
    markdown,
    websiteUrl: "https://example.com",
    brief: research,
    // The quote is reachable (its source is in verifiedSources) but appears twice, so `linkUniqueQuote`
    // refuses to link it and `cutUncitedClaim` refuses to cut it — both require a single occurrence.
    factCheck: factCheck({ claims: [{ quote: "Widgets improved output by 40%", verdict: "true", evidence: "", sourceUrls: ["https://research.example.com/study"], suggestedFix: "" }] }),
    verifiedSources: [{ label: "Widget Research Institute", url: "https://research.example.com/study" }],
  });
  assert.match(result.markdown, /Widgets improved output by 40%/);
  assert.ok(result.unmet.some((entry) => entry.requirement === "audited_claim_citation"));
});

test("enforceArticleContract places the table of contents at the top and reports a missing title", () => {
  const markdown = "## Section\n\nBody text without any H1 title at the top of this short article.";
  const result = enforceArticleContract({ markdown, websiteUrl: "https://example.com", brief: research, factCheck: factCheck(), verifiedSources: [] });
  assert.ok(result.markdown.startsWith("## Table of Contents"));
  assert.ok(result.unmet.some((entry) => entry.requirement === "title"));
});

test("enforceArticleContract never reports the same unmet requirement kind twice", () => {
  const markdown = "## Section\n\nBody text with no title, no sources, and no site link at all in it.";
  const result = enforceArticleContract({ markdown, websiteUrl: "https://example.com", brief: research, factCheck: factCheck(), verifiedSources: [] });
  const kinds = result.unmet.map((entry) => entry.requirement);
  assert.equal(new Set(kinds).size, kinds.length);
});

test("headingSlug produces a stable, URL-safe anchor", () => {
  assert.equal(headingSlug("What Is a Widget?"), "what-is-a-widget");
  assert.equal(headingSlug(""), "section");
});
