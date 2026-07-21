import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { runSeoAgent } from "./core/run.js";
import type { SeoAgentEvent } from "./types.js";
import { UI_HTML } from "./ui.js";

interface LocalRun {
  events: SeoAgentEvent[];
  clients: Set<ServerResponse>;
  finished: boolean;
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
  const runs = new Map<string, LocalRun>();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      });
      response.end(UI_HTML);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/runs") {
      try {
        const body = (await readJson(request)) as { url?: unknown; topic?: unknown };
        if (typeof body.url !== "string" || typeof body.topic !== "string") {
          sendJson(response, 400, { error: "Website URL and topic are required." });
          return;
        }

        const runId = randomUUID();
        const localRun: LocalRun = { events: [], clients: new Set(), finished: false };
        runs.set(runId, localRun);
        sendJson(response, 202, { runId });

        const emit = (event: SeoAgentEvent): void => {
          localRun.events.push(event);
          const line = `data: ${JSON.stringify(event)}\n\n`;
          for (const client of localRun.clients) client.write(line);
          if (event.type === "run_complete" || event.type === "run_failed") {
            localRun.finished = true;
            for (const client of localRun.clients) client.end();
            localRun.clients.clear();
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
