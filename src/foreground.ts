// A foreground subagent tool: the parent's tool call creates a child conversation it owns, runs one task there, and
// returns the child's answer. Aborting the tool call aborts the child. A UI finds the child through the tool's running
// details and shows its events under the call.
// Uses OpenAI when OPENAI_API_KEY is set, and a scripted faux model otherwise.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/22-subagent-foreground.ts
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, type FauxResponseStep, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	type AgentEvent,
	AssistantEntry,
	type ConversationId,
	configure,
	createRegistry,
	defineExtension,
	defineTool,
	type EntryId,
	type Extension,
	Harness,
	MemoryStorage,
	type ToolExecutionApi,
	watchEvents,
} from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

// ─── Product code: the subagent extension ───────────────────────────────────

async function answerText(api: ToolExecutionApi, answer: EntryId, callContext: Context): Promise<string> {
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), callContext);
	const message = entry?.model?.[0] as AssistantMessage;
	return message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}

export const Subagent: Extension = defineExtension({
	name: "subagent",
	tools: [
		defineTool({
			name: "subagent",
			description: "Delegate a self-contained task to a subagent and get its answer back.",
			parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 100000, description: "What the subagent should do" }) }),
			// Safe to rerun after a crash: a rerun finds the child it already created and the submission it already made.
			replay: "safe",
			execute: async (args, api, callContext) => {
				const { task } = args;
 if (!task.trim()) throw new Error("task must not be blank");
				// The child is owned by this tool call's task, so aborting the call aborts the child, and the call
				// finishes only once the child's work is done.
				const child = await api.commit(async (tx) => {
					// Ownership records the child: a rerun of this call finds it instead of creating another.
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					// Starts as a copy of this conversation's agent: model, thinking level, cwd, extensions, tools.
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					// Without this extension, the child is not offered this tool.
					await configure(tx, created.id, { extensions: { remove: [Subagent] } });
					return created.id;
				}, callContext);
				// A UI watching the parent sees this and can attach to the child.
				await api.details({ conversationId: child }, callContext);

				const handle = (await api.conversation(child, callContext))!;
				// The request ID makes a rerun get back the submission it made before the crash.
				const request = { type: "input", content: task, requestId: `subagent:${api.taskId}` } as const;
				const settled = await (await handle.submit(request, callContext)).wait(callContext);
				if (settled.status !== "done" || settled.type !== "input") {
					throw new Error(`Subagent failed: ${settled.status}`);
				}
				const text = await answerText(api, settled.answer, callContext);
				return { content: [{ type: "text", text }], details: { conversationId: child } };
			},
		}),
	],
});

