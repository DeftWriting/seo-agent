# Deft SEO Agent

An open-source agent that researches a site and a topic, plans an SEO/GEO-friendly long-form article, drafts its sections in parallel with [Deft](https://deftwriting.com), applies constrained structural editing, then runs a full adversarial peer review — a fact checker and a per-paragraph line editor working in parallel — before a deterministic lint pass and article contract finish the piece.

The important boundary is simple: **Deft writes all article prose.** The research and editor models can gather evidence, plan, cut, reorder, propose small exact-match fixes, or move a whole paragraph; they do not replace the draft with model-written prose.

Full quality is the default. Peer review is also the most expensive and slowest part of a run — see [Cost and runtime](#cost-and-runtime) — so two flags let you trade some of it away when you want a faster or cheaper draft.

## Quickstart

Requires Node.js 20 or newer and your own API keys:

- `OPENROUTER_API_KEY` for research, planning, structural editing, and adversarial review
- `DEFT_API_KEY` for section drafting through Deft's public API ([create or manage a key](https://deftwriting.com/developers))

```bash
git clone https://github.com/DeftWriting/seo-agent.git
cd seo-agent
npm install
export OPENROUTER_API_KEY="..."
export DEFT_API_KEY="deft_live_..."
npm run dev -- --url https://example.com --topic "A practical guide to the topic"
```

The finished Markdown file is written to the current directory by default. Use `--out article.md` to choose a path. The terminal prints progress as the run goes and a cost/runtime breakdown at the end (see [Cost and runtime](#cost-and-runtime)) — unlike the hosted version, a CLI run is billed to keys you hold, so what it cost and where the time went is printed every time, not hidden.

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

```text
Research
  ├─ crawl the site (sitemap + up to --max-pages pages)
  └─ 2 parallel OpenRouter searches ──▶ synthesis ──▶ research brief (site, SERP, sourced facts)
       │
       ▼
Plan   4-7 sections, each planned as 4-6 structured paragraph blocks
       │
       ▼
Draft  parallel Deft calls, one per section, bounded by --concurrency
       S1 ‖ S2 ‖ S3 ‖ ... ‖ Sn
       │
       ▼
Structural edit   single call: cut sentences/paragraphs, reorder — never writes prose
       │
       ▼
Review ─────────────────────────────────────────────────────────────────────────────
  │                                                                                 │
  ├─▶ Fact checker           one call: audits citations and factual claims,        │
  │                          web search + fetched evidence of the article's        │
  │                          own citations                                        (fork:
  │                                              ‖                            both run
  ├─▶ Line editor            one call PER PARAGRAPH (grouped into consecutive     in
  │                          runs once the article passes --line-edit-max-calls;  parallel)
  │                          bounded by shared --concurrency)
  │                          P1 ‖ P2 ‖ P3 ‖ ... ‖ Pn
  │       │                            │
  │       └──────────────┬─────────────┘   (join: both reports merge)
  │                       ▼
  └────────────────▶ Final edit   resolves both reports: exact edits / cuts / whole-
                       │           paragraph moves — never a rewritten document
                       ▼
             ┌──▶ Lint            deterministic mechanical checks
             │       │
             │    clean? ──yes──▶ Article contract   citations, Sources list,
             │       │no                              linked Table of Contents
             │       ▼                                      │
             └── Repair          minimal LLM correction,     │
                  (≤3 rounds) ───────────────────────────────┘
                                                              ▼
                                                     Markdown article
```

`--skip-review` cuts straight from **Structural edit** to **Lint**, skipping the fact checker, line
editor, and final edit entirely. Lint, repair, and the article contract still run — a cheap run never
ships leaked outline scaffolding or an invented "Sources" list — but with no adversarial fact or line
check, and with every external link stripped back to plain text (no adversarial review means no
verified source to attribute it to).

The planner chooses four to seven sections, usually targeting roughly 500 words each. Each section is
planned as 4 to 6 structured paragraph blocks (a one-sentence job plus 2-3 concrete details), rendered
into the writer-facing outline text after the planner returns them, rather than asked from the model as
pre-formatted text — a model reliably returns structured JSON but not exact multi-line bullet
formatting, and the chained writer generates roughly one paragraph per block, so an under-specified
outline reliably produced stub sections. Draft requests are independent, self-contained full-document
prompts because the public Deft API performs its own outline preprocessing; a section that comes back
far short of its target length is redrafted once, and the longest attempt is kept.

Structural editing and review are both bounded so an aggressive editor can cut a lot without ever
emptying a planned section or a paragraph outright. The fact checker and line editor run as two
independent adversarial passes rather than one combined pass: each has a narrower job, they run in
parallel so wall-clock does not double, and — for the line editor — a per-paragraph fan-out means each
call only has to be right about one passage, with the rest of the article supplied as read-only context
for coherence. A final edit call then resolves every substantiated issue from both reports with
deterministic, guarded operations: an edit must match a unique span exactly, a cut must be a complete
sentence that would not leave its section nearly empty, and a move must name a paragraph and a target
that each occur exactly once. After that, a small deterministic linter checks the Markdown for defects a
model should not need to be trusted to catch (a restated heading or title, a bare URL, a repeated
sentence, leaked outline scaffolding, an unterminated paragraph, or a paragraph that opens with what
reads like a planted title, byline, or kicker lifted from a source page) and asks for a minimal,
vocabulary-only correction when it finds one, for up to three rounds. Finally, the article contract
inserts inline citations for audited claims, links the first mention of the site/company to its URL,
appends a Sources section built from every link the finished body actually contains (unioned with the
fact checker's verified sources — never the verified set alone), and inserts a linked Table of Contents
between the title and the body.

None of this can fail the run once a full draft exists. Every requirement the article contract enforces
follows a fix → cut → omit → record ladder: it fixes what it can, cuts an unsupported or unlinkable claim
if that is safe, omits an optional element (like the table of contents) if there is nothing to build one
from, and otherwise records the miss as an "unmet requirement" reported as a warning rather than failing
the run. If anything past structural editing errors out unexpectedly, the run still returns the best
markdown already in hand rather than losing a finished draft — this matters more here than in a hosted
tool, because a failed CLI run has already spent the user's own money.

## CLI options

```text
seo-agent --url <website> --topic <topic> [options]

--out <path>                Output Markdown path (default: a title-based filename)
--max-pages <n>              Maximum site pages to inspect (default: 12)
--concurrency <n>            Parallel Deft section drafts, and the line editor's per-paragraph
                              call concurrency (default: 4)
--thinking <level>           Deft thinking level: faster or smarter (default: faster)
--skip-review                Skip the fact checker, line editor, and final edit; still lints,
                              repairs, and applies the article contract
--line-edit-max-calls <n>    Cap the line editor's per-paragraph fan-out (default: 8)
--json                       Emit newline-delimited JSON progress to stdout
--help                       Show help

seo-agent serve [--port <n>]
```

Optional environment variables:

- `DEFT_API_BASE_URL` — override `https://deftwriting.com` for local or beta testing
- `SEO_AGENT_OPENROUTER_MODEL` — override the default primary OpenRouter model for every step
- `SEO_AGENT_OPENROUTER_FALLBACK_MODEL` — override the default fallback model every step retries with
  after a primary-model failure that looks like the model itself (not a transient blip) — a schema
  rejection, an unavailable route, a context-length mismatch, or a timeout. Deliberately a different
  provider family by default, since the one such failure this pipeline has hit in practice was one
  provider refusing a strict JSON schema, which a same-provider fallback would have failed identically.
  A fallback only runs after the primary attempt fails, so it costs nothing on the normal path.
- `SEO_AGENT_SKIP_REVIEW=1` — same effect as `--skip-review`
- `SEO_AGENT_LINE_EDIT_MAX_CALLS` — same effect as `--line-edit-max-calls`
- `SEO_AGENT_PORT` — default local UI port
- `SEO_AGENT_MAX_CONCURRENT_RUNS` — simultaneous local UI runs (default: `1`)

Per-step model overrides (`--url`/`--topic` aside, everything else has a sensible default) are available
as `SeoAgentRunOptions` fields when using this as a library, but deliberately are not each given their
own environment variable — see [Default models](#default-models) for why one shared override plus a
per-step fallback is enough for a tool this size.

## Default models

| Step | Default model | Fallback | Overridable with |
| --- | --- | --- | --- |
| Research (2 searches + synthesis) | `google/gemini-3-flash-preview` | `openai/gpt-5.4-mini` | `SEO_AGENT_OPENROUTER_MODEL` / `SEO_AGENT_OPENROUTER_FALLBACK_MODEL`, or the `researchModel`/`researchFallbackModel` library options |
| Plan | `google/gemini-3-flash-preview` | `openai/gpt-5.4-mini` | same shared override, or `planModel`/`planFallbackModel` |
| Structural edit | `google/gemini-3-flash-preview` | `openai/gpt-5.4-nano` | same shared override, or `editModel`/`editFallbackModel` |
| Fact checker, line editor, final edit, lint repair | `openai/gpt-5.4-mini` | `openai/gpt-5.4-nano` | same shared override, or `reviewModel`/`reviewFallbackModel` |
| Drafting | Deft (not an OpenRouter model; see `--thinking`) | — | `DEFT_API_BASE_URL`, `--thinking faster\|smarter` |

Fact checking, line editing, final editing, and lint repair intentionally share one model pair rather
than each getting its own environment variable, unlike the hosted product's six separately-tunable
per-step models — this repo's own convention is a handful of shared controls rather than many narrow
ones, and `openai/gpt-5.4-mini` is the one model the hosted product measured as reliably strong across
all four of those jobs (see the hosted app's own `web/src/lib/seo-agent/CLAUDE.md` for the evidence: a
cheaper model tested as a fact checker or line editor rubber-stamped seeded factual errors it was
supposed to catch). If you want to spend less specifically on review, use `--skip-review` or
`--line-edit-max-calls` rather than swapping in a cheaper model for it.

## Cost and runtime

**These figures are approximate and scale with article length, section count, source material, and
which models are configured.** They are not a quote for your run. Two kinds of numbers appear below:
figures marked **measured** came from an actual run of this code against the real OpenRouter API during
development; figures marked **estimated** are derived from those measurements, from Deft's own publicly
documented per-token pricing (`$2.50` per million input tokens plus `$12` per million output and
thinking tokens, rounded up to the nearest cent — see `api_documentation.txt` on
[deftwriting.com/developers](https://deftwriting.com/developers)), and from the hosted product's own
published measurement that review is roughly 90% of spend and 70% of wall clock on a representative run
— never from guessing a number that sounded plausible.

| Stage | Calls | Cost | Wall clock | Basis |
| --- | --- | --- | --- | --- |
| Research | 1 (+2 web searches) | ~$0.005 | ~9s | **measured** |
| Plan | 1 | ~$0.007 | ~8s | **measured** |
| Draft (Deft API) | 1 per section | ~$0.07 | ~25s | **estimated** |
| Structural edit | 1 | ~$0.003 | ~2s | **measured** |
| Review (fact check + per-paragraph line edit + final edit) | 3-30 | ~$0.10 | ~45-100s | **measured** |
| Lint repair | 0-3 | ~$0.005-0.015 | ~5-15s | **measured** |
| **Full run** | | **~$0.19** | **~100-170s** | ~1,500-2,500 words |
| **With `--skip-review`** | | **~$0.09** | **~45-60s** | same length, no adversarial review |

The **measured** rows come from real runs of this same pipeline against the live OpenRouter API during
development, on a 4-section article. The **estimated** drafting row is computed from Deft's published
per-token pricing rather than observed, assuming roughly 2,000 input tokens per section prompt and
3,000-4,000 output plus thinking tokens for the finished article; your figure moves with section count
and article length.

Note that drafting is the one stage billed by Deft rather than OpenRouter, so it does not appear in the
hosted product's own published cost breakdown — the hosted app reaches its model over a private endpoint
and never pays the public per-token rate. Budget for it here: it is the second-largest line item after
review, and a comparison against the hosted numbers alone would understate what a self-hosted run costs
you by roughly a third.

A full run's spend is dominated by review, because it is the only stage that makes more than a handful
of model calls: one fact-check call, one line-edit call per paragraph (roughly 15-30 for a ~2,500-word
article, bounded by `--line-edit-max-calls`), and one final-edit call. Research, planning, and structural
editing are each a single call and are noise by comparison. `--skip-review` removes essentially all of
that spend and most of the wall clock, at the cost of no adversarial fact or line check and no verified
citations in the shipped article (see [Workflow](#workflow)).

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
