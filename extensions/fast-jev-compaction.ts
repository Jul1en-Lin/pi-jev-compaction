import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createDeadline,
  createJevAsker,
  DEFAULT_TIMEOUT_MS,
  filterPreparation,
  type TimerApi,
} from "../src/adapter.js";
import type { JevAsker } from "fast-jev-compaction";

const SUPPORTED_PI_VERSION = "0.85.1";

export interface ExtensionDependencies {
  apiKey?: string;
  asker?: JevAsker;
  timers?: TimerApi;
}

export function parseTimeout(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_TIMEOUT_MS;
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : DEFAULT_TIMEOUT_MS;
}

/** Short, transient console line: nothing here is written to the session or disk. */
export function formatElapsed(milliseconds: number): string {
  return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}

export function install(pi: ExtensionAPI, dependencies: ExtensionDependencies = {}): void {
  pi.on("session_before_compact", async (event, ctx) => {
    if (VERSION !== SUPPORTED_PI_VERSION) {
      ctx.ui.notify(
        `[jev] skipped: Pi ${VERSION} is not ${SUPPORTED_PI_VERSION}; using Pi's native compaction.`,
        "warning",
      );
      return;
    }

    const apiKey = dependencies.apiKey ?? process.env.TYPESAFE_API_KEY;
    if (!apiKey && !dependencies.asker) {
      ctx.ui.notify("[jev] skipped: TYPESAFE_API_KEY is not set; using Pi's native compaction.", "warning");
      return;
    }

    const timeoutMs = parseTimeout(process.env.PI_FAST_JEV_TIMEOUT_MS);
    const deadline = createDeadline(event.signal, timeoutMs, dependencies.timers);
    const startedAt = Date.now();

    try {
      const asker = dependencies.asker ?? createJevAsker(apiKey as string, deadline.signal);
      const filtered = await filterPreparation(
        event.preparation.messagesToSummarize,
        event.preparation.turnPrefixMessages,
        { asker, signal: deadline.signal },
      );

      // User cancellation owns the outcome. Do not replace either input after it.
      if (event.signal.aborted) return;

      const elapsed = formatElapsed(Date.now() - startedAt);
      if (!filtered.changed) {
        ctx.ui.notify(
          `[jev] ${filtered.candidateCalls} call(s) reviewed: nothing dropped · ${elapsed}; Pi will create the native summary.`,
          "info",
        );
        return;
      }

      // These are the only preparation fields this extension changes. Pi still
      // creates its own summary and compaction entry with its native metadata.
      event.preparation.messagesToSummarize = filtered.messagesToSummarize;
      event.preparation.turnPrefixMessages = filtered.turnPrefixMessages;
      ctx.ui.notify(
        `[jev] ${filtered.candidateCalls} call(s) reviewed: dropped ${filtered.droppedCalls}, shortened ${filtered.truncatedResults} · ${elapsed}; Pi will create the native summary.`,
        "info",
      );
    } catch {
      if (event.signal.aborted) return;
      const elapsed = formatElapsed(Date.now() - startedAt);
      if (deadline.timedOut()) {
        ctx.ui.notify(`[jev] timed out after ${timeoutMs}ms · ${elapsed}; using Pi's native compaction.`, "warning");
      } else {
        ctx.ui.notify(`[jev] failed · ${elapsed}; using Pi's native compaction.`, "warning");
      }
    } finally {
      deadline.dispose();
    }
  });
}

export default function fastJevCompaction(pi: ExtensionAPI): void {
  install(pi);
}
