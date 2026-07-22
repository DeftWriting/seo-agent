import assert from "node:assert/strict";
import test from "node:test";
import type { ArticlePlan, DraftedSection, ReviewProposal } from "../../types.js";
import { isCollapsedSection, parseDraftedSection } from "./draft.js";
import { parsePlan, renderParagraphOutline } from "./plan.js";
import { addedWordCount, applyReviewProposal, withSourcesSection } from "./review.js";
import { applyStructuralOperations, withoutTrailingFragment } from "./structural.js";

test("renderParagraphOutline renders structured paragraphs into the writer-facing bullet format", () => {
  const outline = renderParagraphOutline([
    { job: "Define the term", details: ["Use the supplied definition", "Note the audience"] },
    { job: "Explain the implication", details: ["Tie it to the audience"] },
  ]);
  assert.equal(
    outline,
    "- Paragraph 1: Define the term\n - Use the supplied definition\n - Note the audience\n\n- Paragraph 2: Explain the implication\n - Tie it to the audience",
  );
});

test("parsePlan requires 4-6 structured paragraphs per section, each with at least two details", () => {
  const approved = { claim: "A supported claim", source: "Primary source", url: "https://example.com/source" };
  const paragraph = (detailCount: number) => ({
    job: "Explain the point",
    details: Array.from({ length: detailCount }, (_, index) => `Detail ${index + 1}`),
  });
  const section = (paragraphCount: number, detailCount = 2) => ({
    heading: "Section",
    summary: "Explain the supported point",
    paragraphs: Array.from({ length: paragraphCount }, () => paragraph(detailCount)),
    facts: [approved],
  });
  const base = {
    title: "Article title",
    metaDescription: "Description",
    style: "Direct",
    summary: "Summary",
    purpose: "Purpose",
    sections: [1, 2, 3, 4].map(() => section(4)),
  };

  const plan = parsePlan(base, [approved]);
  assert.equal(plan.sections[0]?.paragraphs.length, 4);
  assert.match(plan.sections[0]?.outline ?? "", /^- Paragraph 1: Explain the point/);

  // A single block (the original defect: the writer generates roughly one paragraph per block, so one
  // block silently produced a stub section) is rejected, as is a block with only one detail.
  assert.throws(
    () => parsePlan({ ...base, sections: [section(1), ...base.sections.slice(1)] }, [approved]),
    /must plan 4-6 paragraphs/,
  );
  assert.throws(
    () => parsePlan({ ...base, sections: [section(4, 1), ...base.sections.slice(1)] }, [approved]),
    /must plan 4-6 paragraphs/,
  );
});

test("planner can assign only facts from the approved research ledger", () => {
  const approved = { claim: "A supported claim", source: "Primary source", url: "https://example.com/source" };
  const paragraphs = Array.from({ length: 4 }, () => ({
    job: "Explain the point",
    details: ["Use the approved evidence", "Stay within the evidence"],
  }));
  const section = (facts: (typeof approved)[]) => ({ heading: "Section", summary: "Explain the supported point", paragraphs, facts });
  const base = {
    title: "Article title",
    metaDescription: "Description",
    style: "Direct",
    summary: "Summary",
    purpose: "Purpose",
    sections: [1, 2, 3, 4].map(() => section([approved])),
  };
  assert.equal(parsePlan(base, [approved]).sections[0]?.facts.length, 1);
  assert.throws(
    () =>
      parsePlan(
        { ...base, sections: [section([{ ...approved, claim: "Invented claim" }]), ...base.sections.slice(1)] },
        [approved],
      ),
    /not in the research ledger/,
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

test("review guards accept a citation edit that only wraps existing words in a Markdown link", () => {
  const proposal: ReviewProposal = {
    edits: [{ find: "NCIS (https://example.com/report)", replace: "[NCIS](https://example.com/report)", type: "citation", reason: "add citation" }],
    cutSentences: [],
    issues: [],
  };
  const result = applyReviewProposal("NCIS (https://example.com/report) reported the figure.", proposal);
  assert.match(result.markdown, /\[NCIS\]\(https:\/\/example\.com\/report\)/);
  assert.equal(result.report.rejectedChanges.length, 0);
});

test("review guards refuse a sentence cut that would leave its section almost empty", () => {
  const sentence = "This extra padding sentence keeps the section long enough to begin with.";
  const markdown = `## Only Section\n\n${sentence} Short filler.`;
  const result = applyReviewProposal(markdown, { edits: [], cutSentences: [sentence], issues: [] });
  assert.match(result.markdown, /keeps the section long enough/);
  assert.equal(result.report.rejectedChanges[0]?.reason, "Cutting this sentence would leave its section with almost no body text.");
});

test("sentence cuts reject arbitrary substrings that could change meaning", () => {
  const result = applyReviewProposal("The result is not accurate. Keep this sentence.", {
    edits: [],
    cutSentences: ["not ", "Keep this sentence."],
    issues: [],
  });
  assert.match(result.markdown, /not accurate/);
  assert.doesNotMatch(result.markdown, /Keep this sentence/);
  assert.equal(result.report.appliedCuts.length, 1);
  assert.equal(result.report.rejectedChanges[0]?.reason, "Cut text was not a complete sentence.");
});

test("withSourcesSection lists every linked URL with a research-derived label, once", () => {
  const research = {
    site: { product: "", audience: "", positioning: "", voice: "", existingPages: [] },
    serp: { competitors: [], gaps: [], questions: [] },
    facts: [{ claim: "A stat", source: "Example Org", url: "https://example.com/report" }],
  };
  const markdown = "## Section\n\nAs [Example Org](https://example.com/report) found, this matters.";
  const withSources = withSourcesSection(markdown, research);
  assert.match(withSources, /## Sources/);
  assert.match(withSources, /- \[Example Org\]\(https:\/\/example\.com\/report\)/);
  // Idempotent: running it again over an article that already has a Sources section is a no-op.
  assert.equal(withSourcesSection(withSources, research), withSources);
});

test("withSourcesSection is a no-op when nothing in the body is linked", () => {
  const research = { site: { product: "", audience: "", positioning: "", voice: "", existingPages: [] }, serp: { competitors: [], gaps: [], questions: [] }, facts: [] };
  const markdown = "## Section\n\nNo links here.";
  assert.equal(withSourcesSection(markdown, research), markdown);
});

test("Deft owns the final article and section headings", () => {
  assert.deepEqual(
    parseDraftedSection("# Deft title\n\n## Deft section\n\nWritten body.", true),
    { articleTitle: "Deft title", heading: "Deft section", body: "Written body." },
  );
  assert.deepEqual(parseDraftedSection("## Another section\n\nMore body.", false), {
    heading: "Another section",
    body: "More body.",
  });
  assert.throws(() => parseDraftedSection("Planner heading\n\nBody.", false), /required section heading/);
});

test("isCollapsedSection catches a stub well under the requested length or an echoed heading", () => {
  const section = { heading: "A Guide to Widgets", summary: "Explain what widgets are for." };
  assert.equal(isCollapsedSection("A Guide to Widgets", section), true);
  assert.equal(isCollapsedSection("Explain what widgets are for.", section), true);
  assert.equal(isCollapsedSection("Too short.", section), true);
  assert.equal(isCollapsedSection(Array.from({ length: 200 }, () => "word").join(" "), section), false);
});

test("withoutTrailingFragment trims an incomplete final sentence but leaves complete prose alone", () => {
  assert.equal(
    withoutTrailingFragment("First sentence is complete. Second one trails off without"),
    "First sentence is complete.",
  );
  assert.equal(withoutTrailingFragment("No terminal punctuation at all"), "No terminal punctuation at all");
  assert.equal(withoutTrailingFragment("- a bullet point with no ending"), "- a bullet point with no ending");
});

function testPlan(sections: ArticlePlan["sections"]): ArticlePlan {
  return { title: "A useful article", metaDescription: "Description", style: "Direct", summary: "Summary", purpose: "Purpose", sections };
}

test("structural guard restores least-aggressive cuts once the budget is exceeded", () => {
  const plan = testPlan([
    { id: "S1", heading: "First", summary: "", paragraphs: [], outline: "", facts: [] },
    { id: "S2", heading: "Second", summary: "", paragraphs: [], outline: "", facts: [] },
  ]);
  const sections: DraftedSection[] = [
    { ...plan.sections[0]!, text: ["One.", "Two.", "Three.", "Four."].join("\n\n") },
    { ...plan.sections[1]!, text: ["Five.", "Six.", "Seven.", "Eight."].join("\n\n") },
  ];
  const result = applyStructuralOperations(plan, sections, {
    sectionOrder: ["S1", "S2"],
    order: ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"],
    cuts: ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"],
    sentenceCuts: [],
  });
  // floor(8 * 0.35) === 2: cutting all 8 paragraphs is restored down to at most that many.
  assert.ok(result.operations.cuts.length <= 2);
  assert.ok(result.rejectedOperations.some((message) => message.includes("Restored")));
});

test("structural guard never leaves a planned section with zero paragraphs", () => {
  const plan = testPlan([
    { id: "S1", heading: "First", summary: "", paragraphs: [], outline: "", facts: [] },
    { id: "S2", heading: "Second", summary: "", paragraphs: [], outline: "", facts: [] },
  ]);
  const sections: DraftedSection[] = [
    { ...plan.sections[0]!, text: "Alpha paragraph." },
    {
      ...plan.sections[1]!,
      text: ["Gamma.", "Delta.", "Epsilon.", "Zeta.", "Eta.", "Theta."].join("\n\n"),
    },
  ];
  // Cutting S1's only paragraph is well within the overall budget, but would empty S1 outright.
  const result = applyStructuralOperations(plan, sections, {
    sectionOrder: ["S1", "S2"],
    order: ["P2", "P3", "P4", "P5", "P6", "P7"],
    cuts: ["P1"],
    sentenceCuts: [],
  });
  assert.match(result.markdown, /## First/);
  assert.match(result.markdown, /Alpha paragraph/);
});

test("structural guard skips a sentence cut that would empty its paragraph", () => {
  const plan = testPlan([{ id: "S1", heading: "First", summary: "", paragraphs: [], outline: "", facts: [] }]);
  const sections: DraftedSection[] = [{ ...plan.sections[0]!, text: "Only one sentence here." }];
  const result = applyStructuralOperations(plan, sections, {
    sectionOrder: ["S1"],
    order: ["P1"],
    cuts: [],
    sentenceCuts: ["Only one sentence here."],
  });
  assert.match(result.markdown, /Only one sentence here\./);
  assert.ok(result.rejectedOperations.some((message) => message.includes("emptied its paragraph")));
});
