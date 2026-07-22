#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import pc from "picocolors";
import { runSeoAgent } from "./core/run.js";
import { TerminalReporter } from "./reporter.js";
import { serveSeoAgent } from "./serve.js";

const HELP = `Deft SEO Agent

Usage:
  seo-agent --url <website> --topic <topic> [options]
  seo-agent serve [--port <n>]

Options:
  --url <url>              Public website to research
  --topic <text>           Target topic or keyword
  --out <path>             Markdown output path
  --max-pages <n>          Maximum site pages to inspect (default: 12)
  --concurrency <n>        Parallel Deft drafts and line-edit calls (default: 4)
  --thinking <level>       faster or smarter (default: faster)
  --skip-review            Skip the adversarial fact-checker/line-editor/final-edit stage
                           (cheaper and faster; still lints and repairs the article, and still
                           adds a Sources/Table of Contents, but ships with no verified citations)
  --line-edit-max-calls <n>  Cap the line editor's per-paragraph fan-out (default: 8)
  --json                   Emit NDJSON progress to stdout
  --port <n>               Local UI port (default: 4173)
  --help                   Show help
  --version                Show version

Environment overrides: SEO_AGENT_SKIP_REVIEW=1, SEO_AGENT_LINE_EDIT_MAX_CALLS=<n>. See README.md
for the full list of environment variables, default models, and what a typical run costs.
`;

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function outputFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${slug || "deft-seo-article"}.md`;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      url: { type: "string" },
      topic: { type: "string" },
      out: { type: "string" },
      "max-pages": { type: "string" },
      concurrency: { type: "string" },
      thinking: { type: "string" },
      "skip-review": { type: "boolean", default: false },
      "line-edit-max-calls": { type: "string" },
      json: { type: "boolean", default: false },
      port: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write("0.1.0\n");
    return;
  }

  if (positionals[0] === "serve") {
    const port = positiveInteger(values.port, "--port");
    await serveSeoAgent(port === undefined ? {} : { port });
    return;
  }
  if (positionals.length > 0) throw new Error(`Unknown command: ${positionals.join(" ")}`);
  if (!values.url || !values.topic) throw new Error("--url and --topic are required. Run with --help for usage.");
  if (values.thinking !== undefined && values.thinking !== "smarter" && values.thinking !== "faster") {
    throw new Error("--thinking must be smarter or faster.");
  }

  const missing = ["OPENROUTER_API_KEY", "DEFT_API_KEY"].filter((name) => !process.env[name]);
  if (missing.length > 0) throw new Error(`Missing environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);

  const reporter = new TerminalReporter({ json: values.json });
  const result = await runSeoAgent({
    url: values.url,
    topic: values.topic,
    openRouterApiKey: process.env.OPENROUTER_API_KEY,
    deftApiKey: process.env.DEFT_API_KEY,
    deftApiUrl: process.env.DEFT_API_BASE_URL,
    maxPages: positiveInteger(values["max-pages"], "--max-pages"),
    sectionConcurrency: positiveInteger(values.concurrency, "--concurrency"),
    thinkingLevel: values.thinking,
    skipReview: values["skip-review"],
    lineEditMaxCalls: positiveInteger(values["line-edit-max-calls"], "--line-edit-max-calls"),
  }, (event) => reporter.report(event));

  const outputPath = resolve(values.out ?? outputFilename(result.plan.title));
  const parent = dirname(outputPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(outputPath, `${result.markdown.trim()}\n`, "utf8");
  if (!values.json) process.stderr.write(`${pc.green("Saved")} ${outputPath}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${pc.red("Error:")} ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
