# Repository guidance

This is the open-source Deft SEO Agent: a TypeScript Node.js CLI and tiny local web UI.

- Keep the runtime dependency surface minimal. The local server uses `node:http`; do not add a web framework without a clear need.
- All article prose must come from the Deft `/v1/generate` API. OpenRouter may research, plan, return structural operations, and propose bounded exact-match edits, but must not freely rewrite article prose.
- Preserve the shared step vocabulary: `research`, `plan`, `draft`, `structural`, `review`.
- Never log or persist API keys. They come from `OPENROUTER_API_KEY` and `DEFT_API_KEY`.
- Keep network fetches SSRF-conscious: validate every redirect and reject private, loopback, link-local, multicast, and reserved IP targets.
- Run `npm test`, `npm run typecheck`, and `npm run build` before publishing.
- This repository is local software. Do not add deployment configuration unless the user explicitly asks.
