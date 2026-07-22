# Repository guidance

This is the open-source Deft SEO Agent: a TypeScript Node.js CLI and tiny local web UI.

- Keep the runtime dependency surface minimal. The local server uses `node:http`; do not add a web framework without a clear need.
- All article prose must come from the Deft `/v1/generate` API. OpenRouter may research, plan, return structural operations, and propose bounded exact-match edits, but must not freely rewrite article prose.
- Preserve the shared step vocabulary: `research`, `plan`, `draft`, `structural`, `review`.
- Never log or persist API keys. They come from `OPENROUTER_API_KEY` and `DEFT_API_KEY`.
- Keep network fetches SSRF-conscious: validate every redirect and reject private, loopback, link-local, multicast, and reserved IP targets.
- Run `npm test`, `npm run typecheck`, and `npm run build` before publishing.
- This repository is local software. Do not add deployment configuration unless the user explicitly asks.

## Pipeline notes (ported correctness lessons)

These behaviors exist because of specific, observed failure modes. Keep them when touching the
relevant step.

- **`plan.ts` asks for structured paragraphs, not formatted text.** Each section's outline comes back
  as a `paragraphs: [{ job, details }]` array (4-6 entries, 2-3 details each) and `renderParagraphOutline`
  builds the `- Paragraph N: ...` text server-side. The chained Deft writer generates roughly one
  paragraph per block, so a model asked to hand-format that bullet text directly would occasionally
  collapse a whole section into one block and silently produce a stub. Do not go back to asking the
  model for pre-formatted outline text.
- **`draft.ts` detects a collapsed section and retries once.** A returned section far shorter than
  requested, or one that just echoes its own heading or summary, is redrafted (`isCollapsedSection`,
  `MAX_SECTION_ATTEMPTS`); the same retry loop also covers a transient Deft request failure. All
  attempts' token usage is counted; the longest attempt is kept.
- **`structural.ts` cannot let cutting empty a section or a paragraph.** `applyStructuralOperations`
  restores the least-aggressive cuts first once the cut budget (`MAX_CUT_RATIO`) is exceeded, always
  keeps at least one paragraph per planned section, and refuses a sentence cut that would leave a
  paragraph empty. `withoutTrailingFragment` trims an incomplete final sentence before any model edits
  a paragraph, so editing only ever reasons about complete prose.
- **`review.ts`'s sentence cuts respect a per-section word floor**, recomputed against the *current*
  markdown on every cut (not the original) so an earlier cut is never charged to the wrong section.
- **`lint.ts` is a deterministic gate, not a model opinion.** After review, `lintAndRepairArticle` checks
  the Markdown for mechanically-detectable defects (restated heading/title, duplicate heading, bare
  URL, repeated sentence, leaked outline scaffolding, mid-sentence paragraph) and asks for a minimal,
  vocabulary-only correction (`applyRepairEdits` rejects anything that isn't a unique, non-overlapping
  edit using only words already in the article). This — and the Sources section `withSourcesSection`
  appends afterward — is wrapped in a try/catch in `reviewStep`: a completed, reviewed draft must always
  reach the caller, so a finalization failure falls back to the pre-repair markdown rather than losing
  the run.
- **`adapters/llm.ts` classifies OpenRouter failures before deciding how to respond**
  (`adapters/llm-failures.ts`): retry the same model for a rate limit or dropped connection, switch to
  the configured fallback model for a schema rejection or timeout, and fail immediately on bad
  credentials. Fallbacks cross provider families on purpose and only ever run after the primary
  attempt fails, so they cost nothing on the normal path.
- **`fetcher.ts`'s `htmlToText` strips page chrome (`nav`/`header`/`footer`/`aside`/`form`/`dialog`)
  before flattening HTML**, because a newsletter CTA or a footer link list is indistinguishable from
  prose once the tags are gone, and a downstream writer will happily open a section with it.

Deliberately not ported from production: the adversarial fact-checker/line-editor fork (a second
parallel reviewer with a per-paragraph fan-out), the full article-contract system (table of contents,
first-mention brand auto-linking, a verified-source ledger), and search-grounding redirect-URL
resolution (this CLI only ever uses OpenRouter's Exa search plugin, not native Google grounding, so
that specific redirect defect does not arise here). See the hosted app's own
`web/src/lib/seo-agent/CLAUDE.md` for what those look like and why they exist there.
