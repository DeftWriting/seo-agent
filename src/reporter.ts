import pc from "picocolors";
import type { CostSummary, SeoAgentEvent, StepId } from "./types.js";

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

function formatUsd(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const totalSeconds = ms / 1_000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

// Cost is a feature for a CLI user paying for their own key directly — see CLAUDE.md — so this prints
// unconditionally at the end of every run, success or failure, rather than staying hidden the way the
// hosted product's own operator-only cost meter does.
export function formatCostSummary(cost: CostSummary): string[] {
  const lines: string[] = [];
  lines.push(
    `Cost: ${formatUsd(cost.totalUsd)} total (${formatUsd(cost.openRouterUsd)} OpenRouter + ${formatUsd(cost.deftUsd)} Deft) — ${formatDuration(cost.elapsedMs)} elapsed`,
  );
  for (const step of cost.byStep) {
    if (step.calls === 0 && step.deftUsd === 0 && step.ms === 0) continue;
    const stepUsd = step.usd + step.deftUsd;
    const searchNote = step.webSearchRequests > 0 ? `, ${step.webSearchRequests} web search${step.webSearchRequests === 1 ? "" : "es"}` : "";
    lines.push(
      `  ${STEP_LABELS[step.step].padEnd(17)} ${formatUsd(stepUsd).padStart(9)}  ${formatDuration(step.ms).padStart(7)}  (${step.calls} call${step.calls === 1 ? "" : "s"}${searchNote})`,
    );
  }
  if (cost.byModel.length > 0) {
    lines.push(`  By model: ${cost.byModel.map((entry) => `${entry.model} ${formatUsd(entry.usd)}`).join(", ")}`);
  }
  if (cost.unpricedCalls > 0) {
    lines.push(`  ${cost.unpricedCalls} OpenRouter call${cost.unpricedCalls === 1 ? "" : "s"} did not return a billed cost (provider did not report usage.cost).`);
  }
  if (cost.failedAttempts > 0 || cost.fallbacksUsed > 0) {
    lines.push(`  Reliability: ${cost.failedAttempts} failed attempt${cost.failedAttempts === 1 ? "" : "s"}, ${cost.fallbacksUsed} fallback model use${cost.fallbacksUsed === 1 ? "" : "s"}.`);
  }
  return lines;
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
        process.stderr.write(`${pc.dim(elapsed)} ${pc.green("✔")} ${message}\n`);
        break;
      case "run_complete":
        process.stderr.write(`${pc.dim(elapsed)} ${pc.green("✔")} ${message}\n`);
        for (const line of formatCostSummary(event.result.cost)) process.stderr.write(`${pc.dim(line)}\n`);
        break;
      case "warning":
        process.stderr.write(`${pc.dim(elapsed)} ${pc.yellow("!")} ${message}\n`);
        break;
      case "run_failed":
        process.stderr.write(`${pc.dim(elapsed)} ${pc.red("✖")} ${message}\n`);
        for (const line of formatCostSummary(event.partialCost)) process.stderr.write(`${pc.dim(line)}\n`);
        break;
      case "step_started":
        process.stderr.write(`${pc.dim(elapsed)} ${pc.magenta("◆")} ${message}\n`);
        break;
      default:
        process.stderr.write(`${pc.dim(elapsed)} ${pc.dim("·")} ${message}\n`);
    }
  }
}
