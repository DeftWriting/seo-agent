import { createServer, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { emptyCostSummary } from "./adapters/cost-meter.js";
import { runSeoAgent } from "./core/run.js";
import type { SeoAgentEvent } from "./types.js";
import { UI_HTML } from "./ui.js";

interface LocalRun {
  events: SeoAgentEvent[];
  clients: Set<ServerResponse>;
  finished: boolean;
  createdAt: number;
  finishedAt?: number;
}

const FINISHED_RUN_TTL_MS = 30 * 60 * 1_000;
const MAX_RETAINED_RUNS = 50;

function positiveEnvironmentInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function localHostname(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function safeTokenEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: NodeJS.ReadableStream): Promise<unknown> {
  let raw = "";
  for await (const chunk of request) {
    raw += String(chunk);
    if (raw.length > 65_536) throw new Error("Request body is too large.");
  }
  return JSON.parse(raw || "{}");
}

export async function serveSeoAgent(options: { port?: number } = {}): Promise<void> {
  const port = options.port ?? Number(process.env.SEO_AGENT_PORT ?? 4173);
  const maxConcurrentRuns = positiveEnvironmentInteger("SEO_AGENT_MAX_CONCURRENT_RUNS", 1);
  const csrfToken = randomBytes(24).toString("base64url");
  const runs = new Map<string, LocalRun>();
  const cleanupRuns = (): void => {
    const cutoff = Date.now() - FINISHED_RUN_TTL_MS;
    for (const [runId, run] of runs) {
      if (run.finishedAt !== undefined && run.finishedAt < cutoff) runs.delete(runId);
    }
    const finished = [...runs.entries()]
      .filter(([, run]) => run.finished)
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (runs.size > MAX_RETAINED_RUNS && finished.length) {
      const oldest = finished.shift();
      if (oldest) runs.delete(oldest[0]);
    }
  };

  const server = createServer(async (request, response) => {
    cleanupRuns();
    if (!localHostname(request.headers.host)) {
      sendJson(response, 403, { error: "Localhost Host header required." });
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      });
      response.end(UI_HTML.replace("__SEO_AGENT_CSRF_TOKEN__", JSON.stringify(csrfToken)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/runs") {
      try {
        const origin = request.headers.origin;
        if (!origin || !localHostname(new URL(origin).host)) {
          sendJson(response, 403, { error: "A localhost Origin header is required." });
          return;
        }
        if (!safeTokenEqual(request.headers["x-seo-agent-csrf"] as string | undefined, csrfToken)) {
          sendJson(response, 403, { error: "Invalid local request token." });
          return;
        }
        const activeRuns = [...runs.values()].filter((run) => !run.finished).length;
        if (activeRuns >= maxConcurrentRuns) {
          sendJson(response, 429, { error: "A local run is already in progress." });
          return;
        }
        const body = (await readJson(request)) as { url?: unknown; topic?: unknown };
        if (typeof body.url !== "string" || typeof body.topic !== "string") {
          sendJson(response, 400, { error: "Website URL and topic are required." });
          return;
        }

        const runId = randomUUID();
        const localRun: LocalRun = { events: [], clients: new Set(), finished: false, createdAt: Date.now() };
        runs.set(runId, localRun);
        sendJson(response, 202, { runId });

        const emit = (event: SeoAgentEvent): void => {
          localRun.events.push(event);
          const line = `data: ${JSON.stringify(event)}\n\n`;
          for (const client of localRun.clients) client.write(line);
          if (event.type === "run_complete" || event.type === "run_failed") {
            localRun.finished = true;
            localRun.finishedAt = Date.now();
            for (const client of localRun.clients) client.end();
            localRun.clients.clear();
            const timer = setTimeout(() => runs.delete(runId), FINISHED_RUN_TTL_MS);
            timer.unref();
          }
        };

        void runSeoAgent({
          url: body.url,
          topic: body.topic,
          openRouterApiKey: process.env.OPENROUTER_API_KEY,
          deftApiKey: process.env.DEFT_API_KEY,
          deftApiUrl: process.env.DEFT_API_BASE_URL,
        }, emit).catch((error: unknown) => {
          if (!localRun.finished) {
            emit({
              type: "run_failed",
              error: error instanceof Error ? error.message : String(error),
              // This fallback fires only if runSeoAgent itself threw before emitting its own
              // run_failed event (which normally carries the real partial cost) — so there is no
              // meter left to read from here.
              partialCost: emptyCostSummary(),
              at: new Date().toISOString(),
            });
          }
        });
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : "Invalid request.",
        });
      }
      return;
    }

    const eventMatch = /^\/api\/runs\/([0-9a-f-]+)\/events$/.exec(url.pathname);
    if (request.method === "GET" && eventMatch) {
      const runId = eventMatch[1];
      const localRun = runId ? runs.get(runId) : undefined;
      if (!localRun) {
        sendJson(response, 404, { error: "Run not found." });
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      response.write(": connected\n\n");
      for (const event of localRun.events) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      if (localRun.finished) response.end();
      else {
        localRun.clients.add(response);
        request.on("close", () => localRun.clients.delete(response));
      }
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  process.stdout.write(`Deft SEO Agent is running at http://localhost:${port}\n`);
}
