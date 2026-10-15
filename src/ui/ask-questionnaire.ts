/**
 * Interactive questionnaire component for the `ask_user` tool.
 *
 * Layout (multiple questions):
 *
 *   ─────────────────────────────────────────────
 *    Title
 *    ✓ Scope  ◐ Style  · Notes  [ Submit ]
 *
 *    The question text
 *    Optional header / hints
 *
 *    ❯ [x] 1. Option label
 *          description
 *      [ ] 2. Another option
 *      ✎ Type something…
 *      ⏭ Skip this question
 *
 *    ↑↓ move • Space toggle • Enter confirm • Esc cancel
 *   ─────────────────────────────────────────────
 *
 * Keyboard contract:
 * - Tab / Shift+Tab (and ←/→) switch tabs.
 * - ↑/↓ move the cursor; Home/End jump to the first/last row.
 * - Space toggles a multiple-choice option; Enter confirms the question.
 * - 1-9 jumps to an option; on multiple-choice it toggles it.
 * - A selects all options, C clears the selection (multiple-choice only).
 * - Enter on "Type something…" opens the inline editor.
 * - Esc leaves the editor or arms cancellation; Esc twice cancels.
 * - Ctrl+C cancels immediately.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	Key,
	type Component,
	type EditorTheme,
	type TUI,
	decodeKittyPrintable,
	matchesKey,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	type AnswerEntry,
	type AskResult,
	type NormalizedOption,
	type NormalizedQuestion,
	type QuestionAnswer,
	answerError,
	answerStatus,
	buildResult,
	collectAnswerErrors,
	makeAnswer,
	windowRange,
} from "../questions.ts";

export interface QuestionnaireOptions {
	title?: string;
	submitLabel: string;
	signal?: AbortSignal;
}

/** The subset of a Pi extension context the questionnaire needs. */
export type QuestionnaireContext = Pick<ExtensionContext, "ui" | "mode" | "hasUI">;

type NoticeKind = "info" | "warning" | "error" | "success";

type QuestionRow =
	| { kind: "option"; option: NormalizedOption; index: number }
	| { kind: "custom" }
	| { kind: "skip" };

type AddLine = (prefix: string, text: string) => void;

const MAX_VISIBLE_ROWS = 8;

const NOTICE_COLORS: Record<NoticeKind, "muted" | "warning" | "error" | "success"> = {
	info: "muted",
	warning: "warning",
	error: "error",
	success: "success",
};

/** Run the questionnaire and resolve with the user's answers. */
export async function runQuestionnaire(
	ctx: QuestionnaireContext,
	questions: NormalizedQuestion[],
	options: QuestionnaireOptions,
): Promise<AskResult> {
	if (options.signal?.aborted) {
		return buildResult(questions, new Map(), true);
	}
	return ctx.ui.custom<AskResult>((tui, theme, _keybindings, done) =>
		createQuestionnaireComponent(tui, theme, questions, options, done),
	);
}

/** Build the questionnaire component. Exported for tests and reuse. */
export function createQuestionnaireComponent(
	tui: TUI,
	theme: Theme,
	questions: NormalizedQuestion[],
	options: QuestionnaireOptions,
	done: (result: AskResult) => void,
): Component & { focused: boolean; handleInput(data: string): void; dispose(): void } {
	const showTabs = questions.length > 1;
	const submitTabIndex = questions.length;

	let tab = 0;
	let cursor = 0;
	let submitCursor = questions.length;
	let mode: "options" | "typing" = "options";
	let cancelArmed = false;
	let notice: { text: string; kind: NoticeKind } | undefined;
	let editorText = "";
	let cachedLines: string[] | undefined;
	let finished = false;

	const answers = new Map<string, QuestionAnswer>();

	// ── State helpers ────────────────────────────────────────────────────

	for (const question of questions) {
		const preselected: AnswerEntry[] = question.options
			.filter((option) => option.selected)
			.map((option) => ({ value: option.value, label: option.label, custom: false }));
		if (!question.multiple) {
			preselected.splice(1);
		}
		if (preselected.length > 0) {
			answers.set(question.id, makeAnswer(question, preselected));
		}
	}

	function getAnswer(question: NormalizedQuestion): QuestionAnswer {
		return answers.get(question.id) ?? makeAnswer(question, []);
	}

	function setEntries(question: NormalizedQuestion, entries: AnswerEntry[]): void {
		if (entries.length === 0 && !question.required) {
			answers.set(question.id, makeAnswer(question, [], true));
		} else {
			answers.set(question.id, makeAnswer(question, entries, false));
		}
	}

	function rowsFor(question: NormalizedQuestion): QuestionRow[] {
		const rows: QuestionRow[] = question.options.map((option, index) => ({
			kind: "option",
			option,
			index,
		}));
		if (question.allowOther) {
			rows.push({ kind: "custom" });
		}
		if (!question.required) {
			rows.push({ kind: "skip" });
		}
		return rows;
	}

	function isOptionSelected(question: NormalizedQuestion, option: NormalizedOption): boolean {
		return getAnswer(question).entries.some(
			(entry) => !entry.custom && entry.value === option.value,
		);
	}

	function optionEntry(option: NormalizedOption): AnswerEntry {
		return { value: option.value, label: option.label, custom: false };
	}

	function toggleOption(question: NormalizedQuestion, option: NormalizedOption): AnswerEntry[] {
		const entries = getAnswer(question).entries;
		const index = entries.findIndex((entry) => !entry.custom && entry.value === option.value);
		if (index >= 0) {
			return entries.filter((_, entryIndex) => entryIndex !== index);
		}
		if (question.max !== undefined && entries.length >= question.max) {
			notice = {
				text: `Select at most ${question.max} ${question.max === 1 ? "answer" : "answers"}.`,
				kind: "warning",
			};
			return entries;
		}
		return [...entries, optionEntry(option)];
	}

	function refresh(): void {
		cachedLines = undefined;
		tui.requestRender();
	}

	function setText(text: string): void {
		editor.setText(text);
		editorText = editor.getText();
	}

	// ── Navigation ───────────────────────────────────────────────────────

	function prepareQuestion(question: NormalizedQuestion | undefined, prefill: boolean): void {
		cursor = 0;
		if (!question || question.options.length > 0) {
			mode = "options";
			setText("");
			return;
		}
		mode = "typing";
		const existing = prefill && !question.multiple ? getAnswer(question).entries[0]?.value ?? "" : "";
		setText(existing);
	}

	function goTab(delta: number): void {
		if (!showTabs) {
			return;
		}
		const total = questions.length + 1;
		tab = (tab + delta + total) % total;
		cancelArmed = false;
		notice = undefined;
		if (tab === submitTabIndex) {
			submitCursor = submitTabIndex;
		}
		prepareQuestion(questions[tab], true);
		refresh();
	}

	function jumpToQuestion(index: number): void {
		tab = index;
		cancelArmed = false;
		notice = undefined;
		prepareQuestion(questions[tab], true);
		refresh();
	}

	function advance(): void {
		cancelArmed = false;
		if (questions.length === 1) {
			finish(false);
			return;
		}
		tab = tab < questions.length - 1 ? tab + 1 : submitTabIndex;
		prepareQuestion(questions[tab], true);
		refresh();
	}

	// ── Actions ──────────────────────────────────────────────────────────

	function finish(cancelled: boolean): void {
		if (finished) {
			return;
		}
		if (!cancelled) {
			const errors = collectAnswerErrors(questions, answers);
			if (errors.length > 0) {
				const first = errors[0]!;
				const index = questions.findIndex((question) => question.id === first.id);
				tab = index >= 0 ? index : 0;
				cancelArmed = false;
				prepareQuestion(questions[tab], false);
				notice = { text: `${first.label}: ${first.message}`, kind: "error" };
				refresh();
				return;
			}
		}
		finished = true;
		options.signal?.removeEventListener("abort", onAbort);
		done(buildResult(questions, answers, cancelled));
	}

	function cancelNow(): void {
		finish(true);
	}

	function armCancel(): void {
		cancelArmed = true;
		notice = { text: "Press Esc again to cancel.", kind: "warning" };
		refresh();
	}

	function startTyping(): void {
		mode = "typing";
		const question = questions[tab];
		const existing = question
			? getAnswer(question).entries.find((entry) => entry.custom)?.value ?? ""
			: "";
		setText(existing);
		notice = undefined;
		refresh();
	}

	function activateRow(toggle: boolean): void {
		const question = questions[tab];
		if (!question) {
			return;
		}
		const rows = rowsFor(question);
		const row = rows[cursor];
		if (!row) {
			return;
		}
		if (row.kind === "custom") {
			startTyping();
			return;
		}
		if (row.kind === "skip") {
			answers.set(question.id, makeAnswer(question, [], true));
			advance();
			return;
		}
		if (question.multiple) {
			if (toggle) {
				setEntries(question, toggleOption(question, row.option));
				notice = undefined;
				refresh();
				return;
			}
			const error = answerError(question, answers.get(question.id));
			if (error) {
				notice = { text: error, kind: "warning" };
				refresh();
				return;
			}
			advance();
			return;
		}
		setEntries(question, [optionEntry(row.option)]);
		advance();
	}

	function selectAll(question: NormalizedQuestion): void {
		const entries = getAnswer(question).entries;
		const custom = entries.filter((entry) => entry.custom);
		const capacity =
			question.max === undefined
				? question.options.length
				: Math.max(0, question.max - custom.length);
		setEntries(question, [...question.options.slice(0, capacity).map(optionEntry), ...custom]);
		notice = undefined;
		refresh();
	}

	function submitTyped(rawValue: string): void {
		const question = questions[tab];
		if (!question) {
			return;
		}
		const value = rawValue.trim();
		const answer = getAnswer(question);

		if (!value) {
			if (!question.required) {
				answers.set(question.id, makeAnswer(question, [], true));
				advance();
				return;
			}
			if (question.multiple && question.options.length === 0) {
				if (answer.entries.length > 0) {
					advance();
					return;
				}
				notice = { text: "Type an answer first.", kind: "warning" };
				refresh();
				return;
			}
			if (question.multiple) {
				mode = "options";
				notice = undefined;
				refresh();
				return;
			}
			notice = { text: "Type an answer first.", kind: "warning" };
			refresh();
			return;
		}

		if (question.multiple) {
			if (answer.entries.some((entry) => entry.custom && entry.value === value)) {
				notice = { text: "That answer was already added.", kind: "info" };
				refresh();
				return;
			}
			if (question.max !== undefined && answer.entries.length >= question.max) {
				notice = {
					text: `Select at most ${question.max} ${question.max === 1 ? "answer" : "answers"}.`,
					kind: "warning",
				};
				refresh();
				return;
			}
			setEntries(question, [...answer.entries, { value, label: value, custom: true }]);
			notice = { text: `Added "${value}".`, kind: "success" };
			setText("");
			if (question.options.length > 0) {
				mode = "options";
			}
			refresh();
			return;
		}

		setEntries(question, [{ value, label: value, custom: true }]);
		advance();
	}

	// ── Input handling ───────────────────────────────────────────────────

	function handleSubmitTab(data: string): void {
		const total = questions.length + 1;
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			goTab(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			goTab(-1);
			return;
		}
		if (matchesKey(data, Key.up)) {
			submitCursor = (submitCursor - 1 + total) % total;
			refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			submitCursor = (submitCursor + 1) % total;
			refresh();
			return;
		}
		if (matchesKey(data, Key.home)) {
			submitCursor = 0;
			refresh();
			return;
		}
		if (matchesKey(data, Key.end)) {
			submitCursor = questions.length;
			refresh();
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			if (submitCursor < questions.length) {
				jumpToQuestion(submitCursor);
				return;
			}
			finish(false);
		}
	}

	function handleQuestionTab(data: string): void {
		const question = questions[tab];
		if (!question) {
			return;
		}
		const rows = rowsFor(question);

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			goTab(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			goTab(-1);
			return;
		}
		if (rows.length > 0) {
			if (matchesKey(data, Key.up)) {
				cursor = (cursor - 1 + rows.length) % rows.length;
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				cursor = (cursor + 1) % rows.length;
				refresh();
				return;
			}
			if (matchesKey(data, Key.home)) {
				cursor = 0;
				refresh();
				return;
			}
			if (matchesKey(data, Key.end)) {
				cursor = rows.length - 1;
				refresh();
				return;
			}
		}
		if (matchesKey(data, Key.space)) {
			activateRow(true);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			activateRow(false);
			return;
		}

		const printable = printableKey(data);
		if (printable === undefined) {
			return;
		}
		const lower = printable.toLowerCase();
		if (question.multiple && lower === "a") {
			selectAll(question);
			return;
		}
		if (question.multiple && lower === "c") {
			setEntries(question, []);
			notice = undefined;
			refresh();
			return;
		}
		const digit = Number.parseInt(printable, 10);
		if (!Number.isNaN(digit) && digit >= 1 && digit <= 9) {
			const index = rows.findIndex((row) => row.kind === "option" && row.index === digit - 1);
			if (index >= 0) {
				cursor = index;
				activateRow(question.multiple);
			}
		}
	}

	function handleInput(data: string): void {
		if (finished) {
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			cancelNow();
			return;
		}

		const escape = matchesKey(data, Key.escape);

		if (mode === "typing") {
			if (showTabs && matchesKey(data, Key.tab)) {
				goTab(1);
				return;
			}
			if (showTabs && matchesKey(data, Key.shift("tab"))) {
				goTab(-1);
				return;
			}
			if (escape) {
				const question = questions[tab];
				if (question && question.options.length > 0) {
					mode = "options";
					notice = undefined;
					refresh();
				} else {
					armCancel();
				}
				return;
			}
			if (cancelArmed) {
				cancelArmed = false;
				notice = undefined;
			}
			editor.handleInput(data);
			refresh();
			return;
		}

		if (!escape && cancelArmed) {
			cancelArmed = false;
			notice = undefined;
		}
		if (escape) {
			if (cancelArmed) {
				cancelNow();
			} else {
				armCancel();
			}
			return;
		}
		if (showTabs && tab === submitTabIndex) {
			handleSubmitTab(data);
			return;
		}
		handleQuestionTab(data);
	}

	// ── Rendering ────────────────────────────────────────────────────────

	function renderTabs(add: AddLine): void {
		const parts: string[] = [];
		for (let index = 0; index < questions.length; index += 1) {
			const question = questions[index]!;
			const status = answerStatus(question, answers.get(question.id));
			const icon =
				status === "complete"
					? "✓"
					: status === "partial"
						? "◐"
						: status === "skipped"
							? "·"
							: "○";
			const text = ` ${icon} ${question.label} `;
			if (index === tab) {
				parts.push(theme.bg("selectedBg", theme.fg("text", text)));
			} else if (status === "complete") {
				parts.push(theme.fg("success", text));
			} else if (status === "partial") {
				parts.push(theme.fg("accent", text));
			} else {
				parts.push(theme.fg("muted", text));
			}
		}
		const ready = collectAnswerErrors(questions, answers).length === 0;
		const submitText = ` ${options.submitLabel} `;
		if (tab === submitTabIndex) {
			parts.push(theme.bg("selectedBg", theme.fg("text", submitText)));
		} else {
			parts.push(theme.fg(ready ? "success" : "dim", submitText));
		}
		add(" ", parts.join(" "));
	}

	function renderRows(add: AddLine, question: NormalizedQuestion): void {
		const rows = rowsFor(question);
		const { start, end, hiddenAbove, hiddenBelow } = windowRange(
			rows.length,
			cursor,
			MAX_VISIBLE_ROWS,
		);
		if (hiddenAbove > 0) {
			add("  ", theme.fg("dim", `↑ ${hiddenAbove} more`));
		}
		for (let index = start; index < end; index += 1) {
			const row = rows[index]!;
			const active = index === cursor;
			const marker = active ? theme.fg("accent", "❯ ") : "  ";
			if (row.kind === "option") {
				const selected = isOptionSelected(question, row.option);
				const box = question.multiple ? (selected ? "[x]" : "[ ]") : selected ? "(•)" : "( )";
				const number = row.index < 9 ? `${row.index + 1}.` : "  ";
				const color = active ? "accent" : selected ? "success" : "text";
				add(marker, theme.fg(color, `${box} ${number} ${row.option.label}`));
				if (row.option.description) {
					add("     ", theme.fg("muted", row.option.description));
				}
				continue;
			}
			if (row.kind === "custom") {
				const customEntries = getAnswer(question).entries.filter((entry) => entry.custom);
				const suffix = customEntries.length > 0 ? ` (${customEntries.length} added)` : "";
				add(marker, theme.fg(active ? "accent" : "text", `✎ ${question.otherLabel}${suffix}`));
				for (const entry of customEntries) {
					add("     ", theme.fg("success", `✎ "${entry.value}"`));
				}
				continue;
			}
			add(marker, theme.fg(active ? "accent" : "warning", "⏭ Skip this question"));
		}
		if (hiddenBelow > 0) {
			add("  ", theme.fg("dim", `↓ ${hiddenBelow} more`));
		}
	}

	function renderQuestion(add: AddLine, lines: string[], renderWidth: number): void {
		const question = questions[tab];
		if (!question) {
			return;
		}
		add(" ", theme.bold(theme.fg("text", question.question)));
		if (question.header) {
			add(" ", theme.fg("muted", question.header));
		}
		if (question.multiple) {
			const min = question.min !== undefined ? `at least ${question.min}` : "one or more";
			const max = question.max !== undefined ? `, up to ${question.max}` : "";
			add(" ", theme.fg("dim", `Select ${min}${max} • Space toggles`));
		}
		add(" ", "");
		if (question.options.length === 0 || mode === "typing") {
			renderTyping(add, lines, renderWidth, question);
		} else {
			renderRows(add, question);
		}
	}

	function renderSubmit(add: AddLine): void {
		add(" ", theme.bold(theme.fg("text", "Review your answers")));
		add(" ", "");
		const errors = collectAnswerErrors(questions, answers);
		const invalid = new Set(errors.map((error) => error.id));
		for (let index = 0; index < questions.length; index += 1) {
			const question = questions[index]!;
			const answer = getAnswer(question);
			const active = submitCursor === index;
			const marker = active ? theme.fg("accent", "❯ ") : "  ";
			const status = answerStatus(question, answer);
			const icon =
				status === "complete"
					? theme.fg("success", "✓ ")
					: status === "partial"
						? theme.fg("accent", "◐ ")
						: "";
			let summary: string;
			if (answer.skipped) {
				summary = theme.fg("dim", "(skipped)");
			} else if (invalid.has(question.id)) {
				summary = theme.fg("warning", "needs an answer");
			} else if (answer.entries.length === 0) {
				summary = theme.fg("dim", "(optional, skipped)");
			} else {
				summary = answer.entries
					.map((entry) =>
						entry.custom ? theme.fg("accent", `"${entry.value}"`) : theme.fg("text", entry.label),
					)
					.join(theme.fg("dim", ", "));
			}
			add(marker, `${icon}${theme.fg("muted", `${question.label}: `)}${summary}`);
		}
		add(" ", "");
		const ready = errors.length === 0;
		const submitActive = submitCursor === questions.length;
		add(
			submitActive ? theme.fg("accent", "❯ ") : "  ",
			theme.fg(ready ? "success" : "warning", `[ ${options.submitLabel} ]`),
		);
		if (!ready) {
			const count = errors.length;
			add(
				"  ",
				theme.fg(
					"warning",
					`${count} ${count === 1 ? "question still needs" : "questions still need"} an answer`,
				),
			);
		}
	}

	function helpText(): string {
		if (showTabs && tab === submitTabIndex) {
			return `↑↓ choose • Enter open or ${options.submitLabel} • Tab switch • Esc cancel`;
		}
		const question = questions[tab];
		if (!question) {
			return "Tab switch • Esc cancel";
		}
		const typing = mode === "typing" || question.options.length === 0;
		if (typing) {
			if (question.options.length === 0 && question.multiple) {
				return "Enter add • empty Enter finish • Esc cancel";
			}
			if (question.options.length > 0) {
				return "Enter submit • Esc back to options";
			}
			return "Enter submit • \\+Enter newline • Esc cancel";
		}
		if (question.multiple) {
			return "↑↓ move • Space toggle • A all • C clear • 1-9 jump • Enter confirm • Tab switch";
		}
		return "↑↓ move • Space/Enter select • 1-9 jump • Tab switch • Esc cancel";
	}

	function render(width: number): string[] {
		if (cachedLines) {
			return cachedLines;
		}
		const renderWidth = Math.max(1, width);
		const lines: string[] = [];

		const add: AddLine = (prefix, text) => {
			const prefixWidth = visibleWidth(prefix);
			if (prefixWidth >= renderWidth) {
				lines.push(...wrapTextWithAnsi(prefix + text, renderWidth));
				return;
			}
			const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
			const continuation = " ".repeat(prefixWidth);
			wrapped.forEach((line, index) => {
				lines.push(`${index === 0 ? prefix : continuation}${line}`);
			});
		};

		lines.push(theme.fg("borderAccent", "─".repeat(renderWidth)));
		if (options.title) {
			add(" ", theme.bold(theme.fg("accent", options.title)));
		}
		if (showTabs) {
			renderTabs(add);
		}
		if (options.title || showTabs) {
			add(" ", "");
		}
		if (showTabs && tab === submitTabIndex) {
			renderSubmit(add);
		} else {
			renderQuestion(add, lines, renderWidth);
		}
		add(" ", "");
		if (notice) {
			add(" ", theme.fg(NOTICE_COLORS[notice.kind], notice.text));
		}
		add(" ", theme.fg("dim", helpText()));
		lines.push(theme.fg("borderAccent", "─".repeat(renderWidth)));

		cachedLines = lines;
		return lines;
	}

	// ── Typing sub-render (declared separately to keep render readable) ──

	function renderTyping(
		add: AddLine,
		lines: string[],
		renderWidth: number,
		question: NormalizedQuestion,
	): void {
		const answer = getAnswer(question);
		if (question.options.length === 0 && answer.entries.length > 0) {
			answer.entries.forEach((entry, index) => {
				add(" ", theme.fg("success", `${index + 1}. ${entry.value}`));
			});
			add(" ", "");
		}
		if (question.placeholder && editorText.length === 0) {
			add(" ", theme.fg("dim", question.placeholder));
		}
		for (const line of editor.render(Math.max(1, renderWidth - 2))) {
			lines.push(` ${line}`);
		}
	}

	// ── Editor wiring ────────────────────────────────────────────────────

	const editorTheme: EditorTheme = {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
	const editor = new Editor(tui, editorTheme);
	editor.onChange = (value) => {
		editorText = value;
		cachedLines = undefined;
	};
	editor.onSubmit = (value) => {
		submitTyped(value);
	};

	prepareQuestion(questions[0], false);

	const onAbort = (): void => {
		finished = true;
		done(buildResult(questions, answers, true));
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	return {
		get focused(): boolean {
			return editor.focused;
		},
		set focused(value: boolean) {
			editor.focused = value;
		},
		render,
		handleInput,
		invalidate: () => {
			cachedLines = undefined;
		},
		dispose: () => {
			options.signal?.removeEventListener("abort", onAbort);
		},
	};
}

/** Extract a printable character from raw input, including Kitty CSI-u keys. */
function printableKey(data: string): string | undefined {
	if (data.length === 1) {
		return data;
	}
	return decodeKittyPrintable(data);
}
