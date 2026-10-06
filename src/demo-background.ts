// Persistent background subagents. One `subagent` tool lets the main agent start named subagents, message them
// (steer or follow up), stop them mid-answer, and list them. Subagents keep working while the main agent
// answers the user, and each answer is delivered back to the main agent as a new message once it arrives. Everything
// survives a restart: the example closes the Harness while a subagent works and reopens it.
// Uses OpenAI when OPENAI_API_KEY is set, and a scripted faux model otherwise.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/23-subagent-background.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	Harness,
	LiveDoc,
	type TaskId,
	watchEvents,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { SubagentTools, Subagents } from "./background.js";
const context = BACKGROUND_CONTEXT;
// Host setup ─────────────────────────────────────────────────────────────

const models = createModels();
let model = { provider: "openai", modelId: process.env.OPENAI_MODEL ?? "" };
if (process.env.PI_REAL === "1") {
	if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) throw new Error("PI_REAL=1 requires OPENAI_API_KEY and OPENAI_MODEL");
 models.setProvider(openaiProvider());
} else {
	// The main agent and the subagent share one scripted model, which answers each request by its last message.
	// It streams its answers at 50 tokens per second, like a slow real model.
	const faux = fauxProvider({ tokensPerSecond: 50 });
	models.setProvider(faux.provider);
	model = { provider: "faux", modelId: "faux-1" };
	const call = (input: Record<string, string>) =>
		fauxAssistantMessage([fauxToolCall("subagent", input)], { stopReason: "toolUse" });
	const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
	const route: FauxResponseStep = (request) => {
		// System messages carry prompt changes; the request is about the message before them.
		const last = request.messages.findLast((message) => message.role !== "system")!;
		const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
		const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		// The main agent repeats what the tool said.
		if (last.role === "toolResult") return answer(`OK. ${text}`);
		// The main agent.
		if (text.includes("Start a subagent")) {
			return call({ action: "spawn", name: "reader", message: "Summarize the plot of Moby Dick." });
		}
		if (text.includes("whale's name"))
			return call({ action: "send", name: "reader", message: "What is the whale called?" });
		if (text.includes("every chapter")) {
			return call({ action: "send", name: "reader", message: "Now go through all chapters in detail." });
		}
		if (text.includes("Stop reader")) return call({ action: "stop", name: "reader" });
		if (text.includes("my subagents")) return call({ action: "status" });
		if (text.includes("[subagent")) return answer("Noted.");
		// The subagent: short answers, and a long chapter walk-through that is stopped halfway.
		if (text.includes("Summarize the plot")) return answer("A whale, a captain, an obsession.");
		if (text.includes("whale called")) return answer("Moby Dick.");
		const chapters = Array.from({ length: 135 }, (_, index) => `Chapter ${index + 1}: more whaling.`);
		return answer(chapters.join("\n"));
	};
	// More responses than the script needs; each request takes the next one.
	faux.setResponses(Array.from({ length: 40 }, () => route));
}
const registry = createRegistry();
registry.install(SubagentTools);
const directory = await mkdtemp(join(tmpdir(), "pi-durable-subagents-"));
const open = async () => {
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{ models, registry },
		context,
	);
	const root = await harness.root(context, { agent: { model } });
	return { harness, root };
};

// ─── UI: the main conversation's transcript, as a user would see it ───

const color = (code: number) => (text: string) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = color(1);
const dim = color(2);
const cyan = color(36);
const yellow = color(33);
const magenta = color(35);

function contentText(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string"
		? content
		: content.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("");
}

/** Print the main conversation's messages as they are committed. Subagents work in their own conversations. */
async function follow(harness: Harness, id: ConversationId): Promise<void> {
	const stream = await watchEvents(harness, id, context);
	stream.start(async (events: readonly AgentEvent[]) => {
		for (const event of events) {
			if (event.type !== "message_end") continue;
			const message = event.entry.model?.[0];
			if (message?.role === "user") {
				const text = contentText(message.content);
				// Input is either the user or a subagent's report, which arrives whenever the subagent is done.
				const report = /^\[subagent (\S+) ([^\]]*)\] ?(.*)$/s.exec(text);
				if (report === null) console.log(`\n${cyan(bold(">"))} ${bold(text)}`);
				else console.log(`\n${magenta(bold(`> ${report[1]}:`))} ${report[3] || report[2]}`);
			} else if (message?.role === "assistant") {
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					const { action, name, message: sent } = part.arguments as Record<string, string | undefined>;
					const quoted = sent === undefined ? "" : ` ${JSON.stringify(sent)}`;
					console.log(yellow(`  ${part.name} ${action}${name === undefined ? "" : ` ${name}`}${quoted}`));
				}
				if (textOf(message) !== "") console.log(textOf(message));
			} else if (message?.role === "toolResult") {
				console.log(dim(`  → ${contentText(message.content)}`));
			}
		}
	});
}

let { harness, root } = await open();
await follow(harness, root.id);

/** Say something to the main agent and wait for its answer. */
const say = async (text: string): Promise<void> => {
	await (await root.submit({ type: "input", content: text }, context)).wait(context);
};
/** Wait until every message to a subagent was answered and reported, and the main agent has reacted. */
const settle = async (): Promise<void> => {
	const reporters = (await harness.snapshot(Subagents, root.id, context))?.reporters ?? {};
	for (const id of Object.values(reporters)) await harness.waitForTask(id, context);
	await root.waitForIdle(context);
	// Event callbacks run after their commit; let the last ones print. A slow machine may need longer.
	await new Promise((resolve) => setTimeout(resolve, 50));
};
/** Poll `check` for up to 10 seconds. */
const until = async (check: () => Promise<boolean>): Promise<void> => {
	for (let tries = 0; tries < 1000; tries++) {
 if (await check()) return;
 await new Promise((resolve) => setTimeout(resolve, 10));
 }
 throw new Error("Timed out waiting for background work");
};
const working = async (name: string): Promise<boolean> => {
	const agent = (await harness.snapshot(Subagents, root.id, context))?.agents[name];
	return agent !== undefined && (await harness.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined;
};

// The main agent answers at once; the subagent's answer is reported back when it arrives.
await say("Start a subagent named reader that summarizes Moby Dick.");
await settle();

// A long request, stopped while the subagent is still answering.
await say("Ask reader to summarize every chapter.");
await until(() => working("reader"));
await say("Stop reader.");
await settle();

await say("What are my subagents doing?");
await settle();

// The process stops while the subagent works on a message; after the restart its answer still arrives.
const reporters = async () =>
	Object.keys((await harness.snapshot(Subagents, root.id, context))?.reporters ?? {}).length;
const before = await reporters();
await root.submit({ type: "input", content: "Ask reader for the whale's name." }, context);
await until(async () => (await reporters()) > before);
await harness.close(context);
console.log(dim("\n  (process restarts)"));
({ harness, root } = await open());
await follow(harness, root.id);
await settle();

await harness.close(context);
await rm(directory, { recursive: true, force: true });

function textOf(message: AssistantMessage | undefined): string {
 return (message?.content ?? []).flatMap(c => c.type === "text" ? [c.text] : []).join("");
}
