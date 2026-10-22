/**
 * pi-ask-questions
 *
 * Registers the `ask_user` tool: an interactive questionnaire with tabs,
 * single- and multi-select options, free-form typing, validation, and
 * structured answers. Also adds `/ask-demo` so the UI can be previewed
 * without involving the model.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { runFallbackSurvey } from "./fallback.ts";
import {
	type AskResult,
	type NormalizedQuestion,
	type QuestionAnswer,
	DEFAULT_SUBMIT_LABEL,
	buildResult,
	formatAnswersText,
	normalizeQuestions,
	toStructuredOutput,
} from "./questions.ts";
import {
	AskUserOutputSchema,
	AskUserParamsSchema,
	type AskUserParams,
} from "./schema.ts";
import { runQuestionnaire, type QuestionnaireContext } from "./ui/ask-questionnaire.ts";
/** Structured details stored with the tool result for rendering. */
export interface AskToolDetails {
	cancelled: boolean;
	/** True while a noWait questionnaire is still open in the background. */
	pending?: boolean;
	answers: QuestionAnswer[];
	questions: NormalizedQuestion[];
}

const TOOL_DESCRIPTION = `Ask the user one or more questions and wait for their answers. Use it when you need a decision, preference, or piece of information that only the user can provide.

The interactive UI supports:
- Tabs: every question gets its own tab (Tab / Shift+Tab and arrow keys switch).
- Single-select and multi-select questions (set multiple: true).
- Free-form typing: a question with no options is a text prompt. Option questions can also hold one typed answer alongside the selected option(s) unless allowOther is false, and the answer is edited inline.
- Optional questions (required: false) that can be skipped, preselected options (selected: true), and min/max selection counts.
- Space or number keys 1-9 select or clear options without submitting; Enter confirms. A selects all; C clears a multi-select.
- Set noWait: true to open the questionnaire in the background: the tool returns immediately and the answers arrive later as a follow-up message.

Guidelines:
- Prefer this tool over asking questions in prose when you actually need the answer to proceed.
- Group related questions into one call (2-6 questions) instead of asking repeatedly.
- Provide concrete, labeled options whenever you can; use a free-form question only when the answer space is open.
- Put recommended options first.
- Use noWait only when you can keep working without the answer; otherwise omit it so the answers arrive in the same turn.`;

const HELP_TEXT = `Interactive UI is not available in this mode. Ask the user the following questions directly in your reply instead:
{{questions}}`;

/** Dispatch to the right UI for the current mode. */
async function askQuestions(
	ctx: Pick<ExtensionContext, "ui" | "mode" | "hasUI">,
	questions: NormalizedQuestion[],
	options: { title?: string; submitLabel: string; signal?: AbortSignal },
): Promise<AskResult> {
	if (ctx.mode === "tui") {
		return runQuestionnaire(ctx as QuestionnaireContext, questions, options);
	}
	if (ctx.hasUI) {
		return runFallbackSurvey(ctx.ui, questions, options.signal);
	}
	throw new Error("no-ui");
}

/** Human-readable list used when no UI exists (print/JSON mode). */
function questionsAsText(questions: NormalizedQuestion[]): string {
	return questions
		.map((question, index) => {
			const options =
				question.options.length > 0
					? `\n   Options: ${question.options.map((option) => option.label).join(", ")}`
					: "";
			const optional = question.required ? "" : " (optional)";
			return `${index + 1}. ${question.question}${optional}${options}`;
		})
		.join("\n");
}

function resultContent(result: AskResult): string {
	if (result.cancelled) {
		return "The user cancelled the questionnaire before submitting.";
	}
	return `User answered:\n${formatAnswersText(result)}`;
}

/** Start the questionnaire and wait for the user. */
export default function askQuestionsExtension(pi: ExtensionAPI): void {
	// A noWait questionnaire stays open after its tool call returns. It owns a
	// session-scoped abort controller and reports its answers with a follow-up
	// message instead of a tool result.
	let backgroundController: AbortController | undefined;
	let shuttingDown = false;

	pi.on("session_start", () => {
		shuttingDown = false;
	});
	pi.on("session_shutdown", () => {
		shuttingDown = true;
		backgroundController?.abort();
		backgroundController = undefined;
	});

	pi.registerTool<typeof AskUserParamsSchema, AskToolDetails>({
		name: "ask_user",
		label: "Ask User",
		description: TOOL_DESCRIPTION,
		promptSnippet:
			"ask_user: ask the user structured questions in an interactive questionnaire (tabs, multi-select, free-form).",
		promptGuidelines: [
			"Use ask_user when you need a decision or missing detail from the user; batch related questions into one call instead of asking repeatedly.",
			"Give ask_user questions labeled options where possible, keep them self-contained, and put recommended options first.",
			"Set noWait only when you can keep working without the answers, for example to ask while investigating something else.",
		],
		parameters: AskUserParamsSchema,
		outputSchema: AskUserOutputSchema,
		executionMode: "sequential",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const questions = normalizeQuestions(params);
			if (questions.length === 0) {
				return {
					content: [{ type: "text", text: "No questions were provided." }],
					details: { cancelled: true, answers: [], questions },
					isError: true,
				};
			}

			const submitLabel = params.submitLabel?.trim() || DEFAULT_SUBMIT_LABEL;

			if (params.noWait === true && ctx.mode === "tui") {
				if (backgroundController) {
					return {
						content: [
							{
								type: "text",
								text: "Another background questionnaire is already open. Wait for the user to answer it before asking again.",
							},
						],
						details: { cancelled: true, pending: true, answers: [], questions },
						isError: true,
					};
				}

				const controller = new AbortController();
				backgroundController = controller;
				void runQuestionnaire(ctx as QuestionnaireContext, questions, {
					title: params.title?.trim() || undefined,
					submitLabel,
					signal: controller.signal,
				})
					.then((result) => {
						if (shuttingDown || backgroundController !== controller) {
							return;
						}
						pi.sendMessage(
							{
								customType: "ask_user:answers",
								content: resultContent(result),
								display: true,
								details: { cancelled: result.cancelled, answers: result.answers, questions },
							},
							{ triggerTurn: true, deliverAs: "followUp" },
						);
					})
					.catch((error: unknown) => {
						// The questionnaire could not be shown. The tool result already told
						// the model it was pending, so surface the failure to the user
						// instead of leaving everyone waiting for answers that never come.
						const reason = error instanceof Error ? error.message : String(error);
						try {
							ctx.ui.notify(
								`ask_user could not show the background questionnaire: ${reason}`,
								"error",
							);
						} catch {
							// Reporting is best-effort; the background slot still clears.
						}
					})
					.finally(() => {
						if (backgroundController === controller) {
							backgroundController = undefined;
						}
					});

				return {
					content: [
						{
							type: "text",
							text: `Questionnaire shown to the user in the background. Continue with other work; the answers will arrive as a follow-up message.`,
						},
					],
					details: { cancelled: false, pending: true, answers: [], questions },
					structuredContent: toStructuredOutput(buildResult(questions, new Map(), false, true)),
				};
			}
			let result: AskResult;
			try {
				result = await askQuestions(ctx, questions, {
					title: params.title?.trim() || undefined,
					submitLabel,
					signal: signal ?? undefined,
				});
			} catch (error) {
				if (error instanceof Error && error.message === "no-ui") {
					const text = HELP_TEXT.replace("{{questions}}", questionsAsText(questions));
					return {
						content: [{ type: "text", text }],
						details: { cancelled: true, answers: [], questions },
						isError: true,
					};
				}
				throw error;
			}

			return {
				content: [{ type: "text", text: resultContent(result) }],
				details: {
					cancelled: result.cancelled,
					answers: result.answers,
					questions,
				},
				structuredContent: toStructuredOutput(result),
			};
		},

		renderCall(args, theme, _context) {
			const questions = Array.isArray(args.questions) ? args.questions : [];
			const count = questions.length;
			let text =
				theme.fg("toolTitle", theme.bold("ask_user ")) +
				theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`);
			const labels = questions
				.map((question, index) => question.label?.trim() || question.id?.trim() || `Q${index + 1}`)
				.join(", ");
			if (labels.length > 0) {
				text += theme.fg("dim", ` (${labels})`);
			}
			const first = questions[0]?.question;
			if (typeof first === "string" && first.length > 0) {
				text += `\n${theme.fg("dim", `  ${first}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details;
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}
			if (details.pending) {
				if (result.isError) {
					const content = result.content[0];
					return new Text(content?.type === "text" ? content.text : "Background questionnaire busy", 0, 0);
				}
				return new Text(theme.fg("muted", "Waiting for the user in the background"), 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((answer) => {
				const label = theme.fg("accent", answer.label);
				if (answer.skipped) {
					return `${label}${theme.fg("dim", ": skipped")}`;
				}
				if (answer.entries.length === 0) {
					return `${label}${theme.fg("dim", ": no answer")}`;
				}
				const values = answer.entries
					.map((entry) =>
						entry.custom
							? `${theme.fg("muted", "(typed) ")}${theme.fg("text", entry.value)}`
							: theme.fg("text", entry.label),
					)
					.join(theme.fg("dim", ", "));
				return `${label}${theme.fg("muted", ": ")}${values}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerCommand("ask-demo", {
		description: "Preview the ask_user questionnaire UI with a sample survey",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("The demo needs an interactive UI (TUI or RPC mode).", "error");
				return;
			}
			const questions = normalizeQuestions(demoParams());
			try {
				const result = await askQuestions(ctx, questions, {
					title: "ask_user demo",
					submitLabel: DEFAULT_SUBMIT_LABEL,
					signal: ctx.signal,
				});
				ctx.ui.notify(
					result.cancelled
						? "Demo cancelled"
						: `Demo finished — ${formatAnswersText(result).split("\n").length} answers`,
					"info",
				);
			} catch (error) {
				if (error instanceof Error && error.message === "no-ui") {
					ctx.ui.notify("No UI available for the demo.", "error");
					return;
				}
				throw error;
			}
		},
	});
}

/** Sample questionnaire used by `/ask-demo` and the README. */
function demoParams(): AskUserParams {
	return {
		title: "ask_user demo",
		questions: [
			{
				id: "scope",
				label: "Scope",
				question: "Which parts of the project should this change touch?",
				multiple: true,
				options: [
					{
						label: "Extension host",
						description: "Tool registration and lifecycle code",
						selected: true,
					},
					{ label: "TUI component", description: "The interactive questionnaire renderer" },
					{ label: "Documentation" },
					{ label: "Tests", selected: true },
				],
			},
			{
				id: "release",
				label: "Release",
				question: "How should the release be versioned?",
				options: [
					{ label: "Patch", description: "Bug fixes only (0.0.x)" },
					{ label: "Minor", description: "Backwards-compatible features (0.x.0)" },
					{ label: "Major", description: "Breaking changes (x.0.0)" },
				],
			},
			{
				id: "notes",
				label: "Notes",
				question: "Anything else I should know?",
				required: false,
				placeholder: "Type a note, or leave empty…",
			},
		],
	};
}
