import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { JevAsker } from "fast-jev-compaction";
import {
  createDeadline,
  filterMessages,
  filterPreparation,
  type TimerApi,
} from "../src/adapter.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage,
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function toolResult(id: string, text: string, timestamp = 2): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

function decisionAsker(actions: Record<string, { call: number; result: number }>): JevAsker {
  return {
    async ask(_state, questions) {
      const answers: Record<string, { noul: number }> = {};
      for (const question of Object.keys(questions)) {
        const [, id] = question.split("_");
        const action = actions[id] ?? { call: 1, result: 1 };
        answers[question] = { noul: question.startsWith("call_") ? action.call : action.result };
      }
      return { answers };
    },
  };
}

test("maps upstream decisions onto native Pi messages without rebuilding thinking", async () => {
  const source = assistant([
    { type: "thinking", thinking: "keep this native reasoning", thinkingSignature: "opaque" },
    { type: "toolCall", id: "drop", name: "read", arguments: { path: "old.ts" } },
    { type: "toolCall", id: "truncate", name: "read", arguments: { path: "still-useful.ts" } },
  ]);
  const original: AgentMessage[] = [
    { role: "user", content: "Investigate", timestamp: 0 },
    source,
    toolResult("drop", "discard this output"),
    toolResult("truncate", "x".repeat(800), 3),
    { role: "user", content: "Continue", timestamp: 4 },
  ];

  const result = await filterMessages(original, {
    asker: decisionAsker({
      t1: { call: 0, result: 0 },
      t2: { call: 1, result: 0 },
    }),
    compactOptions: { preserveRecentMessages: 0, truncateHeadChars: 20 },
  });

  assert.equal(result.changed, true);
  assert.equal(result.droppedCalls, 1);
  assert.equal(result.truncatedResults, 1);
  assert.equal(result.messages.length, 4);
  const mappedAssistant = result.messages[1];
  assert.equal(mappedAssistant.role, "assistant");
  assert.equal(mappedAssistant.content[0], source.content[0]);
  assert.deepEqual(
    mappedAssistant.content.filter((block) => block.type === "toolCall").map((block) => block.id),
    ["truncate"],
  );
  const truncated = result.messages[2];
  assert.equal(truncated.role, "toolResult");
  assert.match(truncated.content.map((block) => block.type === "text" ? block.text : "").join(""), /truncated 780 chars/);
  assert.equal(original[1], source);
  assert.equal((original[1] as Extract<AgentMessage, { role: "assistant" }>).content.length, 3);
});

test("protects image tool results and leaves incomplete cross-boundary pairs unchanged", async () => {
  const imageResult: AgentMessage = {
    role: "toolResult",
    toolCallId: "image",
    toolName: "screenshot",
    content: [{ type: "image", data: "base64", mimeType: "image/png" }],
    isError: false,
    timestamp: 2,
  };
  const imageMessages: AgentMessage[] = [
    assistant([{ type: "toolCall", id: "image", name: "screenshot", arguments: {} }]),
    imageResult,
  ];
  const imageResultFiltered = await filterMessages(imageMessages, { asker: decisionAsker({}) });
  assert.equal(imageResultFiltered.changed, false);
  assert.equal(imageResultFiltered.messages[0], imageMessages[0]);
  assert.equal(imageResultFiltered.messages[1], imageResult);

  const callOnly: AgentMessage[] = [
    assistant([{ type: "toolCall", id: "across", name: "read", arguments: {} }]),
  ];
  const resultOnly: AgentMessage[] = [toolResult("across", "must stay")];
  const split = await filterPreparation(callOnly, resultOnly, {
    asker: decisionAsker({ t1: { call: 0, result: 0 } }),
    compactOptions: { preserveRecentMessages: 0 },
  });
  assert.equal(split.changed, false);
  assert.equal(split.messagesToSummarize[0], callOnly[0]);
  assert.equal(split.turnPrefixMessages[0], resultOnly[0]);
});

test("filters both native summary inputs independently", async () => {
  const history: AgentMessage[] = [
    { role: "user", content: "history", timestamp: 0 },
    assistant([{ type: "toolCall", id: "history", name: "read", arguments: {} }]),
    toolResult("history", "history result"),
  ];
  const prefix: AgentMessage[] = [
    { role: "user", content: "prefix", timestamp: 0 },
    assistant([{ type: "toolCall", id: "prefix", name: "read", arguments: {} }]),
    toolResult("prefix", "prefix result"),
  ];

  const result = await filterPreparation(history, prefix, {
    asker: decisionAsker({ t1: { call: 0, result: 0 } }),
    compactOptions: { preserveRecentMessages: 0 },
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.messagesToSummarize, [{ role: "user", content: "history", timestamp: 0 }]);
  assert.deepEqual(result.turnPrefixMessages, [{ role: "user", content: "prefix", timestamp: 0 }]);
  assert.equal(result.droppedCalls, 2);
});

test("timeout rejects before a late Jev result can affect either input", async () => {
  let timeout: (() => void) | undefined;
  const timers: TimerApi = {
    setTimeout(callback) {
      timeout = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout() {},
  };
  let resolveLate: ((value: { answers: Record<string, { noul: number }> }) => void) | undefined;
  const lateAsker: JevAsker = {
    ask() {
      return new Promise((resolve) => {
        resolveLate = resolve;
      });
    },
  };
  const controller = new AbortController();
  const deadline = createDeadline(controller.signal, 15_000, timers);
  const messages: AgentMessage[] = [
    assistant([{ type: "toolCall", id: "late", name: "read", arguments: {} }]),
    toolResult("late", "late output"),
  ];
  const original = [...messages];
  const pending = filterMessages(messages, {
    asker: lateAsker,
    compactOptions: { preserveRecentMessages: 0 },
    signal: deadline.signal,
  });

  timeout?.();
  await assert.rejects(pending, { name: "AbortError" });
  resolveLate?.({ answers: { call_t1: { noul: 0 }, result_t1: { noul: 0 } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, original);
  deadline.dispose();
});

test("Jev failure leaves the original messages available for native compaction", async () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "fail", timestamp: 0 },
    assistant([{ type: "toolCall", id: "fail", name: "read", arguments: {} }]),
    toolResult("fail", "output"),
  ];
  const original = [...messages];
  await assert.rejects(filterMessages(messages, {
    asker: { async ask() { throw new Error("network failure"); } },
    compactOptions: { preserveRecentMessages: 0 },
  }));
  assert.deepEqual(messages, original);
});
