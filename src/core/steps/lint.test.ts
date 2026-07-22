import assert from "node:assert/strict";
import test from "node:test";
import { applyRepairEdits, isRepairableLintFinding, lintArticle } from "./lint.js";

test("lintArticle flags a section that opens by restating its own heading", () => {
  const markdown = "# Title\n\n## Widget Basics\n\nWidget Basics are the foundation of everything else here that matters a great deal.";
  const findings = lintArticle(markdown);
  assert.ok(findings.some((finding) => finding.rule === "heading_restated_in_body"));
});

test("lintArticle flags an article that opens by restating its own title", () => {
  const markdown = "# A Complete Guide\n\n## Section\n\nA Complete Guide covers everything a reader needs to know about this broad and useful topic in detail.";
  const findings = lintArticle(markdown);
  assert.ok(findings.some((finding) => finding.rule === "title_restated_in_body"));
});

test("lintArticle flags duplicate headings", () => {
  const markdown = "# Title\n\n## Same Heading\n\nSome body text here that is long enough to read as a real paragraph of prose.\n\n## Same Heading\n\nMore body text that also reads as a real paragraph of ordinary prose.";
  const findings = lintArticle(markdown);
  assert.ok(findings.some((finding) => finding.rule === "duplicate_heading"));
});

test("lintArticle flags a bare URL sitting in prose outside a Markdown link", () => {
  const markdown = "# Title\n\n## Section\n\nSee https://example.com/report for the full figures behind this claim and its context.";
  const findings = lintArticle(markdown);
  assert.ok(findings.some((finding) => finding.rule === "bare_url_in_prose"));
});

test("lintArticle does not flag a URL that is already inside a Markdown link", () => {
  const markdown = "# Title\n\n## Section\n\nSee [the report](https://example.com/report) for the full figures behind this claim.";
  const findings = lintArticle(markdown);
  assert.ok(!findings.some((finding) => finding.rule === "bare_url_in_prose"));
});

test("lintArticle flags a sentence repeated verbatim elsewhere in the article", () => {
  const sentence = "This exact sentence appears more than once in the finished article on purpose.";
  const markdown = `# Title\n\n## First\n\n${sentence} Some more filler text follows it here.\n\n## Second\n\nOther content leads in. ${sentence}`;
  const findings = lintArticle(markdown);
  assert.ok(findings.some((finding) => finding.rule === "repeated_sentence"));
});

test("lintArticle flags leaked outline scaffolding", () => {
  const markdown = "# Title\n\n## Section\n\n- Paragraph 1: Explain the basics of the topic clearly\n\nActual prose follows this leaked outline line in the body.";
  const findings = lintArticle(markdown);
  assert.ok(findings.some((finding) => finding.rule === "outline_artifact"));
});

test("lintArticle flags a paragraph that stops mid-sentence", () => {
  const markdown = "# Title\n\n## Section\n\nThis paragraph reads fine up until it just stops without";
  const findings = lintArticle(markdown);
  assert.ok(findings.some((finding) => finding.rule === "unterminated_paragraph"));
});

test("lintArticle flags a colon-terminated kicker glued onto a paragraph's real first sentence", () => {
  const markdown = "# Title\n\n## Section\n\nThe Modern Guide to Widgets: There is a growing community of builders who rely on well-made widgets every day.";
  const findings = lintArticle(markdown);
  const finding = findings.find((item) => item.rule === "paragraph_opens_with_heading");
  assert.ok(finding);
  // The fragment stops at the colon, so a verbatim deletion never eats into the real sentence.
  assert.equal(finding?.quote, "The Modern Guide to Widgets:");
});

test("lintArticle flags a long bare title-cased run with no colon", () => {
  const markdown = "# Title\n\n## Section\n\nThe Modern Independent Guide To Everyday Widgets There is a growing community of builders relying on them daily.";
  const findings = lintArticle(markdown);
  assert.ok(findings.some((finding) => finding.rule === "paragraph_opens_with_heading"));
});

test("lintArticle does not flag an ordinary institutional-subject sentence", () => {
  const markdown = "# Title\n\n## Section\n\nThe United Nations Security Council convened an emergency session to discuss the growing crisis in the region.";
  const findings = lintArticle(markdown);
  assert.ok(!findings.some((finding) => finding.rule === "paragraph_opens_with_heading"));
});

test("lintArticle exempts a paragraph that opens with a deliberate citation link", () => {
  const markdown = "# Title\n\n## Section\n\n[NCIS National Council](https://example.com) reported a large increase in membership across the country this year.";
  const findings = lintArticle(markdown);
  assert.ok(!findings.some((finding) => finding.rule === "paragraph_opens_with_heading"));
});

test("isRepairableLintFinding treats duplicate_heading as unrepairable but the rest as repairable", () => {
  assert.equal(isRepairableLintFinding({ rule: "duplicate_heading", quote: "", detail: "" }), false);
  assert.equal(isRepairableLintFinding({ rule: "paragraph_opens_with_heading", quote: "", detail: "" }), true);
  assert.equal(isRepairableLintFinding({ rule: "unterminated_paragraph", quote: "", detail: "" }), true);
});

test("applyRepairEdits drops an edit that introduces a URL not already in the article", () => {
  // Same words in the same order — addedWordCount is 0 because URLs are stripped before tokenizing
  // (see lint.ts's `words()`) — so only the dedicated new-URL guard can catch the new link here.
  const result = applyRepairEdits("A sentence with a link at all.", [
    { rule: "bare_url_in_prose", find: "A sentence with a link at all.", replace: "A sentence with [a link](https://example.com/new) at all." },
  ]);
  assert.equal(result.applied.length, 0);
  assert.match(result.dropped[0] ?? "", /introduces new url/);
});

test("lintArticle ignores a generated Sources or Table of Contents section", () => {
  const markdown = "# Title\n\n## Section\n\nOrdinary prose that is long enough to pass every other rule cleanly here.\n\n## Sources\n\n- [A Source](https://example.com)\n\n## Sources";
  // Two "## Sources" headings would normally trip duplicate_heading, but both are excluded outright.
  const findings = lintArticle(markdown);
  assert.ok(!findings.some((finding) => finding.rule === "duplicate_heading"));
});

test("applyRepairEdits applies a unique, vocabulary-only correction", () => {
  const result = applyRepairEdits("## Section\n\n## Section repeats the heading here in the body text.", [
    { rule: "heading_restated_in_body", find: "## Section repeats the heading here in the body text.", replace: "The body text repeats the heading here." },
  ]);
  assert.equal(result.applied.length, 1);
  assert.equal(result.dropped.length, 0);
});

test("applyRepairEdits drops an edit that introduces a word not already in the article", () => {
  const result = applyRepairEdits("Some plain sentence here.", [
    { rule: "unterminated_paragraph", find: "Some plain sentence here.", replace: "Some plain invented sentence here." },
  ]);
  assert.equal(result.applied.length, 0);
  assert.match(result.dropped[0] ?? "", /introduces new words/);
});

test("applyRepairEdits drops a find that is not unique in the article", () => {
  const result = applyRepairEdits("Repeat me. Repeat me.", [
    { rule: "repeated_sentence", find: "Repeat me.", replace: "Repeat." },
  ]);
  assert.equal(result.applied.length, 0);
  assert.match(result.dropped[0] ?? "", /find not unique/);
});

test("applyRepairEdits drops overlapping edits rather than double-applying them", () => {
  const result = applyRepairEdits("One two three four.", [
    { rule: "unterminated_paragraph", find: "One two three", replace: "One two" },
    { rule: "unterminated_paragraph", find: "two three four.", replace: "two four." },
  ]);
  assert.equal(result.applied.length, 1);
  assert.equal(result.dropped.length, 1);
});
