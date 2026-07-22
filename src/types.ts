export const SEO_AGENT_STEPS = [
  "research",
  "plan",
  "draft",
  "structural",
  "review",
] as const;

export type StepId = (typeof SEO_AGENT_STEPS)[number];
export type StepStatus = "pending" | "running" | "complete" | "failed";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface SourceFact {
  claim: string;
  source: string;
  url: string;
}

export interface SitePage {
  url: string;
  title: string;
  text: string;
}

// A safely-fetched citation, used by both peer reviewers so a claim can be checked against what a
// cited page actually says, not just whether it resolves. Kept in this shared module (rather than
// duplicated per file, as production does to avoid a circular import between its review.ts and
// paragraph-line-edit.ts) since neither of this CLI's equivalent files needs to import the other's types.
export interface CitationEvidence {
  url: string;
  finalUrl: string | null;
  status: number | null;
  reachable: boolean;
  excerpt: string;
  error: string | null;
}

export interface SiteResearch {
  // Optional because it is inferred by a model from scraped text, not guaranteed to be present; article
  // linking (see article-contract.ts) falls back to the website hostname when this is absent.
  name?: string | undefined;
  product: string;
  audience: string;
  positioning: string;
  voice: string;
  existingPages: Array<{ title: string; url: string; relevance?: string | undefined }>;
}

export interface SerpResearch {
  competitors: Array<{ name: string; url: string; angle?: string | undefined }>;
  gaps: string[];
  questions: string[];
}

export interface ResearchBrief {
  site: SiteResearch;
  serp: SerpResearch;
  facts: SourceFact[];
}

export interface OutlineParagraph {
  job: string;
  details: string[];
}

export interface PlannedSection {
  id: string;
  heading: string;
  summary: string;
  // The source of truth the planner returns. `outline` below is rendered from this array rather than
  // asked for as free-form text: a model reliably returns a JSON array of {job, details} objects, but
  // unreliably reproduces exact multi-line "- Paragraph N: ...\n - detail" formatting inside a JSON
  // string field, and the chained writer generates roughly one paragraph per block, so a collapsed
  // block count silently produces a stub section. See core/steps/plan.ts.
  paragraphs: OutlineParagraph[];
  outline: string;
  facts: SourceFact[];
}

export interface ArticlePlan {
  title: string;
  metaDescription: string;
  style: string;
  summary: string;
  purpose: string;
  sections: PlannedSection[];
}

export interface DraftedSection extends PlannedSection {
  text: string;
}

export interface StructuralOperation {
  sectionOrder: string[];
  order: string[];
  cuts: string[];
  sentenceCuts: string[];
}

export interface StructuralResult {
  markdown: string;
  operations: StructuralOperation;
  rejectedOperations: string[];
}

// ---- Adversarial peer review: fact checker + per-paragraph line editor ----

export type AdversarialSeverity = "low" | "medium" | "high";

export interface AdversarialIssue {
  severity: AdversarialSeverity;
  quote: string;
  problem: string;
  suggestedFix: string;
}

export type CitationVerdict = "valid" | "invalid" | "misleading" | "unverified";

export interface FactCheckCitation {
  url: string;
  verdict: CitationVerdict;
  evidence: string;
  suggestedFix: string;
}

export type ClaimVerdict = "true" | "false" | "needs_modification" | "unverified";

export interface FactCheckClaim {
  quote: string;
  verdict: ClaimVerdict;
  evidence: string;
  sourceUrls: string[];
  suggestedFix: string;
}

export interface FactCheckReport {
  summary: string;
  citations: FactCheckCitation[];
  claims: FactCheckClaim[];
  issues: AdversarialIssue[];
}

export type LineEditCategory =
  | "grammar"
  | "spelling"
  | "word_choice"
  | "consistency"
  | "style"
  | "formatting"
  | "sense";

export interface LineEditIssue extends AdversarialIssue {
  category: LineEditCategory;
}

export interface LineEditReport {
  summary: string;
  issues: LineEditIssue[];
}

// ---- Final edit: deterministic operations resolving both peer reports ----

export interface FinalEditEdit {
  find: string;
  replace: string;
  type: string;
  reason: string;
}

export interface FinalEditMove {
  paragraph: string;
  afterParagraph: string | null;
  reason: string;
}

export interface FinalEditIssue {
  severity: AdversarialSeverity;
  kind: string;
  quote: string;
  note: string;
}

export interface FinalEditOutput {
  edits: FinalEditEdit[];
  cutSentences: string[];
  moves: FinalEditMove[];
  issues: FinalEditIssue[];
}

export interface BoundedReviewResult {
  markdown: string;
  applied: FinalEditEdit[];
  dropped: Array<FinalEditEdit & { guard: string }>;
  cutsApplied: string[];
  droppedCuts: Array<{ sentence: string; guard: string }>;
  movesApplied: FinalEditMove[];
  droppedMoves: Array<FinalEditMove & { guard: string }>;
}

// ---- Article contract: sourcing, citations, table of contents ----

export type VerifiedArticleSource = { label: string; url: string };

// Every requirement `enforceArticleContract` could not fully satisfy. Nothing at this stage may fail
// the run: a requirement that cannot be met without fabricating a source, a citation, or prose is
// recorded here instead, following the remediation ladder fix -> cut -> omit -> record unmet.
export type UnmetContractRequirementKind =
  | "verified_external_source"
  | "table_of_contents"
  | "title"
  | "audited_claim_citation"
  | "site_link"
  | "body_link_in_sources";

export interface UnmetContractRequirement {
  requirement: UnmetContractRequirementKind;
  detail: string;
}

// ---- Lint ----

export type ArticleLintRule =
  | "heading_restated_in_body"
  | "title_restated_in_body"
  | "duplicate_heading"
  | "bare_url_in_prose"
  | "repeated_sentence"
  | "outline_artifact"
  | "unterminated_paragraph"
  | "paragraph_opens_with_heading";

export interface ArticleLintFinding {
  rule: ArticleLintRule;
  quote: string;
  detail: string;
}

export interface ReviewReport {
  factChecker: FactCheckReport;
  lineEditor: LineEditReport;
  finalEdit: {
    issues: FinalEditIssue[];
    appliedEdits: FinalEditEdit[];
    droppedEdits: Array<FinalEditEdit & { guard: string }>;
    cutSentences: string[];
    droppedCuts: Array<{ sentence: string; guard: string }>;
    moves: FinalEditMove[];
    droppedMoves: Array<FinalEditMove & { guard: string }>;
  };
  lint: { rounds: number; passed: boolean; remaining: ArticleLintFinding[] };
  contract: { unmet: UnmetContractRequirement[] };
  skipped: boolean;
}

// ---- Cost and reliability accounting (see adapters/cost-meter.ts) ----
// The CLI inverts production's rule that cost must never reach the user: a hosted free tool must hide
// operating cost from anonymous visitors, but a CLI user pays their own API keys directly, so seeing
// what a run actually cost and where the time went is a feature they asked for, not telemetry to hide.

export interface LlmCallCost {
  step: StepId;
  label: string;
  model: string;
  costUsd: number | null;
  webSearchRequests: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LlmAttemptFailure {
  step: StepId;
  model: string;
  reason: string;
  ms: number;
  attempt: number;
}

export interface StepCostSummary {
  step: StepId;
  usd: number;
  deftUsd: number;
  calls: number;
  webSearchRequests: number;
  ms: number;
}

export interface CostSummary {
  totalUsd: number;
  openRouterUsd: number;
  deftUsd: number;
  openRouterCalls: number;
  unpricedCalls: number;
  webSearchRequests: number;
  failedAttempts: number;
  fallbacksUsed: number;
  elapsedMs: number;
  byStep: StepCostSummary[];
  byModel: Array<{ model: string; calls: number; usd: number }>;
  failures: LlmAttemptFailure[];
}

export interface SeoAgentResult {
  url: string;
  topic: string;
  research: ResearchBrief;
  plan: ArticlePlan;
  sections: DraftedSection[];
  structural: StructuralResult;
  review: ReviewReport;
  markdown: string;
  usage: TokenUsage;
  cost: CostSummary;
  startedAt: string;
  completedAt: string;
}

export interface SeoAgentRunOptions {
  url: string;
  topic: string;
  openRouterApiKey?: string | undefined;
  deftApiKey?: string | undefined;
  openRouterBaseUrl?: string | undefined;
  deftApiUrl?: string | undefined;
  researchModel?: string | undefined;
  researchFallbackModel?: string | undefined;
  planModel?: string | undefined;
  planFallbackModel?: string | undefined;
  editModel?: string | undefined;
  editFallbackModel?: string | undefined;
  reviewModel?: string | undefined;
  reviewFallbackModel?: string | undefined;
  maxPages?: number | undefined;
  sectionConcurrency?: number | undefined;
  thinkingLevel?: "faster" | "smarter" | undefined;
  // Cost/quality trade-off: peer review (fact checker + per-paragraph line editor + the final edit call
  // that resolves both) is the most expensive part of a run — roughly 90% of spend in production's own
  // measurements. Skipping it still runs deterministic lint/repair and the article contract, so a run
  // never ships with leaked scaffolding or an unverified "Sources" list; it just ships without an
  // adversarial check for factual and line-level defects, and with external links stripped to plain
  // text (see article-contract.ts) rather than shown as verified citations.
  skipReview?: boolean | undefined;
  // Caps the per-paragraph line-editor fan-out (see core/steps/paragraph-line-edit.ts). Longer articles
  // group consecutive paragraphs into one call instead of issuing more requests once this is reached.
  lineEditMaxCalls?: number | undefined;
  signal?: AbortSignal | undefined;
}

export type SeoAgentEvent =
  | { type: "run_started"; url: string; topic: string; at: string }
  | { type: "step_started"; step: StepId; message: string; at: string }
  | {
      type: "step_progress";
      step: StepId;
      message: string;
      completed?: number;
      total?: number;
      at: string;
    }
  | { type: "step_complete"; step: StepId; message: string; at: string }
  | { type: "warning"; step?: StepId; message: string; at: string }
  | { type: "run_complete"; result: SeoAgentResult; at: string }
  | { type: "run_failed"; step?: StepId; error: string; partialCost: CostSummary; at: string };

export type SeoAgentEventHandler = (
  event: SeoAgentEvent,
) => void | Promise<void>;
