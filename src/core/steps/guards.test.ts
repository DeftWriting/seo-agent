import assert from "node:assert/strict";
import test from "node:test";
import type { ArticlePlan, DraftedSection } from "../../types.js";
import { isCollapsedSection, parseDraftedSection } from "./draft.js";
import { parsePlan, renderParagraphOutline } from "./plan.js";
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
