import {
  compact,
  resolveOptions,
  buildJevRequest,
  parseJevResponse,
  type CallDecision,
  type CompactOptions,
  type JevAsker,
  type JevQuestions,
  type JevResponse,
  type JevState,
  type Message as JevMessage,
} from "fast-jev-compaction";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";

export const DEFAULT_TIMEOUT_MS = 15_000;

export interface TimerApi {
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface Deadline {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  dispose(): void;
}

export interface FilterOptions {
  asker: JevAsker;
  compactOptions?: CompactOptions;
  signal?: AbortSignal;
}

export interface FilterResult {
  messages: AgentMessage[];
  changed: boolean;
  /** Paired, text-only tool calls Jev was asked about. */
  candidateCalls: number;
  droppedCalls: number;
  truncatedResults: number;
}

export interface PreparationFilterResult {
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  changed: boolean;
  candidateCalls: number;
  droppedCalls: number;
  truncatedResults: number;
}

type TextOrImage = TextContent | ImageContent;

type Pair = {
  toolCallId: string;
  callMessageIndex: number;
  resultMessageIndex: number;
};

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function rejectOnAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createDeadline(
  parentSignal: AbortSignal,
  timeoutMs: number,
  timers: TimerApi = globalThis,
): Deadline {
  const controller = new AbortController();
  let timeoutFired = false;
  const handle = timers.setTimeout(() => {
    timeoutFired = true;
    controller.abort();
  }, timeoutMs);
  const signal = AbortSignal.any([parentSignal, controller.signal]);

  return {
    signal,
    timedOut: () => timeoutFired,
    dispose: () => timers.clearTimeout(handle),
  };
}

export function createJevAsker(
  apiKey: string,
  signal: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
): JevAsker {
  return {
    async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
      const request = buildJevRequest({ apiKey }, state, questions);
      const response = await rejectOnAbort(
        fetcher(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal,
        }),
        signal,
      );
      const body = await rejectOnAbort(response.text(), signal);
      return parseJevResponse(response.status, response.ok, body);
    },
  };
}

function isTextOnly(content: readonly TextOrImage[]): content is readonly TextContent[] {
  return content.every((block) => block.type === "text");
}

function contentText(content: readonly TextOrImage[]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : "[image omitted from Jev decision]"))
    .join("\n");
}

function messageText(message: AgentMessage): string {
  switch (message.role) {
    case "user":
      return typeof message.content === "string" ? message.content : contentText(message.content);
    case "toolResult":
      return contentText(message.content);
    case "assistant":
      return message.content
        .map((block) => {
          if (block.type === "text") return block.text;
          if (block.type === "thinking") return `[thinking]\n${block.thinking}`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    case "bashExecution":
      return `${message.command}\n${message.output}`;
    case "custom":
      return typeof message.content === "string" ? message.content : contentText(message.content);
    case "branchSummary":
    case "compactionSummary":
      return message.summary;
    default:
      return "";
  }
}

function collectPairs(messages: readonly AgentMessage[]): Pair[] {
  const calls = new Map<string, number>();
  const duplicateCalls = new Set<string>();
  const results = new Map<string, number>();
  const duplicateResults = new Set<string>();

  messages.forEach((message, index) => {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        if (calls.has(block.id)) duplicateCalls.add(block.id);
        else calls.set(block.id, index);
      }
    }
    if (message.role === "toolResult") {
      if (results.has(message.toolCallId)) duplicateResults.add(message.toolCallId);
      else results.set(message.toolCallId, index);
    }
  });

  const pairs: Pair[] = [];
  for (const [toolCallId, callMessageIndex] of calls) {
    const resultMessageIndex = results.get(toolCallId);
    if (
      resultMessageIndex === undefined ||
      duplicateCalls.has(toolCallId) ||
      duplicateResults.has(toolCallId)
    ) {
      continue;
    }

    const result = messages[resultMessageIndex];
    // Never let Jev discard or rewrite an image-bearing tool result.
    if (result.role !== "toolResult" || !isTextOnly(result.content)) continue;
    pairs.push({ toolCallId, callMessageIndex, resultMessageIndex });
  }
  return pairs;
}

function toJevMessages(messages: readonly AgentMessage[], pairs: readonly Pair[]): JevMessage[] {
  const eligible = new Set(pairs.map((pair) => pair.toolCallId));

  return messages.map((message) => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        text: messageText(message),
        toolUses: message.content.flatMap((block) =>
          block.type === "toolCall" && eligible.has(block.id)
            ? [{ tool_use_id: block.id, tool: block.name, input: block.arguments }]
            : [],
        ),
      };
    }

    if (message.role === "toolResult") {
      if (eligible.has(message.toolCallId)) {
        return {
          role: "user",
          text: "",
          toolUses: [],
          toolResults: [{
            tool_use_id: message.toolCallId,
            text: contentText(message.content),
            isError: message.isError,
          }],
        };
      }

      // Unpaired or ineligible results must not become user text or goals in
      // Jev's state; the original Pi message is preserved on output.
      return { role: "user", text: "", toolUses: [] };
    }

    return { role: "user", text: messageText(message), toolUses: [] };
  });
}

function truncateTextContent(content: readonly TextContent[], headChars: number, isError: boolean): TextContent[] {
  const fullText = content.map((block) => block.text).join("\n");
  if (fullText.length <= headChars + 120) return [...content];

  const kept: TextContent[] = [];
  let remaining = headChars;
  for (const block of content) {
    if (remaining <= 0) break;
    if (block.text.length <= remaining) {
      kept.push(block);
      remaining -= block.text.length;
    } else {
      kept.push({ type: "text", text: block.text.slice(0, remaining) });
      remaining = 0;
    }
  }
  const omitted = fullText.length - headChars;
  kept.push({
    type: "text",
    text: `[fast-jev-compaction truncated ${omitted} chars of this tool result${isError ? " (error)" : ""}; re-run the tool if needed]`,
  });
  return kept;
}

function decisionActions(decisions: readonly CallDecision[], pairs: readonly Pair[]): Map<string, CallDecision["action"]> {
  const byIndex = new Map<number, string>();
  pairs.forEach((pair, index) => byIndex.set(index + 1, pair.toolCallId));
  const actions = new Map<string, CallDecision["action"]>();

  for (const decision of decisions) {
    const index = Number.parseInt(decision.id.slice(1), 10);
    const toolCallId = byIndex.get(index);
    if (toolCallId && decision.action !== "keep") actions.set(toolCallId, decision.action);
  }
  return actions;
}

function applyActions(
  messages: readonly AgentMessage[],
  actions: ReadonlyMap<string, CallDecision["action"]>,
  headChars: number,
  candidateCalls: number,
): FilterResult {
  if (actions.size === 0) {
    return { messages: [...messages], changed: false, candidateCalls, droppedCalls: 0, truncatedResults: 0 };
  }

  let changed = false;
  let droppedCalls = 0;
  let truncatedResults = 0;
  const filtered: AgentMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const content = message.content.filter(
        (block) => block.type !== "toolCall" || actions.get(block.id) !== "drop_call",
      );
      const removed = content.length !== message.content.length;
      if (removed) droppedCalls += message.content.length - content.length;
      if (content.length === 0) {
        changed ||= removed;
        continue;
      }
      if (removed) {
        changed = true;
        filtered.push({ ...message, content });
      } else {
        filtered.push(message);
      }
      continue;
    }

    if (message.role === "toolResult") {
      const action = actions.get(message.toolCallId);
      if (action === "drop_call") {
        changed = true;
        continue;
      }
      if (action === "drop_result" && isTextOnly(message.content)) {
        const content = truncateTextContent(message.content, headChars, message.isError);
        if (content.length !== message.content.length || content.some((block, index) => block !== message.content[index])) {
          changed = true;
          truncatedResults++;
          filtered.push({ ...message, content } as ToolResultMessage);
        } else {
          filtered.push(message);
        }
        continue;
      }
    }

    filtered.push(message);
  }

  return { messages: filtered, changed, candidateCalls, droppedCalls, truncatedResults };
}

/**
 * Ask Jev for a single native Pi compaction region, then map its decisions back
 * onto the original Pi messages. The simple upstream transcript is never used
 * to reconstruct Pi output.
 */
export async function filterMessages(
  messages: readonly AgentMessage[],
  options: FilterOptions,
): Promise<FilterResult> {
  const pairs = collectPairs(messages);
  if (pairs.length === 0) {
    return { messages: [...messages], changed: false, candidateCalls: 0, droppedCalls: 0, truncatedResults: 0 };
  }

  const compactOptions = resolveOptions(options.compactOptions ?? {});
  const result = await rejectOnAbort(
    compact(toJevMessages(messages, pairs), options.asker, compactOptions),
    options.signal,
  );
  const reviewedCalls = result.decisions.filter((decision) => decision.reason !== "pinned").length;
  return applyActions(
    messages,
    decisionActions(result.decisions, pairs),
    compactOptions.truncateHeadChars,
    reviewedCalls,
  );
}

/** Filter Pi's two native summary inputs independently; their boundaries stay intact. */
export async function filterPreparation(
  messagesToSummarize: readonly AgentMessage[],
  turnPrefixMessages: readonly AgentMessage[],
  options: FilterOptions,
): Promise<PreparationFilterResult> {
  const history = await filterMessages(messagesToSummarize, options);
  const prefix = await filterMessages(turnPrefixMessages, options);
  return {
    messagesToSummarize: history.messages,
    turnPrefixMessages: prefix.messages,
    changed: history.changed || prefix.changed,
    candidateCalls: history.candidateCalls + prefix.candidateCalls,
    droppedCalls: history.droppedCalls + prefix.droppedCalls,
    truncatedResults: history.truncatedResults + prefix.truncatedResults,
  };
}
