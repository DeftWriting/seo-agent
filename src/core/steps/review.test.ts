import assert from "node:assert/strict";
import test from "node:test";
import type { FinalEditOutput } from "../../types.js";
import { applyBoundedReview, extractMarkdownUrls, isPunctuationOnlyChange } from "./review.js";

test("isPunctuationOnlyChange accepts only an identical word sequence", () => {
  assert.equal(isPunctuationOnlyChange("he said hello", 'he said "hello."'), true);
  assert.equal(isPunctuationOnlyChange("Widgets are useful.", "widgets are useful"), true);
  assert.equal(isPunctuationOnlyChange("a short claim", "a short and expanded claim"), false);
  assert.equal(isPunctuationOnlyChange("swap these words", "these swap words"), false);
});

function output(partial: Partial<FinalEditOutput>): FinalEditOutput {
  return { edits: [], cutSentences: [], moves: [], issues: [], ...partial };
}

test("applyBoundedReview rejects a find that does not match exactly once", () => {
  const result = applyBoundedReview("same same", output({ edits: [{ find: "same", replace: "different", type: "clarity", reason: "" }] }));
  assert.equal(result.applied.length, 0);
  assert.equal(result.dropped[0]?.guard, "find_not_unique");
});

test("applyBoundedReview rejects a replacement that adds more than two non-simple new words", () => {
  const markdown = "The result is accurate.";
  const result = applyBoundedReview(markdown, output({
    edits: [{ find: "The result is accurate.", replace: "The result is a radically improved and expanded finding.", type: "clarity", reason: "" }],
  }));
  assert.equal(result.applied.length, 0);
  assert.equal(result.dropped[0]?.guard, "too_many_new_words");
});

test("applyBoundedReview exempts a punctuation-only change from the new-word budget", () => {
  // Splitting a run-on by turning existing punctuation into a sentence break and capitalizing the next
  // word: same words, same order, only punctuation and capitalization differ.
  const markdown = "This is a run-on sentence, it should be two sentences.";
  const result = applyBoundedReview(markdown, output({
    edits: [{
      find: "This is a run-on sentence, it should be two sentences.",
      replace: "This is a run-on sentence. It should be two sentences.",
      type: "grammar",
      reason: "split run-on",
    }],
  }));
  assert.equal(result.applied.length, 1);
  assert.match(result.markdown, /run-on sentence\. It should/);
});

test("applyBoundedReview accepts a citation insertion whose URL is verified, and rejects one that is not", () => {
  const markdown = "## Section\n\nNCIS reported the figure in its annual survey.";
  const allowed = applyBoundedReview(markdown, output({
    edits: [{ find: "NCIS reported", replace: "[NCIS](https://example.com/report) reported", type: "citation", reason: "add citation" }],
  }), { allowedNewUrls: new Set(["https://example.com/report"]) });
  assert.equal(allowed.applied.length, 1);
  assert.match(allowed.markdown, /\[NCIS]\(https:\/\/example\.com\/report\)/);

  const rejected = applyBoundedReview(markdown, output({
    edits: [{ find: "NCIS reported", replace: "[NCIS](https://example.com/unverified) reported", type: "citation", reason: "add citation" }],
  }), { allowedNewUrls: new Set() });
  assert.equal(rejected.applied.length, 0);
  assert.equal(rejected.dropped[0]?.guard, "unverified_new_url");
});

test("applyBoundedReview forbids a heading-level change but allows a same-level shortening", () => {
  const markdown = "## Widget Basics\n\nBody text about widgets.";
  const demoted = applyBoundedReview(markdown, output({
    edits: [{ find: "## Widget Basics", replace: "### Widget Basics", type: "clarity", reason: "" }],
  }));
  assert.equal(demoted.applied.length, 0);
  assert.equal(demoted.dropped[0]?.guard, "heading_edit_forbidden");

  const shortened = applyBoundedReview("## Widget Basics And Their Everyday Uses\n\nBody text.", output({
    edits: [{ find: "## Widget Basics And Their Everyday Uses", replace: "## Widget Basics", type: "clarity", reason: "" }],
  }));
  assert.equal(shortened.applied.length, 1);
});

test("applyBoundedReview refuses a cut that would leave its section below the floor, but allows one with headroom", () => {
  // Filler ends with a period so `isFullSentenceMatch` sees the target sentence preceded by a complete
  // sentence (its own guard requires the character before it to be sentence-ending punctuation).
  const filler = `${Array.from({ length: 90 }, () => "word").join(" ")}.`;
  const sentence = "This extra padding sentence keeps the section long enough to begin with.";
  const thin = `## Only Section\n\n${filler} ${sentence} Short filler.`;
  const refused = applyBoundedReview(thin, output({ cutSentences: [sentence] }));
  assert.equal(refused.cutsApplied.length, 0);
  assert.equal(refused.droppedCuts[0]?.guard, "would_empty_section");

  const longFiller = `${Array.from({ length: 260 }, () => "word").join(" ")}.`;
  const roomy = `## Only Section\n\n${longFiller} ${sentence} Short filler.`;
  const allowed = applyBoundedReview(roomy, output({ cutSentences: [sentence] }));
  assert.equal(allowed.cutsApplied.length, 1);
  assert.doesNotMatch(allowed.markdown, /keeps the section long enough/);
});

test("applyBoundedReview applies a unique whole-paragraph move and drops an ambiguous one", () => {
  const markdown = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
  const moved = applyBoundedReview(markdown, output({ moves: [{ paragraph: "First paragraph.", afterParagraph: "Third paragraph.", reason: "flow" }] }));
  assert.equal(moved.movesApplied.length, 1);
  assert.ok(moved.markdown.indexOf("Third paragraph.") < moved.markdown.indexOf("First paragraph."));

  const duplicate = "# Title\n\nRepeat me.\n\nRepeat me.\n\nOther paragraph.";
  const ambiguous = applyBoundedReview(duplicate, output({ moves: [{ paragraph: "Repeat me.", afterParagraph: "Other paragraph.", reason: "flow" }] }));
  assert.equal(ambiguous.movesApplied.length, 0);
  assert.equal(ambiguous.droppedMoves[0]?.guard, "paragraph_not_unique");

  const headingMove = applyBoundedReview(markdown, output({ moves: [{ paragraph: "# Title", afterParagraph: "Second paragraph.", reason: "flow" }] }));
  assert.equal(headingMove.movesApplied.length, 0);
  assert.equal(headingMove.droppedMoves[0]?.guard, "heading_move_forbidden");
});

test("extractMarkdownUrls dedupes and strips trailing punctuation", () => {
  const markdown = "See https://example.com/a, and also https://example.com/a. Then https://example.com/b!";
  assert.deepEqual(extractMarkdownUrls(markdown), ["https://example.com/a", "https://example.com/b"]);
});
