/**
 * Model-facing schemas for the `ask_user` tool.
 *
 * The parameter schema is deliberately forgiving: almost every field is
 * optional so the model can ask a quick question without ceremony. The pure
 * normalization layer in `questions.ts` applies the defaults.
 */
import { Type, type Static } from "typebox";

export const QuestionOptionSchema = Type.Object({
	value: Type.Optional(
		Type.String({
			description: "Value returned when this option is chosen. Defaults to the label.",
		}),
	),
	label: Type.String({
		description: "Display label for the option. Keep it short.",
	}),
	description: Type.Optional(
		Type.String({
			description: "Optional explanation shown under the label.",
		}),
	),
	selected: Type.Optional(
		Type.Boolean({
			description: "Preselect this option (default: false).",
		}),
	),
});

export const QuestionSchema = Type.Object({
	id: Type.Optional(
		Type.String({
			description: 'Stable identifier used in the result, e.g. "scope". Defaults to q1, q2, ...',
		}),
	),
	label: Type.Optional(
		Type.String({
			description: 'Short tab label, e.g. "Scope" (defaults to "Q1", "Q2", ...).',
		}),
	),
	question: Type.String({
		description: "The question text shown to the user.",
	}),
	header: Type.Optional(
		Type.String({
			description: "Optional context or instructions shown under the question.",
		}),
	),
	options: Type.Optional(
		Type.Array(QuestionOptionSchema, {
			description:
				"Choices to offer. Omit or leave empty for a free-form question where the user types an answer.",
		}),
	),
	multiple: Type.Optional(
		Type.Boolean({
			description: "Allow multiple selections (default: false).",
		}),
	),
	allowOther: Type.Optional(
		Type.Boolean({
			description:
				'Show a "Type something…" entry so the user can type a custom answer (default: true).',
		}),
	),
	required: Type.Optional(
		Type.Boolean({
			description:
				"Require an answer before the questionnaire can be submitted (default: true). Optional questions can be skipped.",
		}),
	),
	min: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Minimum number of selections for a multiple-choice question.",
		}),
	),
	max: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Maximum number of selections for a multiple-choice question.",
		}),
	),
	placeholder: Type.Optional(
		Type.String({
			description: "Placeholder shown in the free-form editor when it is empty.",
		}),
	),
	otherLabel: Type.Optional(
		Type.String({
			description: 'Custom label for the typed-answer entry (default: "Type something…").',
		}),
	),
});

export const AskUserParamsSchema = Type.Object({
	title: Type.Optional(
		Type.String({
			description: "Optional title shown above the questionnaire.",
		}),
	),
	submitLabel: Type.Optional(
		Type.String({
			description: 'Label of the final submit entry (default: "Submit").',
		}),
	),
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 12,
		description:
			"Questions to ask, in order. Each question gets its own tab; the user can move between tabs freely.",
	}),
});

export const AskUserOutputSchema = Type.Object({
	cancelled: Type.Boolean({
		description: "True when the user cancelled the questionnaire before submitting.",
	}),
	answers: Type.Array(
		Type.Object({
			id: Type.String({ description: "Question id from the request." }),
			question: Type.String({ description: "The question text." }),
			skipped: Type.Boolean({
				description: "True when an optional question was left unanswered.",
			}),
			answers: Type.Array(
				Type.Object({
					value: Type.String({ description: "Machine-readable answer value." }),
					label: Type.String({ description: "Human-readable answer label." }),
					custom: Type.Boolean({
						description: "True when the user typed this answer instead of choosing an option.",
					}),
				}),
			),
		}),
		{ description: "Answers in the same order as the requested questions." },
	),
});

export type AskUserParams = Static<typeof AskUserParamsSchema>;
export type AskUserOutput = Static<typeof AskUserOutputSchema>;
export type RawQuestion = Static<typeof QuestionSchema>;
export type RawQuestionOption = Static<typeof QuestionOptionSchema>;
