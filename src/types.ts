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

export interface SiteResearch {
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

export interface PlannedSection {
  id: string;
  heading: string;
  summary: string;
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

export interface ReviewEdit {
  find: string;
  replace: string;
  type: string;
  reason: string;
}

export interface ReviewIssue {
  severity: "low" | "medium" | "high";
  kind: string;
  quote: string;
  note: string;
}

export interface ReviewProposal {
  edits: ReviewEdit[];
  cutSentences: string[];
  issues: ReviewIssue[];
}

export interface ReviewReport {
  proposal: ReviewProposal;
  appliedEdits: ReviewEdit[];
  appliedCuts: string[];
  rejectedChanges: Array<{ change: string; reason: string }>;
  deadLinks: string[];
  issues: ReviewIssue[];
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
  planModel?: string | undefined;
  editModel?: string | undefined;
  reviewModel?: string | undefined;
  maxPages?: number | undefined;
  sectionConcurrency?: number | undefined;
  thinkingLevel?: "faster" | "smarter" | undefined;
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
  | { type: "run_failed"; step?: StepId; error: string; at: string };

export type SeoAgentEventHandler = (
  event: SeoAgentEvent,
) => void | Promise<void>;
