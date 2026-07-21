import assert from "node:assert/strict";
import test from "node:test";
import type { ArticlePlan, DraftedSection, ReviewProposal } from "../../types.js";
import { isValidParagraphOutline } from "./plan.js";
import { addedWordCount, applyReviewProposal } from "./review.js";
import { applyStructuralOperations } from "./structural.js";

test("planner outline validation enforces paragraph blocks and indented details", () => {
  assert.equal(
    isValidParagraphOutline(
      "- Paragraph 1: Define the term\n - Use the supplied definition\n\n- Paragraph 2: Explain the implication\n - Tie it to the audience",
    ),
    true,
  );
  assert.equal(
    isValidParagraphOutline(
      "- Paragraph 1: Define the term\n- missing indentation\n\n- Paragraph 2: Explain it\n - Detail",
    ),
    false,
  );
});

test("review guards reject non-unique and expansive rewrites", () => {
  const proposal: ReviewProposal = {
    edits: [
      { find: "same", replace: "better", type: "clarity", reason: "ambiguous" },
      {
        find: "A short claim.",
        replace: "A radically improved and thoroughly expanded marketing claim.",
        type: "clarity",
        reason: "too much prose",
      },
      { find: "One typoo.", replace: "One typo.", type: "grammar", reason: "typo" },
    ],
    cutSentences: ["Remove this sentence."],
    issues: [],
  };
  const result = applyReviewProposal(
    "same same\n\nA short claim. One typoo. Remove this sentence.",
    proposal,
  );
  assert.match(result.markdown, /One typo\./);
  assert.doesNotMatch(result.markdown, /Remove this sentence/);
  assert.equal(result.report.appliedEdits.length, 1);
  assert.equal(result.report.rejectedChanges.length, 2);
  assert.equal(addedWordCount("The accurate result", "The more accurate result"), 1);
});

test("structural guard reassembles by IDs and rejects excessive cuts", () => {
  const plan: ArticlePlan = {
    title: "A useful article",
    metaDescription: "Description",
    style: "Direct",
    summary: "Summary",
    purpose: "Purpose",
    sections: [
      { id: "S1", heading: "First", summary: "", outline: "", facts: [] },
      { id: "S2", heading: "Second", summary: "", outline: "", facts: [] },
    ],
  };
  const sections: DraftedSection[] = [
    { ...plan.sections[0]!, text: "Alpha paragraph.\n\nBeta paragraph." },
    { ...plan.sections[1]!, text: "Gamma paragraph.\n\nDelta paragraph." },
  ];
  const result = applyStructuralOperations(plan, sections, {
    sectionOrder: ["S2", "S1"],
    order: ["P4", "P3", "P2", "P1"],
    cuts: ["P1", "P2"],
    sentenceCuts: ["Gamma paragraph."],
  });
  assert.ok(result.markdown.indexOf("## Second") < result.markdown.indexOf("## First"));
  assert.match(result.markdown, /Alpha paragraph/);
  assert.match(result.markdown, /Beta paragraph/);
  assert.doesNotMatch(result.markdown, /Gamma paragraph/);
  assert.ok(result.rejectedOperations.some((message) => message.includes("40%")));
});
