# Deft SEO Agent

An open-source agent that researches a site and a topic, plans an SEO/GEO-friendly long-form article, drafts its sections in parallel with [Deft](https://deftwriting.com), then applies constrained structural and factual review.

The important boundary is simple: **Deft writes all article prose.** The research and editor models can gather evidence, plan, cut, reorder, or propose small exact-match fixes; they do not replace the draft with model-written prose.

## Quickstart

Requires Node.js 20 or newer and your own API keys:

- `OPENROUTER_API_KEY` for research, planning, and constrained review
- `DEFT_API_KEY` for section drafting through Deft's public API ([create or manage a key](https://deftwriting.com/developers))

```bash
git clone https://github.com/DeftWriting/seo-agent.git
cd seo-agent
npm install
export OPENROUTER_API_KEY="..."
export DEFT_API_KEY="deft_live_..."
npm run dev -- --url https://example.com --topic "A practical guide to the topic"
```

The finished Markdown file is written to the current directory by default. Use `--out article.md` to choose a path.

After `npm run build`, the same command is available as:

```bash
node dist/cli.js --url https://example.com --topic "Your topic" --out article.md
```

## Local web UI

The repository also includes a tiny framework-free local interface:

```bash
npm run serve
```

Open [http://localhost:4173](http://localhost:4173). The local Node process runs the workflow and streams progress to the page with server-sent events. Keys stay in the process environment and are never sent to or stored by the browser.

## Workflow

```mermaid
flowchart TD
  A[Research site and search results] --> B[Plan 4-7 sections, each 4-6 paragraph blocks]
  B --> C1[Draft section 1 with Deft]
  B --> C2[Draft section 2 with Deft]
  B --> C3[Draft remaining sections with Deft]
  C1 --> D[Structural edit: order and cuts]
  C2 --> D
  C3 --> D
  D --> E[Bounded line edit and fact review]
  E --> G[Deterministic lint, minimal repair, Sources list]
  G --> F[Markdown article]
```

The planner chooses four to seven sections, usually targeting roughly 500 words each. Each section is
planned as 4 to 6 structured paragraph blocks (a one-sentence job plus 2-3 concrete details), rendered
into the writer-facing outline text after the planner returns them, rather than asked from the model as
pre-formatted text — a model reliably returns structured JSON but not exact multi-line bullet
formatting, and the chained writer generates roughly one paragraph per block, so an under-specified
outline reliably produced stub sections. Draft requests are independent, self-contained full-document
prompts because the public Deft API performs its own outline preprocessing; a section that comes back
far short of its target length is redrafted once, and the longest attempt is kept.

Structural editing and review are both bounded so an aggressive editor can cut a lot without ever
emptying a planned section or a paragraph outright. After review, a small deterministic linter checks
the Markdown for defects a model should not need to be trusted to catch (a restated heading, a bare
URL, a repeated sentence, leaked outline scaffolding, a paragraph that stops mid-sentence) and asks for
a minimal, vocabulary-only correction when it finds one. Every URL still linked in the finished body is
then listed in an appended Sources section. None of this can fail the run: if anything past review
errors out unexpectedly, the run still returns the reviewed article rather than losing a finished draft.

## CLI options

```text
seo-agent --url <website> --topic <topic> [options]

--out <path>        Output Markdown path (default: a title-based filename)
--max-pages <n>     Maximum site pages to inspect (default: 12)
--concurrency <n>   Concurrent Deft section drafts (default: 4)
--thinking <level>  Deft thinking level: faster or smarter (default: faster)
--json              Emit newline-delimited JSON progress to stdout
--help              Show help

seo-agent serve [--port <n>]
```

Optional environment variables:

- `DEFT_API_BASE_URL` — override `https://deftwriting.com` for local or beta testing
- `SEO_AGENT_OPENROUTER_MODEL` — override the default primary OpenRouter model for every step
- `SEO_AGENT_OPENROUTER_FALLBACK_MODEL` — override the default fallback model every step retries with
  after a primary-model failure that looks like the model itself (not a transient blip) — a schema
  rejection, an unavailable route, or a timeout. Deliberately a different provider family by default,
  since the one such failure this pipeline has hit in practice was one provider refusing a strict JSON
  schema, which a same-provider fallback would have failed identically. A fallback only runs after the
  primary attempt fails, so it costs nothing on the normal path.
- `SEO_AGENT_PORT` — default local UI port
- `SEO_AGENT_MAX_CONCURRENT_RUNS` — simultaneous local UI runs (default: `1`)

## Cost and network access

Each run uses OpenRouter web search and model calls plus several billable Deft API generations. Cost varies with source material, section count, models, and output length. The hosted version is available at [deftwriting.com/seo-agent](https://deftwriting.com/seo-agent).

The crawler accepts public HTTP(S) websites only. It validates redirects and rejects local, private, link-local, multicast, and reserved network targets. This is defense in depth for a local tool; review the code before exposing it to an untrusted network.

## Development

```bash
npm test
npm run typecheck
npm run build
```

The canonical published prompts are in [`src/core/prompts.ts`](src/core/prompts.ts). Hosted and open-source implementations are intentionally separate and may diverge, but should preserve the same workflow vocabulary and prose-author boundary.

## License

MIT
