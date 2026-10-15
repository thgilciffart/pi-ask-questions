# pi-ask-questions

Interactive questionnaires for [Pi](https://pi.dev): the model runs an `ask_user` tool and you answer in a proper terminal UI — tabs, multi-select, free-form typing, validation, and a review step.

[![npm](https://img.shields.io/npm/v/pi-ask-questions.svg)](https://www.npmjs.com/package/pi-ask-questions)
[![ci](https://github.com/thgilciffart/pi-ask-questions/actions/workflows/ci.yml/badge.svg)](https://github.com/thgilciffart/pi-ask-questions/actions/workflows/ci.yml)

```text
────────────────────────────────────────────────────────────
 ask_user demo
 Scope  Release  Notes  Submit
────────────────────────────────────────────────────────────
 Which parts of the project should this change touch?
 Select one or more • Space toggles

 ❯ [x] 1. Extension host
       Tool registration and lifecycle code
   [ ] 2. TUI component
       The interactive questionnaire renderer
   [ ] 3. Documentation
   [x] 4. Tests
   Type something…
   ──────────────────────────────────────────────
    custom answer
   ──────────────────────────────────────────────

 ↑↓ move • Space toggle • A all • C clear • 1-9 jump • Enter confirm
────────────────────────────────────────────────────────────
```

## Install

```bash
pi install npm:pi-ask-questions
```

Try it for a single invocation without changing your settings:

```bash
pi -e npm:pi-ask-questions
```

Once installed, run `/ask-demo` to preview the UI, or just let the model call `ask_user` when it needs input.

## Features

- **Tabs** — every question gets a tab, with answered state shown by color (green = answered, accent = partially answered, muted = untouched). Move with `Tab` / `Shift+Tab`.
- **Single-select** radio options with optional descriptions.
- **Multi-select** checkboxes (`multiple: true`), including `min` / `max` validation, `A` to select all, and `C` to clear.
- **Free-form typing** — a question without options is a plain text prompt. Option questions can also hold one typed answer unless `allowOther: false`.
- **Inline editing** — move the cursor onto “Type something…” and type; the editor appears directly under the row with the options still visible. No separate menu, and the answer can be edited again in place.
- **One typed answer per question** — typed answers are never duplicated; editing replaces the previous text.
- **Optional questions** (`required: false`) that can be skipped, plus preset answers (`selected: true`) and defaults.
- **Review tab** — see everything before submitting; jump back to any question to edit it.
- **Validation** — required answers and `min`/`max` selection counts are enforced before submit.
- **Background mode** — set `noWait: true` and the tool returns immediately while the questionnaire stays open; the answers arrive later as a follow-up message.
- **Safe cancel** — `Esc` arms cancellation, a second `Esc` or `Ctrl+C` cancels immediately.
- **Scrollable option lists** — long lists show “n more above / below” indicators.
- **Structured results** — the tool returns text for the model and a machine-readable `structuredContent` payload for codemode scripts.

## How the model uses it

`ask_user` accepts one or more questions. A single-select question resolves immediately; everything else flows into tabs and a submit step.

```json
{
  "title": "Release planning",
  "questions": [
    {
      "id": "scope",
      "label": "Scope",
      "question": "Which packages should the release include?",
      "multiple": true,
      "min": 1,
      "options": [
        { "value": "core", "label": "Core", "description": "Shared runtime code", "selected": true },
        { "value": "cli", "label": "CLI" },
        { "value": "docs", "label": "Docs" }
      ]
    },
    {
      "id": "version",
      "label": "Version",
      "question": "How should we version it?",
      "options": [
        { "value": "patch", "label": "Patch" },
        { "value": "minor", "label": "Minor" },
        { "value": "major", "label": "Major" }
      ]
    },
    {
      "id": "notes",
      "label": "Notes",
      "question": "Anything else I should know?",
      "required": false,
      "placeholder": "Type a note, or leave empty…"
    }
  ]
}
```

The model receives a compact summary such as:

```text
User answered:
Scope: selected "Core", "CLI", typed "shared types"
Version: selected "Minor"
Notes: (skipped)
```

### Parameters

| Field | Type | Description |
| --- | --- | --- |
| `title` | string | Optional title shown above the questionnaire. |
| `submitLabel` | string | Label of the submit entry. Default `Submit`. |
| `questions` | array | 1–12 questions, each rendered as a tab. |
| `questions[].id` | string | Stable id used in the result. Defaults to `q1`, `q2`, … |
| `questions[].label` | string | Short tab label. Defaults to `Q1`, `Q2`, … |
| `questions[].question` | string | The question text. |
| `questions[].header` | string | Optional context shown under the question. |
| `questions[].options` | array | Choices. Omit or leave empty for free-form text. |
| `questions[].options[].value` | string | Value returned when picked. Defaults to the label. |
| `questions[].options[].label` | string | Display label. |
| `questions[].options[].description` | string | Explanation shown below the label. |
| `questions[].options[].selected` | boolean | Preselect the option. |
| `questions[].multiple` | boolean | Allow more than one selection. |
| `questions[].allowOther` | boolean | Show the typed-answer entry. Default `true`. |
| `questions[].required` | boolean | Require an answer before submit. Default `true`. |
| `questions[].min` / `max` | integer | Selection bounds for multi-select. |
| `questions[].placeholder` | string | Placeholder for the free-form editor. |
| `questions[].otherLabel` | string | Custom label for the typed-answer entry. |
| `noWait` | boolean | Show the questionnaire in the background and return immediately (interactive TUI only). The answers arrive as a follow-up message. Only one background questionnaire can be open at a time. |

### Keyboard reference

| Keys | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | Switch tabs |
| `↑` / `↓`, `Home` / `End` | Move the option cursor |
| `Space` | Toggle a checkbox / select a radio option |
| `1`–`9` | Jump to an option (toggles it in multi-select) |
| `A` / `C` | Select all / clear (multi-select) |
| `Enter` | Confirm the question, or submit on the review tab |
| `Esc` | Arm cancel; `Esc` twice cancels |
| `Ctrl+C` | Cancel immediately |
| `\` + `Enter` | Newline in a free-form answer |

## Modes

| Mode | Behavior |
| --- | --- |
| Interactive TUI | Full tabbed questionnaire. |
| Interactive TUI + `noWait` | Tool returns immediately; answers are delivered as a follow-up message. |
| RPC | Sequential fallback built from the dialog API (`select` / `input`). |
| Print / JSON | The tool reports that no UI is available and lists the questions so the model can ask them in plain text. |

## Development

```bash
npm install
npm run check          # typecheck + unit tests
pi -e ./src/extension.ts
```

The pure questionnaire model (`src/questions.ts`), the TUI component (`src/ui/ask-questionnaire.ts`), and the extension wiring are covered by unit and interaction tests that drive the component with raw key sequences.

## Publishing

The package is published to npm as `pi-ask-questions` and carries the `pi-package` keyword, which makes it eligible for the [Pi package gallery](https://pi.dev/packages). `prepublishOnly` runs the full check suite.

```bash
npm login
npm publish
```

## License

MIT
