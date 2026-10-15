import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { type AskResult, normalizeQuestions } from "../src/questions.ts";
import { createQuestionnaireComponent } from "../src/ui/ask-questionnaire.ts";

function makeHost() {
	const tui = {
		requestRender: () => {},
		terminal: { rows: 40, columns: 100 },
	} as unknown as TUI;
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
	return { tui, theme };
}

function mount(questions: ReturnType<typeof normalizeQuestions>) {
	const { tui, theme } = makeHost();
	let result: AskResult | undefined;
	const component = createQuestionnaireComponent(
		tui,
		theme,
		questions,
		{ submitLabel: "Submit" },
		(value) => {
			result = value;
		},
	);
	return { component, result: () => result };
}

const ENTER = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";
const TAB = "\t";

describe("questionnaire component", () => {
	it("renders the question and options", () => {
		const questions = normalizeQuestions({
			questions: [
				{
					id: "pick",
					label: "Pick",
					question: "Choose one",
					options: [{ label: "Alpha" }, { label: "Beta" }],
				},
			],
		});
		const { component } = mount(questions);
		const rendered = component.render(80).join("\n");
		assert.match(rendered, /Choose one/);
		assert.match(rendered, /Alpha/);
		assert.match(rendered, /Beta/);
		assert.match(rendered, /Type something/);
	});

	it("finalizes a single-select question on space", () => {
		const questions = normalizeQuestions({
			questions: [
				{
					id: "pick",
					label: "Pick",
					question: "Choose one",
					options: [{ label: "Alpha" }, { label: "Beta" }],
				},
			],
		});
		const { component, result } = mount(questions);
		component.handleInput(" ");
		assert.equal(result()?.cancelled, false);
		assert.deepEqual(result()?.answers[0]?.entries, [
			{ value: "Alpha", label: "Alpha", custom: false },
		]);
	});

	it("selects numbered options and toggles multiple choices", () => {
		const questions = normalizeQuestions({
			questions: [
				{
					id: "pick",
					label: "Pick",
					question: "Choose some",
					multiple: true,
					options: [{ label: "Alpha" }, { label: "Beta" }],
				},
			],
		});
		const { component, result } = mount(questions);

		component.handleInput("2");
		assert.equal(result(), undefined, "multiple-choice questions wait for Enter");
		component.handleInput("a");
		component.handleInput("c");
		component.handleInput(" ");
		component.handleInput(ENTER);
		// The cursor stayed on the second option, so Space toggles Beta.
		assert.deepEqual(result()?.answers[0]?.entries, [
			{ value: "Beta", label: "Beta", custom: false },
		]);
	});

	it("enforces min selections before confirming", () => {
		const questions = normalizeQuestions({
			questions: [
				{
					id: "pick",
					label: "Pick",
					question: "Choose two",
					multiple: true,
					min: 2,
					options: [{ label: "Alpha" }, { label: "Beta" }],
				},
			],
		});
		const { component, result } = mount(questions);
		component.handleInput(" ");
		component.handleInput(ENTER);
		assert.equal(result(), undefined, "min selection blocks confirmation");
		component.handleInput(DOWN);
		component.handleInput(" ");
		component.handleInput(ENTER);
		assert.equal(result()?.answers[0]?.entries.length, 2);
	});

	it("walks through multiple tabs, typing, and the submit tab", () => {
		const questions = normalizeQuestions({
			questions: [
				{
					id: "pick",
					label: "Pick",
					question: "Choose some",
					multiple: true,
					options: [{ label: "Alpha" }, { label: "Beta" }],
				},
				{ id: "notes", label: "Notes", question: "Say something" },
			],
		});
		const { component, result } = mount(questions);

		assert.match(component.render(80).join("\n"), /Choose some/);
		component.handleInput(" ");
		component.handleInput(ENTER);
		assert.match(component.render(80).join("\n"), /Say something/, "advances to the next tab");

		for (const character of "hello") {
			component.handleInput(character);
		}
		component.handleInput(ENTER);
		assert.match(component.render(80).join("\n"), /Review your answers/);

		component.handleInput(ENTER);
		assert.equal(result()?.cancelled, false);
		assert.deepEqual(result()?.answers[0]?.entries, [
			{ value: "Alpha", label: "Alpha", custom: false },
		]);
		assert.deepEqual(result()?.answers[1]?.entries, [
			{ value: "hello", label: "hello", custom: true },
		]);
	});

	it("skips optional free-form questions on empty Enter", () => {
		const questions = normalizeQuestions({
			questions: [{ id: "notes", label: "Notes", question: "Anything?", required: false }],
		});
		const { component, result } = mount(questions);
		component.handleInput(ENTER);
		assert.equal(result()?.cancelled, false);
		assert.equal(result()?.answers[0]?.skipped, true);
	});

	it("adds multiple typed answers before finishing", () => {
		const questions = normalizeQuestions({
			questions: [{ id: "notes", label: "Notes", question: "List things", multiple: true }],
		});
		const { component, result } = mount(questions);
		for (const character of "one") {
			component.handleInput(character);
		}
		component.handleInput(ENTER);
		for (const character of "two") {
			component.handleInput(character);
		}
		component.handleInput(ENTER);
		component.handleInput(ENTER);
		assert.deepEqual(result()?.answers[0]?.entries, [
			{ value: "one", label: "one", custom: true },
			{ value: "two", label: "two", custom: true },
		]);
	});

	it("arms cancellation on the first Escape and cancels on the second", () => {
		const questions = normalizeQuestions({
			questions: [{ id: "pick", label: "Pick", question: "Choose one", options: [{ label: "A" }] }],
		});
		const { component, result } = mount(questions);
		component.handleInput(ESCAPE);
		assert.equal(result(), undefined);
		assert.match(component.render(80).join("\n"), /Press Esc again/);
		component.handleInput(ESCAPE);
		assert.equal(result()?.cancelled, true);
	});

	it("switches tabs with Tab", () => {
		const questions = normalizeQuestions({
			questions: [
				{ id: "one", label: "One", question: "First question" },
				{ id: "two", label: "Two", question: "Second question" },
			],
		});
		const { component } = mount(questions);
		assert.match(component.render(80).join("\n"), /First question/);
		component.handleInput(TAB);
		assert.match(component.render(80).join("\n"), /Second question/);
		component.handleInput(TAB);
		assert.match(component.render(80).join("\n"), /Review your answers/);
	});

	it("cancels through the abort signal", () => {
		const questions = normalizeQuestions({
			questions: [{ id: "pick", label: "Pick", question: "Choose one", options: [{ label: "A" }] }],
		});
		const controller = new AbortController();
		const { tui, theme } = makeHost();
		let result: AskResult | undefined;
		createQuestionnaireComponent(
			tui,
			theme,
			questions,
			{ submitLabel: "Submit", signal: controller.signal },
			(value) => {
				result = value;
			},
		);
		controller.abort();
		assert.equal(result?.cancelled, true);
	});
});
