# /rewrite: Claude Code mod

Approved 2026-10-05. Ports the omp extension to a Claude Code mod in the same repository, renamed prompt-rewrite; `/rewrite` keeps its name.

## Facts verified on Claude Code 2.1.289

Checked with a throwaway mod loaded through `--plugin-dir` and the types Claude Code writes for its build (the copy on GitHub, written by 2.1.277, is older and differs on `$.model.*`).

- A mod is a plugin whose `hooks/hooks.json` names a hooks module exporting `register(on, options)`; `options` holds the manifest's `userConfig` values, and changing one reloads the mod. The module may import files inside the plugin by relative path but has no Node or Bun APIs and no dynamic `import()`; the shared modules therefore import nothing from omp.
- `$.model.fork({ prompt })` re-sends the main thread's last request with `prompt` appended: same model, system prompt, tools (all denied) and prompt cache. It resolves `{ isAnswered, text, usage }` or a `reason`: `nothing-to-fork` before the first reply, `api-error`, `empty-reply`, `aborted`. An 8,100-token reply came back whole.
- `$.model.complete({ model, system, prompt, maxTokens, effort })`: aliases or full ids resolved like `--model`, session credentials, `maxTokens` 1024 by default. An unknown id resolves `api-error` with status 404 `model_not_found`; a blocked model rejects. No streaming in either call.
- `$.session.messages({ as: "api" })` returns the messages the next request is built from, after the last compaction; `$.prompt.compose()` returns the system prompt's sections.
- A plugin command that returns `{}`, and the `AskUserQuestion` dialog opened by `$.ui.ask`, leave nothing in the conversation the model reads (built-in commands such as `/reload-plugins` do).
- Esc while a command hook awaits `$.model.fork` aborts `next.signal`, the fork resolves `aborted`, and `$.prompt.fill` still works afterwards. The prompt box stays editable while the hook runs.
- `e.args` keeps newlines (`\` then Enter).
- `$.ui.ask` asks one question with bare labels. `$.tool.call({ tool: "AskUserQuestion" })` is refused ("that is $.ui.ask"), but the plugin's own `tool.call` hook on `AskUserQuestion` sees the call `$.ui.ask` raises and can replace its `questions` (up to 4, with option descriptions); the tool result carries `answers` keyed by question text, multi-select comma-joined.
- `$.config.set` on a `userConfig` row accepts multi-line text and stores it under `pluginConfigs` in `~/.claude/settings.json`; a `string` field with `options` is a picker in `/config`.
- omp 18.6.1 keeps loading the extension, with no warning from `omp plugin doctor`, with `.claude-plugin/` and `hooks/` in the package.

## Behavior

- `/rewrite <draft>`: fails fast with no surfaces (`-p`), below 2.1.289, while another run is active, or with an empty draft. Otherwise:
  - target: the `model` option empty, or equal to the session's model with no `effort` → fork; else `$.model.complete` with the composed system prompt, the transcript (`serializeTranscript`: the omp format, tool output cut to 2000 characters, thinking dropped) and `maxTokens` 16000;
  - the first request falls back to the session's model when the configured one is unknown (404) or refused, with a warning; `nothing-to-fork` sends both requests to `$.session.model()` through `complete`;
  - questions: `$.ui.ask` on the first question while the mod's `tool.call` hook swaps in all of them (`toAskUserQuestions`: header required, recommended option marked `(Recommended)`); answers come back without the mark. Closing the dialog cancels;
  - a line above the prompt names the step, the model and the seconds elapsed (redrawn once a second); Esc cancels;
  - the result is appended to the prompt box after text typed meanwhile; on cancel or error the draft goes back there. A box that refuses the text gets it as a transcript line instead.
- `/rewrite-settings [global|project] [text]`: no arguments → pick the scope, then the prompt box gets `/rewrite-settings <scope> <current text>` to edit; scope and text → pick the mode (`inherit` for the project) and save; scope alone → clear. Global: the `instructions` and `instructions_mode` options through `$.config.set`. Project: `.claude/rewrite.json` (`{ instructions, instructionsMode }`), other keys kept, never overwritten when it isn't a JSON object, not created to clear.
- Messages: information as toasts, warnings and errors as transcript lines the model doesn't read.
- Shared with omp: prompts, question parsing (now at most 4 options per question), instructions resolution, mode choices.

## Out of scope

Streaming preview (no API), non-Anthropic models for the rewrite, a thinking level suffix on the model option (`effort` instead), a custom pane for the questions.
