import { crawlWebsite } from "../../adapters/fetcher.js";
import { completeJson } from "../../adapters/llm.js";
import type { ResearchBrief, SitePage, TokenUsage } from "../../types.js";
import {
  RESEARCH_SEARCH_SYSTEM_PROMPT,
  RESEARCH_SYNTHESIS_SYSTEM_PROMPT,
} from "../prompts.js";

export interface ResearchStepOptions {
  url: string;
  topic: string;
  apiKey: string;
  model: string;
  maxPages: number;
  baseUrl?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void | Promise<void>;
}

export interface ResearchStepResult {
  brief: ResearchBrief;
  pages: SitePage[];
  usage: TokenUsage;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Research response must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => stringValue(item)).filter(Boolean) : [];
}

function parseResearchBrief(value: unknown): ResearchBrief {
  const root = asRecord(value);
  const site = asRecord(root.site);
  const serp = asRecord(root.serp);
  const existingPages = Array.isArray(site.existingPages)
    ? site.existingPages.map(asRecord).map((page) => ({
        title: stringValue(page.title),
        url: stringValue(page.url),
        relevance: stringValue(page.relevance) || undefined,
      })).filter((page) => page.title && page.url)
    : [];
  const competitors = Array.isArray(serp.competitors)
    ? serp.competitors.map(asRecord).map((item) => ({
        name: stringValue(item.name),
        url: stringValue(item.url),
        angle: stringValue(item.angle) || undefined,
      })).filter((item) => item.name && item.url)
    : [];
  const facts = Array.isArray(root.facts)
    ? root.facts.map(asRecord).map((fact) => ({
        claim: stringValue(fact.claim),
        source: stringValue(fact.source),
        url: stringValue(fact.url),
      })).filter((fact) => fact.claim && fact.source && fact.url)
    : [];

  return {
    site: {
      product: stringValue(site.product, "Unknown product"),
      audience: stringValue(site.audience, "General audience"),
      positioning: stringValue(site.positioning, "Not established"),
      voice: stringValue(site.voice, "Clear and direct"),
      existingPages,
    },
    serp: {
      competitors,
      gaps: stringArray(serp.gaps),
      questions: stringArray(serp.questions),
    },
    facts,
  };
}

function addUsage(...items: TokenUsage[]): TokenUsage {
  return items.reduce(
    (sum, item) => ({
      promptTokens: sum.promptTokens + item.promptTokens,
      completionTokens: sum.completionTokens + item.completionTokens,
      totalTokens: sum.totalTokens + item.totalTokens,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
}

export async function researchStep(options: ResearchStepOptions): Promise<ResearchStepResult> {
  await options.onProgress?.(`Reading ${new URL(options.url).hostname}`);
  const pages = await crawlWebsite(options.url, options.maxPages, options.signal);
  await options.onProgress?.(`Read ${pages.length} public site page${pages.length === 1 ? "" : "s"}`);

  const siteDigest = pages
    .map((page) => `URL: ${page.url}\nTITLE: ${page.title}\nTEXT:\n${page.text}`)
    .join("\n\n---\n\n")
    .slice(0, 90_000);
  await options.onProgress?.("Searching the topic from two angles");
  const [landscape, questions] = await Promise.all([
    completeJson({
      apiKey: options.apiKey,
      model: options.model,
      baseUrl: options.baseUrl,
      signal: options.signal,
      plugins: [{ id: "web", engine: "exa", max_results: 10 }],
      messages: [
        { role: "system", content: RESEARCH_SEARCH_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Research the competitive search landscape for ${JSON.stringify(options.topic)}. Return {"competitors":[{"name":"","url":"","angle":""}],"facts":[{"claim":"","source":"","url":""}],"gaps":[]}.`,
        },
      ],
    }),
    completeJson({
      apiKey: options.apiKey,
      model: options.model,
      baseUrl: options.baseUrl,
      signal: options.signal,
      plugins: [{ id: "web", engine: "exa", max_results: 10 }],
      messages: [
        { role: "system", content: RESEARCH_SEARCH_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Research questions, primary sources, and citable evidence for ${JSON.stringify(options.topic)}. Return {"questions":[],"facts":[{"claim":"","source":"","url":""}],"contentOpportunities":[]}.`,
        },
      ],
    }),
  ]);

  await options.onProgress?.("Synthesizing the evidence into a research brief");
  const synthesis = await completeJson({
    apiKey: options.apiKey,
    model: options.model,
    baseUrl: options.baseUrl,
    signal: options.signal,
    temperature: 0,
    messages: [
      { role: "system", content: RESEARCH_SYNTHESIS_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Website: ${options.url}\nTopic: ${options.topic}\n\nSITE MATERIAL:\n${siteDigest}\n\nSEARCH LANDSCAPE:\n${landscape.raw}\n\nQUESTIONS AND EVIDENCE:\n${questions.raw}`,
      },
    ],
  });

  return {
    brief: parseResearchBrief(synthesis.value),
    pages,
    usage: addUsage(landscape.usage, questions.usage, synthesis.usage),
  };
}
