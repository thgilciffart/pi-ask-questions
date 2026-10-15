import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AskResult } from "../src/questions.ts";
import extension from "../src/extension.ts";

/** Register the extension against a minimal fake API and capture definitions. */
function loadExtension() {
	let tool: any;
	const commands: Array<{ name: string; description?: string }> = [];
	const messages: Array<{ message: any; options: any }> = [];
	const pi = {
		registerTool: (definition: unknown) => {
			tool = definition;
		},
		registerCommand: (name: string, definition: { description?: string }) => {
			commands.push({ name, description: definition.description });
		},
		on: () => () => {},
		sendMessage: (message: unknown, options?: unknown) => {
			messages.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	extension(pi);
	return { tool, commands, messages };
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_color: string, text: string) => text,
} as unknown as Theme;

describe("extension registration", () => {
	it("registers the ask_user tool and the demo command", () => {
		const { tool, commands } = loadExtension();
		assert.equal(tool.name, "ask_user");
		assert.equal(tool.executionMode, "sequential");
		assert.ok(tool.parameters);
		assert.ok(tool.outputSchema);
		assert.ok(tool.annotations?.readOnlyHint);
		assert.deepEqual(
			commands.map((command) => command.name),
			["ask-demo"],
		);
	});

	it("renders the tool call header", () => {
		const { tool } = loadExtension();
		const component = tool.renderCall(
			{ questions: [{ id: "scope", label: "Scope", question: "Pick one" }] },
			theme,
			{},
		);
		const rendered = component.render(80).join("\n");
		assert.match(rendered, /ask_user/);
		assert.match(rendered, /Scope/);
	});
});

describe("ask_user execution", () => {
	it("returns an error with the questions when no UI exists", async () => {
		const { tool } = loadExtension();
		const ctx = {
			mode: "print",
			hasUI: false,
			ui: {},
		} as unknown as ExtensionToolContext;
		const result = await tool.execute(
			"call-1",
			{ questions: [{ id: "scope", question: "Which scope?", options: [{ label: "All" }] }] },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Interactive UI is not available/);
		assert.match(result.content[0].text, /Which scope\?/);
		assert.equal(result.details.cancelled, true);
	});

	it("uses dialog fallbacks in RPC mode and returns structured answers", async () => {
		const { tool } = loadExtension();
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: {
				select: async () => undefined,
				input: async () => "hello world",
				notify: () => {},
			},
		} as unknown as ExtensionToolContext;
		const result = await tool.execute(
			"call-2",
			{
				questions: [
					{ id: "notes", label: "Notes", question: "Say something", placeholder: "Type here" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		assert.equal(result.isError, undefined);
		assert.equal(result.details.cancelled, false);
		assert.match(result.content[0].text, /Notes: typed "hello world"/);
		assert.deepEqual(result.structuredContent, {
			cancelled: false,
			pending: false,
			answers: [
				{
					id: "notes",
					question: "Say something",
					skipped: false,
					answers: [{ value: "hello world", label: "hello world", custom: true }],
				},
			],
		});
	});

	it("cancels in RPC mode when a dialog is dismissed", async () => {
		const { tool } = loadExtension();
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: {
				select: async () => "All",
				input: async () => undefined,
				notify: () => {},
			},
		} as unknown as ExtensionToolContext;
		const result = await tool.execute(
			"call-3",
			{ questions: [{ id: "typed", label: "Typed", question: "Type it" }] },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(result.details.cancelled, true);
		assert.match(result.content[0].text, /cancelled/i);
	});
});

describe("ask_user noWait", () => {
	function tuiContext(): { ctx: ExtensionToolContext; resolve: () => void } {
		let resolveCustom: ((result: AskResult) => void) | undefined;
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: () =>
					new Promise<AskResult>((resolve) => {
						resolveCustom = resolve;
					}),
			},
		} as unknown as ExtensionToolContext;
		return {
			ctx,
			resolve: () => {
				resolveCustom?.({
					cancelled: false,
					answers: [
						{
							id: "pick",
							label: "Pick",
							question: "Choose",
							entries: [{ value: "A", label: "A", custom: false }],
							skipped: false,
						},
					],
				});
			},
		};
	}

	it("returns immediately and delivers the answers as a follow-up message", async () => {
		const { tool, messages } = loadExtension();
		const host = tuiContext();
		const result = await tool.execute(
			"call-bg",
			{
				noWait: true,
				questions: [
					{ id: "pick", label: "Pick", question: "Choose", options: [{ label: "A" }] },
				],
			},
			undefined,
			undefined,
			host.ctx,
		);
		assert.equal(result.isError, undefined);
		assert.equal(result.details.pending, true);
		assert.equal(result.structuredContent.pending, true);
		assert.deepEqual(result.structuredContent.answers, [
			{ id: "pick", question: "Choose", skipped: false, answers: [] },
		]);
		assert.equal(messages.length, 0, "nothing is sent while the question is open");

		host.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(messages.length, 1);
		assert.match(messages[0]!.message.content, /Pick: selected "A"/);
		assert.deepEqual(messages[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
	});

	it("rejects a second background questionnaire while one is open", async () => {
		const { tool, messages } = loadExtension();
		const host = tuiContext();
		const params = {
			noWait: true,
			questions: [{ id: "pick", label: "Pick", question: "Choose", options: [{ label: "A" }] }],
		};
		await tool.execute("call-bg-1", params, undefined, undefined, host.ctx);
		const second = await tool.execute("call-bg-2", params, undefined, undefined, host.ctx);
		assert.equal(second.isError, true);
		assert.match(second.content[0].text, /already open/);
		host.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(messages.length, 1, "the first questionnaire still delivers");
	});
});
