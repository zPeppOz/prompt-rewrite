# prompt-rewrite

[![CI](https://github.com/zPeppOz/prompt-rewrite/actions/workflows/ci.yml/badge.svg)](https://github.com/zPeppOz/prompt-rewrite/actions/workflows/ci.yml)

A `/rewrite` command for [omp](https://github.com/can1357/oh-my-pi) and [Claude Code](https://code.claude.com/docs/en/overview): it turns a rough draft prompt into a thorough, unambiguous one, asking you about its direction first.

It works like `/btw`: it runs as a side request that sees the current conversation, so the rewrite can reference files, errors and decisions already discussed in the session, but nothing is added to the conversation. The result goes into the prompt box for you to review. It uses the session's model unless you pick another one.

The same repository is an omp extension (`index.ts`) and a Claude Code [mod](https://code.claude.com/docs/en/plugins/mods/overview) (`hooks/register.ts`); both share the prompts and the settings logic.

## Requirements

- **omp**: 18.3.0 or newer, the first release that gives extensions `ctx.runEphemeralTurn`. On older versions `/rewrite` reports the required version and stops. `/rewrite-settings` and the **Rewrite** model role need 18.3.1.
- **Claude Code**: 2.1.289 or newer, with mods turned on (the default). On older versions `/rewrite` reports the required version and stops.
- An interactive session: the terminal or desktop app, or for omp an RPC client that answers extension dialogs. In print mode (`omp -p`, `claude -p`) there is no prompt box to receive the result, so `/rewrite` fails immediately without calling the model.

## Installation

Install it only one way at a time per host: each copy registers the same `/rewrite` command.

### Claude Code

```text
/plugin marketplace add zPeppOz/prompt-rewrite
/plugin install prompt-rewrite@prompt-rewrite
```

Or from the shell: `claude plugin marketplace add zPeppOz/prompt-rewrite`, then `claude plugin install prompt-rewrite@prompt-rewrite`. Run `/reload-plugins` in a session that was already open. `/plugin` then shows `1 mod active · prompt-rewrite` (or more, with other mods).

To try a local clone for one session: `claude --plugin-dir ./prompt-rewrite`.

### omp

```text
/marketplace add zPeppOz/prompt-rewrite
/marketplace install prompt-rewrite@prompt-rewrite
```

Or from the shell: `omp plugin marketplace add zPeppOz/prompt-rewrite`, then `omp plugin install prompt-rewrite@prompt-rewrite`. Restart omp afterwards: extension modules load when a session starts.

To update, run `/marketplace update prompt-rewrite`, then `/marketplace upgrade prompt-rewrite@prompt-rewrite` and restart. To remove it, run `/marketplace uninstall prompt-rewrite@prompt-rewrite`.

From git: `omp plugin install github:zPeppOz/prompt-rewrite`. From a local clone: `omp plugin link ./prompt-rewrite`.

**Upgrading from omp-rewrite** (0.4.0 and earlier): the plugin and its marketplace are now named `prompt-rewrite`. Remove the old copy (`/marketplace uninstall omp-rewrite@omp-rewrite`, or delete the `omp-rewrite` link) and install the new one; the settings below keep their names.

## Usage

```text
/rewrite <draft>
```

The draft can span several lines: end a line with `\` (or press Shift+Enter where the terminal supports it) to continue on the next. In omp you can also run `/rewrite` with no arguments to open an editor for a longer draft; closing it with Esc cancels.

## How it works

1. **Direction questions**: the model reads the draft together with the session context and asks up to 4 questions about goal, scope, constraints, deliverable and acceptance criteria, each with suggested options, a recommended choice, and a free-form answer. Anything the conversation already answers is not asked; if the direction is already clear, this step is skipped. If the model's reply can't be read, you get a warning and the rewrite goes ahead without questions.
2. **Rewrite**: the model rewrites the draft using your answers and your [custom instructions](#custom-instructions), if any.
3. **Result in the prompt box**: the rewritten prompt is placed in the prompt box, so you can review or edit it before pressing Enter. Text you typed in the meantime is kept and the rewrite is appended after it.
4. **Cancel**: press Esc while the model is working, or close the questions dialog. On cancel or error, your original draft is put back in the prompt box.

While the model works, a line above the prompt names the step and the model. omp also streams the last lines of the rewrite there; Claude Code gets the reply in one piece, so it shows the seconds elapsed instead.

Every message starts with the command name (`/rewrite:` or `/rewrite-settings:`), for example `/rewrite: cancelled; draft restored to the prompt`.

## Choosing the model

By default `/rewrite` uses the session's model and its thinking level or effort, as a side request that shares the session's prompt cache.

### Claude Code

Set the plugin's **Rewrite model** option, a row in `/config`: an alias (`haiku`, `sonnet`, `opus`) or a full model id, resolved like `--model`. **Rewrite effort** sets the effort for that model (`low` to `max`); `default` leaves the model's own. Empty model: the session's model. The values are stored in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "prompt-rewrite@prompt-rewrite": {
      "options": { "model": "haiku", "effort": "low" }
    }
  }
}
```

The model must be one your session's provider serves: `/rewrite` calls it with the session's credentials. A model the provider doesn't know, or one your organization blocks, gives a warning and `/rewrite` uses the session's model.

### omp

Assign the `rewrite` role in omp's model selector:

1. Run `/model` and open the Roles view: the extension adds a **Rewrite** role there.
2. Select it, press Enter, pick the model, then the thinking level.

omp saves the choice like any other role, as `modelRoles.rewrite` in `~/.omp/agent/config.yml` (in the project's `.omp/config.yml` if you use `modelRoleStorage: project`). It doesn't change the session's model or the ctrl+p cycle. Press `x` on the role row to clear it. You can also set it by hand:

```yaml
modelRoles:
  rewrite: anthropic/claude-haiku-4-5:low # thinking level optional
```

- **Thinking level**: the one in the role (`:low`). Without one, or with `:auto`, the session's level, adapted to what the model supports.
- **A model that isn't available** (provider logged out, model removed): `/rewrite` warns and uses the session's model.
- With `secrets.enabled`, secrets are obfuscated as in the session.

### On another model

omp and Claude Code both run side requests on the session's model only, so on another model `/rewrite` sends the two requests itself. The model gets the session's system prompt and the conversation as a text transcript (after the latest compaction, tool outputs cut to 2000 characters, thinking left out). The role or option is read at the start of every `/rewrite`.

## Custom instructions

Add your own instructions to the prompt that rewrites the draft, globally and per project.

| Key | Type | Default |
| --- | --- | --- |
| instructions | text | empty |
| instructions mode | `append` or `replace` | `append` |

**Order.** When both scopes have text, both apply: global first, then project, and the prompt tells the model the project instructions win on conflict. If one is empty or missing, only the other applies. With neither, the prompt is the default one.

**Mode.** One effective value: the project's, else the global one, else `append`.

- `append`: your instructions are added to the default rewrite rules. If one conflicts with a default rule, yours wins; the output is still only the rewritten prompt.
- `replace`: your instructions replace the default rewrite rules. What always stays: the draft, your answers to the questions, and a short frame saying what the draft is, that it must not be executed or answered, and that only the rewritten prompt is output (it goes into the prompt box verbatim). With no instructions at all, `replace` has nothing to replace with and the default prompt is used.

The model receives your text inside a `<custom_instructions>` block, with a `<global>` and a `<project>` section, before the draft. Custom instructions apply to the rewrite step only, not to the direction questions. An invalid value is ignored with a warning.

### Claude Code

```text
/rewrite-settings [global|project] [instructions]
```

- `/rewrite-settings` alone asks for the scope, then puts `/rewrite-settings <scope> <current text>` in the prompt box: edit the text there (on several lines if you like) and press Enter.
- `/rewrite-settings <scope> <text>` asks for the mode, then saves. `/rewrite-settings <scope>` with no text clears that scope.
- Esc in a dialog cancels without changing anything.

| Scope | Where |
| --- | --- |
| Global | The plugin's **Rewrite instructions** and **Rewrite instructions mode** options: rows in `/config`, stored under `pluginConfigs` in `~/.claude/settings.json`. Saving them reloads the mod. |
| Project | `<cwd>/.claude/rewrite.json`, which you can commit or edit by hand: `{ "instructions": "...", "instructionsMode": "append" }`. Other keys in it are kept. A file that isn't a JSON object is left untouched: `/rewrite-settings` reports an error and `/rewrite` ignores it with a warning. |

### omp

```text
/rewrite-settings
```

Pick a scope, edit the text in the editor (saving it empty clears that scope), then pick the mode. Esc at any step cancels without changing anything. The field is a command because omp's `/settings` panel can't show extension fields. The values are ordinary omp settings:

| Scope | File | Written by `/rewrite-settings` |
| --- | --- | --- |
| Global | `~/.omp/agent/config.yml` | Through omp's own settings store, like `/settings` |
| Project | `<cwd>/.omp/config.yml` | Directly by the extension |

```yaml
rewrite:
  instructions: |-
    Always write the prompt in English.
    Keep it under 200 words.
  instructionsMode: append # or "replace"; default "append"
```

## Known limitations

- Each rewrite makes two model calls (questions, then rewrite), so with a slow or expensive model it is slow or expensive. On the session's model they reuse its prompt cache. On another model, each call sends the system prompt and the whole transcript again, and a conversation longer than that model's context window fails (the draft is restored).
- On another model the conversation arrives as a transcript, so the model doesn't see long tool outputs past 2000 characters or a reply the agent is still writing.
- In multiple-choice questions, a question left with no option selected is treated as unanswered and ignored.
- Only one `/rewrite` runs at a time; starting another one while it runs shows `/rewrite: already running`.
- **Claude Code**:
  - In a session that hasn't had a reply yet there is nothing to fork, so `/rewrite` sends the two requests to the session's model as on another model.
  - Esc cuts the request, but what the model already generated may still be billed.
  - A typed `/rewrite` waits for a running turn to end, like other commands.
  - The rewrite model must be one the session's provider serves. The Claude Code options have no thinking-level suffix: use **Rewrite effort**.
  - `.claude/rewrite.json` is written in place, not atomically.
  - In the VS Code extension's chat panel and in `claude -p` mods draw nothing; `/rewrite` needs the terminal or the desktop app.
- **omp**:
  - Hosts without omp's ask dialog (RPC and ACP clients) show one select per question: the recommended option is marked in its description, "Other…" opens a free-text input, and multiple-choice questions accept a single option. Esc cancellation is not available there.
  - `/rewrite-settings` writes `<cwd>/.omp/config.yml` itself, because omp never writes project keys. Other keys in that file are kept, but the file is re-serialized, so YAML comments in it are lost. A file that isn't a YAML mapping, or doesn't parse, is left untouched and the command reports an error.

## Development

```sh
bun run test          # shared logic and the omp extension (*.spec.ts)
claude plugin test    # the Claude Code mod (tests/*.test.ts)
claude plugin validate --strict .
```

- `rewrite.ts` and `instructions.ts` have no host dependencies: the prompts, the transcript framing and serialization for another model, the parsing of the model's questions and their Claude Code dialog format, the preview layout, and how the global and project settings combine.
- omp: `index.ts` wires the commands (dialogs, side turns, widget, composer); `model.ts` handles the `rewrite` role; `storage.ts` writes the settings.
- Claude Code: `hooks/register.ts` is the mod (`.claude-plugin/plugin.json` is its manifest, `hooks/hooks.json` points to it). It may import only files inside the repository, never omp's packages. Loading it with `--plugin-dir` writes the mods API types for your Claude Code version to `.claude-plugin/types/` and a `tsconfig.json` (both ignored by git).
- `claude plugin test` runs every `*.test.ts`, so the bun tests are named `*.spec.ts`.

The project has no runtime dependencies.

To release, bump `version` in `package.json`, `.omp-plugin/marketplace.json` and `.claude-plugin/plugin.json` (`marketplace.spec.ts` checks they match) and add a [CHANGELOG](CHANGELOG.md) entry. Both hosts compare that version to find updates, so a missed bump means users don't get the update.

## License

[MIT](LICENSE)
