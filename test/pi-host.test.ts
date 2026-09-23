import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { JevAsker } from "fast-jev-compaction";
import { install } from "../extensions/fast-jev-compaction.js";

const usage = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Use the installed host's entry point, not a second copy of the local SDK.
const hostPath = process.env.PI_TEST_HOST_PATH;
const host = hostPath
  ? await import(pathToFileURL(`${hostPath}/dist/index.js`).href) as typeof import("@earendil-works/pi-coding-agent")
  : await import("@earendil-works/pi-coding-agent");

test(`Pi ${host.VERSION} uses filtered preparation for native manual compaction`, async () => {
  const cwd = "/tmp";
  const agentDir = "/tmp/pi-jev-host-smoke-unused";
  const manager = host.SessionManager.inMemory(cwd);
  const settings = host.SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 256, keepRecentTokens: 1 },
    retry: { enabled: false },
  });
  const loader = new host.DefaultResourceLoader({
    cwd, agentDir, settingsManager: settings, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true, noExtensions: true,
    extensionFactories: [(pi) => install(pi, {
      asker: {
        async ask(_state, questions) {
          assert.ok(Object.keys(questions).length > 0, "Jev received candidate calls");
          return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: key.endsWith("_t1") ? 0 : 1 }])) };
        },
      } satisfies JevAsker,
    })],
  });
  await loader.reload();
  const runtime = await host.ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, authPath: `${agentDir}/no-auth.json` });
  const model = runtime.getModels("anthropic")[0];
  assert.ok(model, "static host model must be available offline");
  const { session } = await host.createAgentSession({
    cwd, agentDir, resourceLoader: loader, sessionManager: manager, settingsManager: settings,
    modelRuntime: runtime, model, noTools: "all", thinkingLevel: "off",
  });
  try {
    const tool = (id: string, sentinel: string): void => {
      const call: AssistantMessage = {
        role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: {} }],
        api: model.api, provider: model.provider, model: model.id,
        usage, stopReason: "toolUse", timestamp: 1,
      };
      manager.appendMessage(call);
      manager.appendMessage({
        role: "toolResult", toolCallId: id, toolName: "read",
        content: [{ type: "text", text: sentinel }], isError: false, timestamp: 2,
      });
    };
    manager.appendMessage({ role: "user", content: "Earlier work", timestamp: 0 });
    tool("drop", "DROP_SENTINEL");
    tool("keep", "KEEP_SENTINEL");
    for (let i = 0; i < 6; i++) {
      manager.appendMessage({ role: "user", content: `recent ${i}`, timestamp: i + 3 });
    }
    const retainedId = manager.appendMessage({ role: "user", content: "Retained context", timestamp: 10 });
    const requests: string[] = [];
    session.agent.streamFunction = ((_model: unknown, context: { messages: unknown[] }) => ({
      result: async () => {
        const prompt = JSON.stringify(context.messages);
        requests.push(prompt);
        return {
          role: "assistant", content: [{ type: "text", text: "Offline native summary" }],
          api: model.api, provider: model.provider, model: model.id, usage,
          stopReason: "stop", timestamp: 11,
        } as AssistantMessage;
      },
    })) as unknown as typeof session.agent.streamFunction;

    const result = await session.compact();
    assert.equal(requests.length, 1);
    assert.doesNotMatch(requests[0]!, /DROP_SENTINEL/);
    assert.match(requests[0]!, /KEEP_SENTINEL/);
    const entry = manager.getBranch().at(-1);
    assert.equal(entry?.type, "compaction");
    assert.equal(entry.summary, result.summary);
    assert.equal(entry.firstKeptEntryId, retainedId);
    assert.equal(entry.fromHook, false);
    assert.deepEqual(entry.details, { readFiles: [], modifiedFiles: [] });
    assert.deepEqual(entry.usage, usage);
    assert.equal(entry.tokensBefore, result.tokensBefore);
    assert.ok(manager.buildSessionContext().messages.some((message: AgentMessage) =>
      message.role === "user" && message.content === "Retained context"));
  } finally {
    session.dispose();
  }
});
