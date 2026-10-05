# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Breaking

- The project is now **prompt-rewrite**: the package, the plugin and its marketplace are named `prompt-rewrite` (`prompt-rewrite@prompt-rewrite`). Remove `omp-rewrite` (`/marketplace uninstall omp-rewrite@omp-rewrite`, or the `omp-rewrite` link) before installing the new name. The command is still `/rewrite`, and the omp settings keep their names.

### Added

- A Claude Code mod in the same repository, for Claude Code 2.1.289 or newer: `/rewrite` and `/rewrite-settings`, installable from the repository's Claude Code marketplace (`.claude-plugin/marketplace.json`). The requests are forks of the session (same model, system prompt and prompt cache, no tools), all the questions open in one dialog with option descriptions and the recommended option marked, Esc cancels, the result goes to the prompt box, and nothing is added to the conversation.
- Claude Code options, as rows in `/config`: **Rewrite model** and **Rewrite effort** (another model gets the conversation as a transcript, like the omp role), and the global instructions and mode. Project instructions live in `.claude/rewrite.json`; `/rewrite-settings` with no arguments puts the current text in the prompt box for editing.

### Changed

- Each question from the model keeps at most 4 options, as its prompt already asked; the Claude Code dialog accepts no more.

## [0.4.0] - 2026-10-05

### Added

- A `rewrite` model role to run `/rewrite` on a model other than the session's. The extension lists it as **Rewrite** in omp's model selector (`/model` → Roles) without writing any file. omp saves the choice as `modelRoles.rewrite`, with an optional thinking level (`provider/id:low`).
- On a model other than the session's, `/rewrite` sends the requests itself, because omp's side turns always use the session model. The model gets the session's system prompt and the conversation as a transcript; secrets are obfuscated as in the session when `secrets.enabled` is on. Without the role, or with the session's model and thinking level, nothing changes.
- A role pointing to an unavailable model shows a warning, and `/rewrite` uses the session's model.

## [0.3.0] - 2026-09-29

### Added

- Custom instructions for the rewrite prompt, global (`~/.omp/agent/config.yml`) and per project (`<cwd>/.omp/config.yml`), as `rewrite.instructions` and `rewrite.instructionsMode`. When both scopes have text, both apply, global first, then project. Without any, the prompt is unchanged.
- `rewrite.instructionsMode`: `append` (default) adds the instructions to the default rewrite rules; `replace` swaps the rules for yours, keeping the draft, your answers and a short output frame. The effective mode is the project's, else the global one, else `append`.
- `/rewrite-settings` command to edit the instructions of a scope in an editor (saving empty clears it) and pick the mode. It exists because omp's `/settings` panel can't show extension fields.

### Fixed

- Long rewrites no longer end in `[…truncated]`. omp cuts side-turn replies to 4 KiB and collapses runs of identical lines unless told otherwise; `/rewrite` now asks for the full reply, for both the rewrite and the questions JSON.

## [0.2.0] - 2026-09-25

### Breaking

- In sessions without an interactive UI (print and JSON modes), `/rewrite` now fails immediately with an error. Before, it made the model calls and silently discarded the result.
- On omp older than 18.3.0, `/rewrite` reports the required version before asking for a draft. Before, it failed only after you had written the draft.
- All notifications now use the `/rewrite: …` format (for example `/rewrite: cancelled; draft restored to the composer`). RPC clients that match the old texts need updating.

### Added

- An omp plugin marketplace catalog (`.omp-plugin/marketplace.json`). Install with `/marketplace add zPeppOz/omp-rewrite` and `/marketplace install omp-rewrite@omp-rewrite`.
- A test suite (`bun test`) and CI.

### Changed

- A single malformed question from the model no longer drops all questions. Invalid optional fields (`header`, `multi`, `recommended`) are ignored, and options given as plain strings are accepted.
- The streaming preview wraps long lines and follows the newest text. Before, it froze on the first ~100 characters of a long line. Preview updates are throttled to 10 per second: an RPC rewrite that sent 412 widget frames now sends 9.
- Hosts without the rich ask dialog (RPC, ACP) mark the recommended option in its description.
- The "(Esc to cancel)" hint only appears in the TUI, the only mode where Esc reaches the extension.
- Closing the draft editor with Esc cancels without a warning. Submitting it empty shows the usage.
- Pressing Esc while a side turn is finishing counts as a cancel. Before, the result was still placed in the composer.

## [0.1.0] - 2026-09-25

### Added

- `/rewrite` command: direction questions, rewrite, result in the composer.
