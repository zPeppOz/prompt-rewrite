# /rewrite: model role

Approved 2026-10-05. Lets the user run /rewrite on a model other than the session's, picked as a role in omp's model selector.

## Facts verified on omp 18.6.1

- `ctx.runEphemeralTurn` always uses the session model and thinking level: `EphemeralTurnOptions` has no model field (main branch neither).
- The model hub (`/model` → Roles) lists every role in `getKnownRoleIds(settings)`: built-ins plus the keys of `cycleOrder`, `modelRoles` and `modelTags`. A custom role is assignable like a built-in one; omp saves it as `modelRoles.<role>` (global `config.yml`, or the project's when `modelRoleStorage: project`), optionally with a `:level` thinking suffix. Only the `default` role changes the session model; the ctrl+p cycle only follows `cycleOrder`.
- Extensions have no API to register roles. A runtime override of `modelTags` (registry handle `override`) is deep-merged over the persisted layers, survives reloads and is never written to disk.
- An extension can call any model: `streamSimple` (`@oh-my-pi/pi-ai`) with `ctx.modelRegistry.resolver(model, sessionId)` as the key. `resolveModelRoleValue` (`config/model-resolver`) resolves a role value to `{ model, thinkingLevel }`.
- Replaying the session's messages natively on another model is not viable: Anthropic rejects history with `tool_use` blocks when no tools are defined, and an extension can't rebuild the session's tool catalog. omp compacts with another model by serializing the history to text instead.
- Secrets: the host obfuscates outbound messages when `secrets.enabled`; `buildSecretObfuscator(cwd, getAgentDir())` builds the same obfuscator (precedent: `/share`).

## Behavior

- On `session_start` the extension adds a runtime `modelTags.rewrite` entry (name "Rewrite") unless one is configured, so the role shows in the hub without writing any file. Other runtime tag entries are kept.
- At the start of every /rewrite, the role value is read (`modelRoles.rewrite`):
  - unset → session model via `runEphemeralTurn`, as before;
  - set but matching no available model → warning, then the session model;
  - same model and same effective thinking level as the session → `runEphemeralTurn` (prompt cache, full fidelity);
  - otherwise → the extension's own request on the role model.
- Thinking level of the role request: the role's explicit level (already clamped by the resolver); with no level, or `auto`, the session's level clamped to the role model. `off` disables reasoning.
- Role request content:
  - system prompt: the session's (`ctx.getSystemPrompt()`);
  - one user message: a note that no tools are available, the conversation as `<conversation>` transcript (`buildSessionContext` of the current branch, so after the latest compaction; `convertToLlm`; thinking blocks dropped; `serializeConversationForSummary`, which truncates tool output to 2000 characters and escapes boundary tags), then the unchanged questions or rewrite prompt;
  - obfuscated with the session's secret settings, deobfuscated on the way back (preview and final text).
- The transcript and obfuscator are built once per /rewrite and shared by both requests.
- Everything else is unchanged: two requests, preview, Esc, draft restored on cancel or error. The progress widget names the role model.

## Out of scope

Choosing the model in `/rewrite-settings`, per-step models (questions vs rewrite), a context budget for models with a smaller window (the provider error restores the draft), the in-flight assistant text of a running main turn.
