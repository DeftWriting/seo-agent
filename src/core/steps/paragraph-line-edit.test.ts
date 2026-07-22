import assert from "node:assert/strict";
import test from "node:test";
import type { CitationEvidence, LineEditReport } from "../../types.js";
import {
  chunkParagraphsForLineEdit,
  mergeLineEditReports,
  selectRelevantCitations,
  splitArticleBlocks,
} from "./paragraph-line-edit.js";

test("splitArticleBlocks labels which blocks are Markdown headings", () => {
  const blocks = splitArticleBlocks("# Title\n\n## Section\n\nFirst paragraph.\n\nSecond paragraph.");
  assert.deepEqual(
    blocks.map((block) => block.isHeading),
    [true, true, false, false],
  );
});

test("chunkParagraphsForLineEdit gives every paragraph its own call under the cap", () => {
  const paragraphs = ["One.", "Two.", "Three."];
  const chunks = chunkParagraphsForLineEdit(paragraphs, 8);
  assert.deepEqual(chunks, [["One."], ["Two."], ["Three."]]);
});

test("chunkParagraphsForLineEdit groups consecutive paragraphs once the article exceeds the call cap", () => {
  const paragraphs = Array.from({ length: 10 }, (_, index) => `Paragraph ${index + 1}.`);
  const chunks = chunkParagraphsForLineEdit(paragraphs, 4);
  assert.equal(chunks.length, 4);
  // Every original paragraph appears exactly once, in order, across the grouped chunks.
  assert.deepEqual(chunks.flat(), paragraphs);
});

test("chunkParagraphsForLineEdit returns nothing for an empty article", () => {
  assert.deepEqual(chunkParagraphsForLineEdit([], 8), []);
});

test("selectRelevantCitations only returns citations actually cited in the given passage", () => {
  const citations: CitationEvidence[] = [
    { url: "https://example.com/a", finalUrl: null, status: 200, reachable: true, excerpt: "", error: null },
    { url: "https://example.com/b", finalUrl: null, status: 200, reachable: true, excerpt: "", error: null },
  ];
  const result = selectRelevantCitations("See https://example.com/a for details.", citations);
  assert.deepEqual(result.map((citation) => citation.url), ["https://example.com/a"]);
});

test("mergeLineEditReports drops an issue whose quote falls outside its own call's scope", () => {
  const report: LineEditReport = {
    summary: "",
    issues: [
      { severity: "high", category: "sense", quote: "inside this passage", problem: "p", suggestedFix: "f" },
      { severity: "high", category: "sense", quote: "text from a different call's passage", problem: "p", suggestedFix: "f" },
    ],
  };
  const merged = mergeLineEditReports([{ scope: "inside this passage is what I own", report }]);
  assert.equal(merged.issues.length, 1);
  assert.equal(merged.issues[0]?.quote, "inside this passage");
});

test("mergeLineEditReports deduplicates the same issue reported by more than one call", () => {
  const report: LineEditReport = {
    summary: "",
    issues: [{ severity: "medium", category: "grammar", quote: "a run-on sentence", problem: "Run-on.", suggestedFix: "Split it." }],
  };
  const merged = mergeLineEditReports([
    { scope: "a run-on sentence appears here", report },
    { scope: "a run-on sentence appears here", report },
  ]);
  assert.equal(merged.issues.length, 1);
  assert.match(merged.summary, /1 issue/);
});

test("mergeLineEditReports summarizes a clean run with no issues", () => {
  const clean: LineEditReport = { summary: "", issues: [] };
  const merged = mergeLineEditReports([{ scope: "paragraph one", report: clean }, { scope: "paragraph two", report: clean }]);
  assert.equal(merged.issues.length, 0);
  assert.match(merged.summary, /2 passages individually and found no issues/);
});
