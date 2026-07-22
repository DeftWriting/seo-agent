# Repository guidance

This is the open-source Deft SEO Agent: a TypeScript Node.js CLI and tiny local web UI.

- Keep the runtime dependency surface minimal. The local server uses `node:http`; do not add a web framework without a clear need.
- All article prose must come from the Deft `/v1/generate` API. OpenRouter may research, plan, return structural operations, propose bounded exact-match edits, or move a whole paragraph, but must not freely rewrite article prose.
- Preserve the shared step vocabulary: `research`, `plan`, `draft`, `structural`, `review`. `review` itself now covers an internal fork (fact checker ∥ line editor), a join, a final edit, deterministic lint/repair, and the article contract — see below — but is still reported to the caller as one step.
- Never log or persist API keys. They come from `OPENROUTER_API_KEY` and `DEFT_API_KEY`.
- Keep network fetches SSRF-conscious: validate every redirect and reject private, loopback, link-local, multicast, and reserved IP targets. The fact checker's citation-evidence fetches reuse `adapters/fetcher.ts`'s `safeFetch` rather than a second fetch path — a tool that fetches arbitrary URLs on a user's own machine needs these protections more than a hosted one, not less.
- Run `npm test`, `npm run typecheck`, and `npm run build` before publishing.
- This repository is local software. Do not add deployment configuration unless the user explicitly asks.

## Cost and reliability (inverts the hosted product's rule)

The hosted product's own `web/src/lib/seo-agent/CLAUDE.md` is explicit that operating cost must never
reach the browser: it is a free tool for anonymous visitors, and cost is operator-only telemetry.
**This CLI inverts that rule on purpose.** A CLI user supplies their own `OPENROUTER_API_KEY` and
`DEFT_API_KEY` and pays for every call directly, so knowing what a run cost and where the time went is
a feature they asked for, not telemetry to hide — especially because a failed run has already spent
their money with nothing to show for it.

- `adapters/cost-meter.ts` holds an `AsyncLocalStorage`-based meter. `runWithCostMeter` opens one meter
  for the whole run and returns it **synchronously alongside the run's promise** (not only on success),
  so a run that throws partway through still has an accurate partial cost record — see `run.ts`'s
  `run_failed` event, which always carries a `partialCost` summary. `withCostStep` tags every call made
  inside it with the active pipeline step, so a fork (the fact-checker/line-editor parallel run, or the
  line editor's own per-paragraph fan-out) still attributes every nested call correctly without any
  extra plumbing at the call site.
- Unlike the hosted product's `createOpenRouterChatCompletion`, which only sends `usage: { include: true }`
  when a caller has opted into metering (because production must keep an unmetered path byte-identical),
  this CLI's `adapters/llm.ts` sends it on every request — there is no unmetered path here, only the one
  a paying CLI user always wants to see.
- `reporter.ts`'s `formatCostSummary` prints total cost (OpenRouter + Deft, separately), a per-step
  breakdown, a per-model breakdown, and reliability counters (failed attempts, fallback uses) at the end
  of every run — success or failure — to `stderr` (JSON mode already carries the same data in each
  event's `cost`/`partialCost` field, so it prints nothing extra there).
- Deft's own billed `amount_cents` per generation is the other cost source, recorded via
  `recordDeftCost` in `adapters/deft.ts`; OpenRouter cost and Deft cost are summed separately and
  together in the final summary.

## Cost/quality knobs

Full quality is the default — the product owner's instruction was "make it as good as we know how" —
but peer review (the fact checker, the line editor, and the final edit that resolves both) is also the
most expensive and slowest part of a run, so two flags exist to trade some of it away. Deliberately kept
to two, and both are shared, repo-wide controls rather than the hosted product's many per-step knobs:

- `--skip-review` / `SEO_AGENT_SKIP_REVIEW=1` skips the fact checker, line editor, and final edit call
  entirely. Lint, repair, and the article contract still run unconditionally — a cheap run still cannot
  ship leaked outline scaffolding, a restated heading, or an invented "Sources" list — but with no
  adversarial fact or line check, and with every external link stripped back to plain text (there is no
  verified source to attribute a citation to without a fact checker).
- `--line-edit-max-calls` / `SEO_AGENT_LINE_EDIT_MAX_CALLS` caps the line editor's per-paragraph
  fan-out (default 8; see `paragraph-line-edit.ts`). The line editor's parallelism, and the Deft section
  drafter's, both reuse the existing `--concurrency` flag rather than adding a third — one shared
  parallelism knob, not two nearly-identical ones.

Do not add a per-step model override for the fact checker, line editor, final edit, or lint repair.
They intentionally share `reviewModel`/`reviewFallbackModel` (default `openai/gpt-5.4-mini` /
`openai/gpt-5.4-nano`), matching the one model the hosted product measured as reliably strong at all
four jobs — a cheaper model tested as a fact checker or line editor rubber-stamped seeded factual
errors it was supposed to catch (see the hosted app's own CLAUDE.md, "Choosing models"). If a user wants
to spend less on review specifically, the two flags above are the intended lever, not a cheaper model.

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
  attempts' token usage is counted; the longest attempt is kept. Unlike production's own direct call to
  its internal chained writer (a base/distribution model that will copy back any string it is handed),
  this step's prompt (`buildSectionDraftPrompt`) goes to Deft's public `/v1/generate` API, which runs its
  own outline preprocessing — an instruction-following step — before the chained writer ever sees
  anything, so plain labelled context fields are safe here in a way they would not be sent directly to
  the writer itself. Keep that distinction in mind before copying more of production's writer-facing
  prompting verbatim; the two integrations are not the same shape.
- **`structural.ts` cannot let cutting empty a section or a paragraph.** `applyStructuralOperations`
  restores the least-aggressive cuts first once the cut budget (`MAX_CUT_RATIO`) is exceeded, always
  keeps at least one paragraph per planned section, and refuses a sentence cut that would leave a
  paragraph empty. `withoutTrailingFragment` trims an incomplete final sentence before any model edits
  a paragraph, so editing only ever reasons about complete prose. Unlike production's structural editor,
  this one does not let a paragraph move to a *different* section — see "Not ported" below.
- **`review.ts` forks into an adversarial fact checker and a per-paragraph line editor, then joins into
  one final edit call.** Both reviewers get the same `fetchedCitations` (SSRF-safe `safeFetch` GETs of
  every URL already linked in the draft, via `citationEvidence`), run with `Promise.all`, and their
  reports feed one `runFinalEdit` call that returns deterministic operations (`FinalEditOutput`):
  exact-match edits, exact sentence cuts, and exact whole-paragraph moves. `applyBoundedReview` is the
  only thing that mutates the document, and it never accepts a model-rewritten document — only
  operations it can verify against the text already in hand.
- **`paragraph-line-edit.ts` replaces a single whole-article line-edit call with one call per paragraph**
  (grouped into consecutive runs once the article passes `lineEditMaxCalls`, bounded by
  `lineEditConcurrency`). Each call sees its own passage as `paragraphToEdit`, the rest of the article as
  read-only `articleContextForCoherenceOnly`, and only the citation evidence its own passage actually
  cites (`selectRelevantCitations` — repeating the whole evidence set across every parallel call is the
  single biggest avoidable cost driver of this fan-out). `mergeLineEditReports` drops any issue whose
  quote is not actually inside the passage its own call was responsible for, which both catches a
  hallucinated out-of-scope finding and de-duplicates the same issue reported by more than one call.
- **`isPunctuationOnlyChange` exempts a same-words-same-order correction from the new-word budget.**
  `applyBoundedReview` caps how many "new" words a correction may add across the whole article and
  requires any new word to come from a small connective-word allowlist — but a correction that only
  changes quotation marks, a sentence break, a colon/dash, or capitalization cannot introduce a new claim
  no matter how many characters it touches, because the exact same words in the exact same order are
  exactly what the draft already said. This is what lets the final edit actually split a run-on sentence
  or properly quote a spliced first-person clause; without this exemption, both fixes would look like new
  writing to the guard and get silently dropped. It is verified from the text itself
  (`review.ts`'s `wordSequence`/`isPunctuationOnlyChange`), never from a model's self-reported edit
  `type`, so a mislabeled edit still has to earn its way past every other guard.
- **`lint.ts`'s `words()` strips URLs before tokenizing new-word counts.** Without this, wrapping an
  already-present or newly-verified URL in `[label](url)` would count the URL's own domain fragments
  ("https", "example", "com") as brand-new prose words and fail the word-budget guard on every citation
  insertion. A brand-new URL is instead policed by its own explicit guard — `applyRepairEdits`'s
  `introduces new url` check and `review.ts`'s `unverified_new_url` check — so a URL's reachability and
  provenance are never smuggled in for free just because its characters happen to tokenize as "not a new
  word."
- **`lint.ts`'s `paragraph_opens_with_heading` rule is deliberately conservative.** A paragraph that
  opens with a source page's own planted title, kicker, or byline is structurally identical to a
  paragraph that legitimately opens with a long capitalized institutional subject ("The United Nations
  Security Council convened…") — only grammar tells them apart, not shape. The rule only fires past a
  long threshold of consecutive capitalized words (`MAX_LEADING_CAPS_BEFORE_HEADING`), except when a
  colon proves a kicker, which is unambiguous at any length (`MAX_LEADING_CAPS_BEFORE_KICKER`). The truly
  ambiguous middle ground is left to the line editor, which reads the passage as a grammaticality
  question rather than pattern-matching it — this rule was skipped in an earlier pass specifically
  because that reader did not exist yet in this CLI; now that the per-paragraph line editor is ported,
  the rule can be too. Only `duplicate_heading` remains unrepairable-by-model (`isRepairableLintFinding`)
  among this CLI's rule set: it describes missing/duplicated structure, not a deletable fragment.
- **`article-contract.ts` is the never-fail finalization step.** `enforceArticleContract` returns
  `{ markdown, unmet }` and never throws for a content-quality reason. Every requirement follows the same
  ladder: fix it (link an audited claim, insert a bare-URL citation, link the first brand mention), then
  cut it if fixing is not possible and cutting is safe (an uncitable claim, cut only if its section would
  stay above `MIN_SECTION_WORDS + 40`), then omit the optional element if there is nothing to build one
  from (no headings to make a Table of Contents from), then record it in `unmet` for the caller to log.
  It can never invent a source, a URL, a citation, or prose — when no verified external source survives
  review at all, every unverified external link is demoted to plain text and Sources lists only the
  canonical site link, rather than shipping an unaudited bibliography or refusing to ship. `review.ts`
  wraps the whole lint-then-contract sequence in a safety net of its own: if anything in it throws
  unexpectedly, the run still returns the bounded, peer-reviewed markdown produced just before
  finalization rather than losing a completed draft.
- **`review.ts`'s sentence-cut guard is derived from `lint.ts`'s own `MIN_SECTION_WORDS` (60), with 40
  words of headroom**, recomputed against the *current* markdown on every cut (not the original) so an
  earlier cut is never charged to the wrong section. `article-contract.ts`'s own `cutUncitedClaim` floor
  is the same number for the same reason — a section cut to exactly the lint floor by one stage ships
  under it once a later stage trims a few more words.
- **`adapters/llm.ts` classifies OpenRouter failures before deciding how to respond**
  (`adapters/llm-failures.ts`): retry the same model for a rate limit, dropped connection, or an
  empty/unparseable body from an otherwise healthy call; switch to the configured fallback model for a
  schema rejection, a context-length mismatch, an unavailable route, or a timeout; and fail immediately
  on bad credentials. Fallbacks cross provider families on purpose and only ever run after the primary
  attempt fails, so they cost nothing on the normal path.
- **`fetcher.ts`'s `htmlToText` strips page chrome (`nav`/`header`/`footer`/`aside`/`form`/`dialog`)
  before flattening HTML**, because a newsletter CTA or a footer link list is indistinguishable from
  prose once the tags are gone, and a downstream writer will happily open a section with it.

## Deliberately not ported

- **The structural editor cannot move a paragraph to a *different* section**, only reorder within/across
  section boundaries via `sectionOrder`/`order`/`cuts`. Production's structural editor can relocate a
  retained paragraph to a different section outright (via a `placements` map) and omit a section emptied
  by relocation. This CLI's `review.ts` final-edit step can still move a whole paragraph anywhere in the
  final document (see `applyParagraphMoves`), which covers most of the same practical need with a
  simpler contract; genuine cross-section relocation at the *structural* stage was judged not worth the
  additional guard surface (a new "would this leave a section under-populated after relocation, not just
  after cutting" case) for what it would add on top of the final edit's own move capability. Revisit if
  real drafts show a defect only structural-stage relocation could fix.
- **Search-grounding redirect-URL resolution** (production's `withResolvedSourceUrls`, which resolves
  opaque `vertexaisearch.cloud.google.com/grounding-api-redirect/…`-style URLs at the research boundary).
  This CLI only ever uses OpenRouter's Exa search plugin, not native Google search grounding, so that
  specific redirect defect has not been observed here. If a future model/plugin change introduces native
  grounding, revisit this.

See the hosted app's own `web/src/lib/seo-agent/CLAUDE.md` for the full detail behind everything above —
it is the subsystem contract this repo ports lessons from, and it explains *why* each mechanism exists,
including measurements (accepted-operation rates, which cheap models rubber-stamp adversarial review,
why fallbacks cross provider families) that this file summarizes rather than repeats.
