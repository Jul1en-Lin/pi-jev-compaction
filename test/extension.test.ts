import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JevAsker } from "fast-jev-compaction";
import { formatElapsed, install, parseTimeout } from "../extensions/fast-jev-compaction.js";

const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolPair(id: string): AgentMessage[] {
  return [
    { role: "user", content: "Inspect the tool output", timestamp: 0 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name: "read", arguments: {} }],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage,
      stopReason: "toolUse",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: [{ type: "text", text: "unused" }],
      isError: false,
      timestamp: 2,
    },
    ...Array.from({ length: 6 }, (_, index) => ({
      role: "user" as const,
      content: `recent ${index}`,
      timestamp: index + 3,
    })),
  ];
}

const dropAsker: JevAsker = {
  async ask(_state, questions) {
    return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 0 }])) };
  },
};

const keepAsker: JevAsker = {
  async ask(_state, questions) {
    return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 1 }])) };
  },
};

const oneLineWithTimes = (body: string) => new RegExp(`^\\[jev\\] ${body} · \\d+(ms|\\.\\d+s); .*\\.$`);

test("one shared session_before_compact hook handles manual and automatic preparation without metadata changes", async () => {
  let handler: ((event: any, ctx: any) => Promise<void>) | undefined;
  const pi = {
    on(event: string, callback: (event: any, ctx: any) => Promise<void>) {
      assert.equal(event, "session_before_compact");
      assert.equal(handler, undefined);
      handler = callback;
    },
  } as unknown as ExtensionAPI;
  install(pi, { asker: dropAsker });
  assert.ok(handler);

  for (const reason of ["manual", "threshold"] as const) {
    const history = toolPair(`${reason}-history`);
    const prefix = toolPair(`${reason}-prefix`);
    const firstKeptEntryId = "kept";
    const tokensBefore = 123;
    const fileOps = { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
    const settings = { enabled: true, reserveTokens: 1, keepRecentTokens: 1 };
    const preparation = {
      messagesToSummarize: history,
      turnPrefixMessages: prefix,
      firstKeptEntryId,
      tokensBefore,
      fileOps,
      settings,
      isSplitTurn: true,
      previousSummary: "previous",
    };
    const notifications: string[] = [];
    await handler!({ preparation, reason, signal: new AbortController().signal }, {
      ui: { notify(message: string) { notifications.push(message); } },
    });

    assert.equal(preparation.messagesToSummarize.length, 7);
    assert.equal(preparation.turnPrefixMessages.length, 7);
    assert.ok(preparation.messagesToSummarize.every((message) => message.role === "user"));
    assert.ok(preparation.turnPrefixMessages.every((message) => message.role === "user"));
    assert.equal(preparation.firstKeptEntryId, firstKeptEntryId);
    assert.equal(preparation.tokensBefore, tokensBefore);
    assert.equal(preparation.fileOps, fileOps);
    assert.equal(preparation.settings, settings);
    assert.equal(preparation.isSplitTurn, true);
    assert.equal(preparation.previousSummary, "previous");
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]!, oneLineWithTimes("2 call\\(s\\) reviewed: dropped 2, shortened 0"));
  }
});

test("failure and user cancellation leave the native preparation untouched", async () => {
  const handlers: Array<(event: any, ctx: any) => Promise<void>> = [];
  const pi = { on(_event: string, callback: (event: any, ctx: any) => Promise<void>) { handlers.push(callback); } } as unknown as ExtensionAPI;
  install(pi, { asker: { async ask() { throw new Error("network failure"); } } });
  const failedHistory = toolPair("failed-history");
  const failedPrefix = toolPair("failed-prefix");
  const failedPreparation = { messagesToSummarize: failedHistory, turnPrefixMessages: failedPrefix };
  const failedNotifications: string[] = [];
  await handlers[0]!({ preparation: failedPreparation, signal: new AbortController().signal }, {
    ui: { notify(message: string) { failedNotifications.push(message); } },
  });
  assert.equal(failedPreparation.messagesToSummarize, failedHistory);
  assert.equal(failedPreparation.turnPrefixMessages, failedPrefix);
  assert.equal(failedNotifications.length, 1);
  assert.match(failedNotifications[0]!, oneLineWithTimes("failed"));

  const cancelledPi = { on(_event: string, callback: (event: any, ctx: any) => Promise<void>) { handlers.push(callback); } } as unknown as ExtensionAPI;
  install(cancelledPi, { asker: { ask() { return new Promise<never>(() => {}); } } });
  const cancelledHistory = toolPair("cancelled-history");
  const cancelledPrefix = toolPair("cancelled-prefix");
  const cancelledPreparation = { messagesToSummarize: cancelledHistory, turnPrefixMessages: cancelledPrefix };
  const controller = new AbortController();
  const cancelledNotifications: string[] = [];
  const pending = handlers[1]!({ preparation: cancelledPreparation, signal: controller.signal }, {
    ui: { notify(message: string) { cancelledNotifications.push(message); } },
  });
  controller.abort();
  await pending;
  assert.equal(cancelledPreparation.messagesToSummarize, cancelledHistory);
  assert.equal(cancelledPreparation.turnPrefixMessages, cancelledPrefix);
  assert.deepEqual(cancelledNotifications, []);
});

test("a run that prunes nothing still prints one line and changes no preparation field", async () => {
  let handler: ((event: any, ctx: any) => Promise<void>) | undefined;
  const pi = { on(_event: string, callback: (event: any, ctx: any) => Promise<void>) { handler = callback; } } as unknown as ExtensionAPI;
  install(pi, { asker: keepAsker });

  const messagesToSummarize = toolPair("keep-history");
  const turnPrefixMessages = toolPair("keep-prefix");
  const preparation = { messagesToSummarize, turnPrefixMessages };
  const notifications: string[] = [];
  await handler!({ preparation, signal: new AbortController().signal }, {
    ui: { notify(message: string) { notifications.push(message); } },
  });

  assert.equal(preparation.messagesToSummarize, messagesToSummarize);
  assert.equal(preparation.turnPrefixMessages, turnPrefixMessages);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]!, oneLineWithTimes("2 call\\(s\\) reviewed: nothing dropped"));
});

test("invalid timeout configuration retains the 15 second default", () => {
  assert.equal(parseTimeout(undefined), 15_000);
  assert.equal(parseTimeout("not-a-number"), 15_000);
  assert.equal(parseTimeout("0"), 15_000);
  assert.equal(parseTimeout("250"), 250);
});

test("elapsed time stays short in the console line", () => {
  assert.equal(formatElapsed(0), "0ms");
  assert.equal(formatElapsed(955), "955ms");
  assert.equal(formatElapsed(1000), "1.0s");
  assert.equal(formatElapsed(15_400), "15.4s");
});
