# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-15

### Changed

- Removed decorative icons from tabs, option rows, the review tab, and tool output. Only the selection markers (`[x]` / `[ ]` / `(•)`) and the cursor remain.
- Option questions now hold at most one typed answer. The inline editor appears directly under the “Type something…” row with the options still visible, and moving onto that row starts editing immediately instead of opening a separate view.
- Free-form questions always resolve to a single typed answer; `multiple`, `min`, and `max` no longer apply when a question has no options.

### Added

- `noWait` parameter: open the questionnaire in the background and return immediately, delivering the answers later as a follow-up message. Only one background questionnaire can be open at a time; it is cancelled safely on session shutdown.

## [0.1.0] - 2026-10-15

### Added

- `ask_user` tool with tabbed questionnaires, single-select and multi-select options, free-form typing, and multiple typed answers per question.
- Validated answers: required questions, `min`/`max` selection counts, optional questions that can be skipped, and preselected defaults.
- Review tab that summarizes all answers and allows jumping back to edit any question.
- Safe cancellation (Esc twice or Ctrl+C) and abort-signal support.
- Scrollable, width-aware rendering with option descriptions, placeholders, and status icons.
- Structured tool output (`structuredContent`) alongside a compact model-facing summary.
- RPC dialog fallback for modes without custom components, and a plain-text fallback for non-interactive modes.
- `/ask-demo` command to preview the questionnaire UI.
- Unit and interaction tests covering normalization, validation, formatting, rendering, and keyboard flows.
