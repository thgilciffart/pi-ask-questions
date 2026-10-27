# pi-ask-questions

Interactive questionnaires for [Pi](https://pi.dev). The `ask_user` tool supports single-choice, multiple-choice, and typed answers.

## Install

```sh
pi install npm:pi-ask-questions
```

Run `/reload` in an open Pi session. Use `/ask-demo` to try the questionnaire, or let the agent call `ask_user` when it needs input.

## Answer questions

Use Tab and Shift+Tab to switch questions. Select options with Space or keys 1 through 9, then press Enter to confirm. Multiple questions include a review tab before submission.

You can add one typed answer alongside selected options unless the question disables it. Multiple-choice questions can require a minimum or maximum answer count. Typed answers count toward these limits.

| Key | Action |
| --- | --- |
| Up, Down, Home, End | Move through options. |
| Page Up, Page Down | Move by eight options. |
| A, C | Select all or clear multiple-choice options. |
| Enter | Confirm a question or submit from the review tab. |
| Backslash then Enter | Insert a newline in a typed answer. |
| Esc twice, Ctrl+C | Cancel. |

## Tool reference

```json
{
	"mode": "background",
	"questions": [
		{
			"id": "scope",
			"question": "Which packages should change?",
			"multiple": true,
			"min": 1,
			"options": [{ "label": "Core", "value": "core" }, { "label": "CLI", "value": "cli" }]
		}
	]
}
```

`questions` accepts 1 to 12 entries. Each requires `question` text. Optional fields are:

| Field | Meaning |
| --- | --- |
| `id`, `label` | Result ID and tab label. Defaults are `q1` and `Q1`, with increasing numbers. |
| `header` | Context below the question. |
| `options` | Choices with `label`, optional `value`, `description`, and `selected`. Values default to labels. Omit for typed answers. |
| `multiple` | Allows several listed choices. Default `false`. |
| `allowOther` | Allows one typed answer beside listed choices. Default `true`. |
| `required` | Requires an answer. Default `true`. |
| `min`, `max` | Selection limits for multiple-choice questions. |
| `placeholder`, `otherLabel` | Editor placeholder and typed-answer label. |

Top-level `title` and `submitLabel` customize the questionnaire title and submit entry.

`mode: "background"` is the default. In Pi's terminal UI, it returns immediately and delivers answers through the steering queue at the next model or tool boundary. It does not interrupt a running response or tool. Submitting after the agent stops starts a new turn. Only one background questionnaire can be open.

`mode: "urgent"` waits for answers or cancellation. RPC uses sequential selection and input dialogs and waits in either mode. Print and JSON modes return the questions for the agent to ask as text.

The compatibility field `noWait` selects background mode when `true` and urgent mode when `false`. An explicit `mode` takes precedence.

Results include a text summary and `structuredContent` with `cancelled`, optional `pending`, and `answers`. Each entry contains `id`, `question`, `skipped`, and an `answers` array of `{ value, label, custom }` objects. While `pending` is true, answer arrays are empty. Completed background answers arrive as steering text.

## Develop

```sh
npm ci
npm run check
pi -e ./src/extension.ts
```

[MIT license](LICENSE).
