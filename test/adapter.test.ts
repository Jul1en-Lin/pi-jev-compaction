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

test("normalizes truncation options before rewriting native results", async (t) => {
  for (const { label, value, headChars, omittedChars } of [
    { label: "default", value: undefined, headChars: 300, omittedChars: 700 },
    { label: "negative", value: -1, headChars: 0, omittedChars: 1000 },
    { label: "zero", value: 0, headChars: 0, omittedChars: 1000 },
    { label: "NaN", value: Number.NaN, headChars: 300, omittedChars: 700 },
    { label: "Infinity", value: Number.POSITIVE_INFINITY, headChars: 300, omittedChars: 700 },
    { label: "fractional", value: 3.7, headChars: 3, omittedChars: 997 },
  ]) {
    await t.test(label, async () => {
      const source = toolResult("truncate", "x".repeat(1000));
      const call = assistant([{ type: "toolCall", id: "truncate", name: "read", arguments: {} }]);
      const messages: AgentMessage[] = [
        { role: "user", content: "original goal", timestamp: 0 },
        call,
        source,
      ];
      let asked = false;
      const result = await filterMessages(messages, {
        asker: {
          async ask(state, questions) {
            asked = true;
            assert.ok(typeof state === "object" && "goal" in state);
            assert.equal(state.goal, "explicit compaction goal");
            assert.deepEqual(Object.keys(questions).sort(), ["call_t1", "result_t1"]);
            return { answers: { call_t1: { noul: 1 }, result_t1: { noul: 0.7 } } };
          },
        },
        compactOptions: {
          preserveRecentMessages: 0,
          truncateHeadChars: value,
          goal: "explicit compaction goal",
          keepThreshold: 0.8,
        },
      });

      assert.equal(asked, true);
      assert.equal(result.changed, true);
      assert.equal(result.candidateCalls, 1);
      assert.equal(result.droppedCalls, 0);
      assert.equal(result.truncatedResults, 1);
      assert.equal(result.messages[1], call);
      const rewritten = result.messages[2];
      assert.equal(rewritten.role, "toolResult");
      assert.deepEqual(rewritten.content, [
        ...(headChars > 0 ? [{ type: "text", text: "x".repeat(headChars) }] : []),
        {
          type: "text",
          text: `[fast-jev-compaction truncated ${omittedChars} chars of this tool result; re-run the tool if needed]`,
        },
      ]);
      assert.equal(source.role, "toolResult");
      assert.deepEqual(source.content, [{ type: "text", text: "x".repeat(1000) }]);
      assert.equal(messages[2], source);
    });
  }
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

test("filters both native summary inputs independently while preserving a cross-input pair", async () => {
  const crossCall = assistant([{ type: "toolCall", id: "across", name: "read", arguments: {} }]);
  const crossText = "Cross-input tool output is not the user goal";
  const crossResult = toolResult("across", crossText);
  const history: AgentMessage[] = [
    { role: "user", content: "history", timestamp: 0 },
    assistant([{ type: "toolCall", id: "history", name: "read", arguments: {} }]),
    toolResult("history", "history result"),
    crossCall,
  ];
  const prefix: AgentMessage[] = [
    { role: "user", content: "prefix", timestamp: 0 },
    assistant([{ type: "toolCall", id: "prefix", name: "read", arguments: {} }]),
    toolResult("prefix", "prefix result"),
    crossResult,
  ];
  const original = structuredClone({ history, prefix });
  const observedGoals: unknown[] = [];
  const result = await filterPreparation(history, prefix, {
    asker: {
      async ask(state, questions) {
        assert.ok(typeof state === "object" && "goal" in state);
        observedGoals.push(state.goal);
        assert.equal(JSON.stringify(state).includes(crossText), false);
        assert.deepEqual(Object.keys(questions).sort(), ["call_t1", "result_t1"]);
        return { answers: { call_t1: { noul: 0 }, result_t1: { noul: 0 } } };
      },
    },
    compactOptions: { preserveRecentMessages: 0 },
  });

  assert.deepEqual(observedGoals, ["history", "prefix"]);
  assert.equal(result.changed, true);
  assert.equal(result.candidateCalls, 2);
  assert.equal(result.droppedCalls, 2);
  assert.equal(result.truncatedResults, 0);
  assert.deepEqual(result.messagesToSummarize, [history[0], crossCall]);
  assert.deepEqual(result.turnPrefixMessages, [prefix[0], crossResult]);
  assert.equal(result.messagesToSummarize[0], history[0]);
  assert.equal(result.messagesToSummarize[1], crossCall);
  assert.equal(result.turnPrefixMessages[0], prefix[0]);
  assert.equal(result.turnPrefixMessages[1], crossResult);
  assert.deepEqual({ history, prefix }, original);
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

test("does not count pinned pairs as reviewed", async () => {
  const messages: AgentMessage[] = [
    assistant([{ type: "toolCall", id: "pinned", name: "read", arguments: {} }]),
    toolResult("pinned", "pinned output"),
  ];
  let asked = false;
  const result = await filterMessages(messages, {
    asker: {
      async ask() {
        asked = true;
        return { answers: {} };
      },
    },
  });

  assert.equal(asked, false);
  assert.equal(result.candidateCalls, 0);
  assert.equal(result.changed, false);
});

test("counts only reviewed calls across batches with first and recent pairs pinned", async () => {
  const firstCall = assistant([{ type: "toolCall", id: "first", name: "read", arguments: {} }]);
  const firstResult = toolResult("first", "first output");
  const recentCall = assistant([{ type: "toolCall", id: "recent", name: "read", arguments: {} }]);
  const recentResult = toolResult("recent", "recent output");
  const goal: AgentMessage = { role: "user", content: "goal", timestamp: 0 };
  const messages: AgentMessage[] = [
    firstCall,
    firstResult,
    goal,
    ...Array.from({ length: 4 }, (_, index) => [
      assistant([{ type: "toolCall" as const, id: `old-${index}`, name: "read", arguments: {} }]),
      toolResult(`old-${index}`, "old output"),
    ]).flat(),
    recentCall,
    recentResult,
  ];
  const questionBatches: string[][] = [];
  const result = await filterMessages(messages, {
    asker: {
      async ask(_state, questions) {
        questionBatches.push(Object.keys(questions));
        return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 0 }])) };
      },
    },
    compactOptions: { preserveRecentMessages: 2, maxRequestTokens: 1000 },
  });

  assert.ok(questionBatches.length > 1, "must exercise multiple Jev batches");
  assert.deepEqual(questionBatches.flat().sort(), [
    "call_t2", "call_t3", "call_t4", "call_t5",
    "result_t2", "result_t3", "result_t4", "result_t5",
  ]);
  assert.equal(result.candidateCalls, 4);
  assert.equal(result.droppedCalls, 4);
  assert.equal(result.truncatedResults, 0);
  assert.equal(result.changed, true);
  const expected = [firstCall, firstResult, goal, recentCall, recentResult];
  assert.deepEqual(result.messages, expected);
  result.messages.forEach((message, index) => assert.equal(message, expected[index]));
});

test("preserves ineligible results without treating their text as Jev history or goals", async (t) => {
  const excludedText = "This tool output is not a user instruction";
  const excludedCall = assistant([{ type: "toolCall", id: "excluded", name: "read", arguments: {} }]);
  const scenarios: Array<{ label: string; excluded: AgentMessage[] }> = [
    { label: "orphan result", excluded: [toolResult("excluded", excludedText)] },
    {
      label: "image-bearing result with text",
      excluded: [excludedCall, {
        role: "toolResult",
        toolCallId: "excluded",
        toolName: "read",
        content: [
          { type: "text", text: excludedText },
          { type: "image", data: "base64", mimeType: "image/png" },
        ],
        isError: false,
        timestamp: 2,
      }],
    },
    {
      label: "duplicate call IDs",
      excluded: [
        excludedCall,
        assistant([{ type: "toolCall", id: "excluded", name: "read", arguments: {} }]),
        toolResult("excluded", excludedText),
      ],
    },
    {
      label: "duplicate result IDs",
      excluded: [excludedCall, toolResult("excluded", excludedText), toolResult("excluded", excludedText)],
    },
  ];

  for (const { label, excluded } of scenarios) {
    await t.test(label, async () => {
      const goal: AgentMessage = { role: "user", content: "Investigate the actual user request", timestamp: 0 };
      const messages: AgentMessage[] = [
        goal,
        ...excluded,
        assistant([{ type: "toolCall", id: "paired", name: "read", arguments: {} }]),
        toolResult("paired", "paired output"),
      ];
      const original = structuredClone(messages);
      let requests = 0;
      const result = await filterMessages(messages, {
        asker: {
          async ask(state, questions) {
            requests++;
            assert.ok(typeof state === "object" && "goal" in state);
            assert.equal(state.goal, "Investigate the actual user request");
            assert.equal(JSON.stringify(state).includes(excludedText), false);
            assert.deepEqual(Object.keys(questions).sort(), ["call_t1", "result_t1"]);
            return { answers: { call_t1: { noul: 0 }, result_t1: { noul: 0 } } };
          },
        },
        compactOptions: { preserveRecentMessages: 0 },
      });

      assert.equal(requests, 1, "must reach Jev instead of returning early");
      assert.equal(result.changed, true);
      assert.equal(result.candidateCalls, 1);
      assert.equal(result.droppedCalls, 1);
      assert.equal(result.truncatedResults, 0);
      const expected = [goal, ...excluded];
      assert.deepEqual(result.messages, expected);
      result.messages.forEach((message, index) => assert.equal(message, expected[index]));
      assert.deepEqual(messages, original);
    });
  }
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
