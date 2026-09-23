import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JevAsker } from "fast-jev-compaction";
import { formatElapsed, install, parseTimeout } from "../extensions/fast-jev-compaction.js";

const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolCall(id: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "read", arguments: {} }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage,
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function toolResult(id: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text: "unused" }],
    isError: false,
    timestamp: 2,
  };
}

function toolPair(id: string): AgentMessage[] {
  return [
    { role: "user", content: "Inspect the tool output", timestamp: 0 },
    toolCall(id),
    toolResult(id),
    ...Array.from({ length: 6 }, (_, index) => ({
      role: "user" as const,
      content: `recent ${index}`,
      timestamp: index + 3,
    })),
  ];
}

function mixedPairs(id: string): AgentMessage[] {
  return [
    toolCall(`${id}-pinned`),
    toolResult(`${id}-pinned`),
    toolCall(`${id}-candidate`),
    toolResult(`${id}-candidate`),
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

test("a different Pi version does not disable filtering", () => {
  for (const version of ["0.87.1", "0.99.0"]) {
    const script = `
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "@earendil-works/pi-coding-agent") {
            return { url: 'data:text/javascript,export const VERSION = ${JSON.stringify(version)}', shortCircuit: true };
          }
          return nextResolve(specifier, context);
        },
      });
      const { install } = await import(${JSON.stringify(new URL("../extensions/fast-jev-compaction.js", import.meta.url).href)});
      const preparation = ${JSON.stringify({ messagesToSummarize: toolPair("version"), turnPrefixMessages: [] })};
      let handler;
      let asked = false;
      const notifications = [];
      install({ on(_event, callback) { handler = callback; } }, {
        asker: { async ask(_state, questions) {
          asked = true;
          return { answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: 0 }])) };
        } },
      });
      await handler({ preparation, signal: new AbortController().signal }, {
        ui: { notify(message) { notifications.push(message); } },
      });
      assert.equal(asked, true, notifications.join("\\n"));
      assert.equal(preparation.messagesToSummarize.length, 7);
      assert.match(notifications[0], /dropped 1/);
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
    assert.equal(result.status, 0, `Pi ${version}: ${result.stderr}`);
  }
});

test("incompatible preparation skips Jev without changing either input", async () => {
  const history = toolPair("incompatible-history");
  const prefix = toolPair("incompatible-prefix");
  const frozen = Object.freeze({ messagesToSummarize: history, turnPrefixMessages: prefix });
  const readonlyPrefix = Object.defineProperty(
    { messagesToSummarize: history, turnPrefixMessages: prefix },
    "turnPrefixMessages", { writable: false },
  );
  const readonlyHistory = Object.defineProperty(
    { messagesToSummarize: history, turnPrefixMessages: prefix },
    "messagesToSummarize", { writable: false },
  );
  const accessorPrefix = {
    messagesToSummarize: history,
    get turnPrefixMessages() { throw new Error("must not invoke an incompatible getter"); },
  };
  for (const preparation of [
    undefined, null, {},
    { messagesToSummarize: history },
    { messagesToSummarize: history, turnPrefixMessages: "changed API" },
    { messagesToSummarize: {}, turnPrefixMessages: prefix },
    frozen, readonlyPrefix, readonlyHistory, accessorPrefix,
  ]) {
    let handler: ((event: any, ctx: any) => Promise<void>) | undefined;
    let asked = false;
    install({ on(_event: string, callback: typeof handler) { handler = callback; } } as unknown as ExtensionAPI, {
      asker: { async ask(state, questions) { asked = true; return dropAsker.ask(state, questions); } },
    });
    const before = preparation && Object.getOwnPropertyDescriptors(preparation);
    const notifications: string[] = [];
    await handler!({ preparation, signal: new AbortController().signal }, {
      ui: { notify(message: string) { notifications.push(message); } },
    });
    assert.equal(asked, false);
    assert.deepEqual(preparation && Object.getOwnPropertyDescriptors(preparation), before);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]!, /incompatible.*native compaction/);
  }
});

test("readonly arrays remain compatible when their preparation fields are writable", async () => {
  let handler: ((event: any, ctx: any) => Promise<void>) | undefined;
  install({ on(_event: string, callback: typeof handler) { handler = callback; } } as unknown as ExtensionAPI, {
    asker: dropAsker,
  });
  const history = Object.freeze(toolPair("frozen-history"));
  const prefix = Object.freeze(toolPair("frozen-prefix"));
  const preparation = Object.seal({ messagesToSummarize: history, turnPrefixMessages: prefix });
  await handler!({ preparation, signal: new AbortController().signal }, { ui: { notify() {} } });
  assert.equal(preparation.messagesToSummarize.length, 7);
  assert.equal(preparation.turnPrefixMessages.length, 7);
  assert.equal(history.length, 9);
  assert.equal(prefix.length, 9);
});

test("an incompatible cancellation signal skips Jev", async () => {
  for (const signal of [undefined, null, {}]) {
    let handler: ((event: any, ctx: any) => Promise<void>) | undefined;
    let asked = false;
    install({ on(_event: string, callback: typeof handler) { handler = callback; } } as unknown as ExtensionAPI, {
      asker: { async ask(state, questions) { asked = true; return dropAsker.ask(state, questions); } },
    });
    const preparation = { messagesToSummarize: toolPair("signal"), turnPrefixMessages: [] };
    const before = { ...preparation };
    const notifications: string[] = [];
    await handler!({ preparation, signal }, {
      ui: { notify(message: string) { notifications.push(message); } },
    });
    assert.equal(asked, false);
    assert.equal(preparation.messagesToSummarize, before.messagesToSummarize);
    assert.equal(preparation.turnPrefixMessages, before.turnPrefixMessages);
    assert.match(notifications[0]!, /incompatible.*native compaction/);
  }
});

test("preparation made readonly during Jev is not partially replaced", async () => {
  const history = toolPair("readonly-history");
  const prefix = toolPair("readonly-prefix");
  const preparation = { messagesToSummarize: history, turnPrefixMessages: prefix };
  let handler: ((event: any, ctx: any) => Promise<void>) | undefined;
  install({ on(_event: string, callback: typeof handler) { handler = callback; } } as unknown as ExtensionAPI, {
    asker: { async ask(state, questions) {
      Object.defineProperty(preparation, "turnPrefixMessages", { writable: false });
      return dropAsker.ask(state, questions);
    } },
  });
  const notifications: string[] = [];
  await handler!({ preparation, signal: new AbortController().signal }, {
    ui: { notify(message: string) { notifications.push(message); } },
  });
  assert.equal(preparation.messagesToSummarize, history);
  assert.equal(preparation.turnPrefixMessages, prefix);
  assert.match(notifications[0]!, /incompatible.*native compaction/);
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

test("all-pinned inputs skip Jev and retain both native preparation references", async () => {
  let handler: ((event: any, ctx: any) => Promise<void>) | undefined;
  const pi = { on(_event: string, callback: (event: any, ctx: any) => Promise<void>) { handler = callback; } } as unknown as ExtensionAPI;
  install(pi, { asker: { async ask() { assert.fail("pinned calls must not be reviewed"); } } });

  const messagesToSummarize = [toolCall("history-pinned"), toolResult("history-pinned")];
  const turnPrefixMessages = [toolCall("prefix-pinned"), toolResult("prefix-pinned")];
  const preparation = { messagesToSummarize, turnPrefixMessages };
  const notifications: string[] = [];
  await handler!({ preparation, signal: new AbortController().signal }, {
    ui: { notify(message: string) { notifications.push(message); } },
  });

  assert.equal(preparation.messagesToSummarize, messagesToSummarize);
  assert.equal(preparation.turnPrefixMessages, turnPrefixMessages);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]!, oneLineWithTimes("0 call\\(s\\) reviewed: nothing dropped"));
});

test("mixed pinned calls retain native identities and report only reviewed calls", async () => {
  for (const [noul, expected, changed] of [
    [1, "nothing dropped", false],
    [0, "dropped 2, shortened 0", true],
  ] as const) {
    let handler: ((event: any, ctx: any) => Promise<void>) | undefined;
    const pi = { on(_event: string, callback: (event: any, ctx: any) => Promise<void>) { handler = callback; } } as unknown as ExtensionAPI;
    const questionsPerRequest: number[] = [];
    install(pi, {
      asker: {
        async ask(_state, questions) {
          questionsPerRequest.push(Object.keys(questions).length);
          return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul }])) };
        },
      },
    });

    const messagesToSummarize = mixedPairs("history");
    const turnPrefixMessages = mixedPairs("prefix");
    const historyPinned = messagesToSummarize.slice(0, 2);
    const prefixPinned = turnPrefixMessages.slice(0, 2);
    const preparation = { messagesToSummarize, turnPrefixMessages };
    const notifications: string[] = [];
    await handler!({ preparation, signal: new AbortController().signal }, {
      ui: { notify(message: string) { notifications.push(message); } },
    });

    assert.deepEqual(questionsPerRequest, [2, 2]);
    assert.equal(preparation.messagesToSummarize[0], historyPinned[0]);
    assert.equal(preparation.messagesToSummarize[1], historyPinned[1]);
    assert.equal(preparation.turnPrefixMessages[0], prefixPinned[0]);
    assert.equal(preparation.turnPrefixMessages[1], prefixPinned[1]);
    assert.equal(preparation.messagesToSummarize === messagesToSummarize, !changed);
    assert.equal(preparation.turnPrefixMessages === turnPrefixMessages, !changed);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]!, oneLineWithTimes(`2 call\\(s\\) reviewed: ${expected}`));
  }
});

test("default request batching reports reviewed calls rather than questions or batches", async () => {
  const calls = 500;
  let handler: ((event: any, ctx: any) => Promise<void>) | undefined;
  const pi = { on(_event: string, callback: (event: any, ctx: any) => Promise<void>) { handler = callback; } } as unknown as ExtensionAPI;
  const askedQuestions: string[] = [];
  let askCalls = 0;
  install(pi, {
    asker: {
      async ask(_state, questions) {
        askCalls++;
        const keys = Object.keys(questions);
        askedQuestions.push(...keys);
        return { answers: Object.fromEntries(keys.map((key) => [key, { noul: 1 }])) };
      },
    },
  });

  const messagesToSummarize: AgentMessage[] = [
    { role: "user", content: "start", timestamp: 0 },
    {
      ...toolCall("placeholder"),
      content: Array.from({ length: calls }, (_, index) => ({
        type: "toolCall" as const, id: `batch-${index}`, name: "read", arguments: {},
      })),
    },
    ...Array.from({ length: calls }, (_, index) => toolResult(`batch-${index}`)),
    ...Array.from({ length: 6 }, (_, index) => ({ role: "user" as const, content: `recent ${index}`, timestamp: index + 3 })),
  ];
  const preparation = { messagesToSummarize, turnPrefixMessages: [] as AgentMessage[] };
  const notifications: string[] = [];
  await handler!({ preparation, signal: new AbortController().signal }, {
    ui: { notify(message: string) { notifications.push(message); } },
  });

  assert.ok(askCalls > 1);
  assert.equal(askedQuestions.length, calls * 2);
  assert.equal(new Set(askedQuestions).size, calls * 2);
  assert.match(notifications[0]!, oneLineWithTimes(`${calls} call\\(s\\) reviewed: nothing dropped`));
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
