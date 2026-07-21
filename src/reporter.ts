import pc from "picocolors";
import type { SeoAgentEvent, StepId } from "./types.js";

const STEP_LABELS: Record<StepId, string> = {
  research: "Research",
  plan: "Plan",
  draft: "Draft",
  structural: "Structural edit",
  review: "Review",
};

export function eventMessage(event: SeoAgentEvent): string {
  switch (event.type) {
    case "run_started":
      return `Starting article for ${event.topic}`;
    case "step_started":
      return `${STEP_LABELS[event.step]} — ${event.message}`;
    case "step_progress": {
      const count =
        event.completed !== undefined && event.total !== undefined
          ? ` (${event.completed}/${event.total})`
          : "";
      return `${STEP_LABELS[event.step]} — ${event.message}${count}`;
    }
    case "step_complete":
      return `${STEP_LABELS[event.step]} — ${event.message}`;
    case "warning":
      return event.message;
    case "run_complete":
      return "Article ready";
    case "run_failed":
      return event.error;
  }
}

export class TerminalReporter {
  readonly #json: boolean;
  readonly #started = Date.now();

  constructor(options: { json?: boolean } = {}) {
    this.#json = options.json ?? false;
  }

  report(event: SeoAgentEvent): void {
    if (this.#json) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      return;
    }

    const elapsed = `${Math.floor((Date.now() - this.#started) / 1_000)}s`.padStart(5);
    const message = eventMessage(event);

    switch (event.type) {
      case "step_complete":
      case "run_complete":
        process.stderr.write(`${pc.dim(elapsed)} ${pc.green("✔")} ${message}\n`);
        break;
      case "warning":
        process.stderr.write(`${pc.dim(elapsed)} ${pc.yellow("!")} ${message}\n`);
        break;
      case "run_failed":
        process.stderr.write(`${pc.dim(elapsed)} ${pc.red("✖")} ${message}\n`);
        break;
      case "step_started":
        process.stderr.write(`${pc.dim(elapsed)} ${pc.magenta("◆")} ${message}\n`);
        break;
      default:
        process.stderr.write(`${pc.dim(elapsed)} ${pc.dim("·")} ${message}\n`);
    }
  }
}
