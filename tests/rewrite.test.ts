import type { ModelCompleteResult, ModelForkResult, On } from "claude-code";
import { type Engine, expect, mock, test } from "claude-code/testing";

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const answered = (text: string): ModelCompleteResult => ({ isAnswered: true, text, usage });
const NO_QUESTIONS = answered('{"questions":[]}');
const QUESTIONS = answered(
	JSON.stringify({
		questions: [
			{
				header: "Scope",
				question: "Scope?",
				options: [
					{ label: "Module", description: "Only auth" },
					{ label: "Repo", description: "Everything" },
				],
				recommended: 0,
			},
			{ question: "Checks?", options: ["Tests", "Lint"], multi: true },
		],
	}),
);

/** Cosa ha visto Claude Code durante un comando. */
interface Seen {
	forks: string[];
	completes: { model: string; system?: string; prompt: string; effort?: string; maxTokens?: number }[];
	dialogs: unknown[][];
	filled: string[];
	messages: string[];
}

interface SessionSetup {
	surfaces?: ("terminal" | "desktop")[];
	/** Testo già nel prompt quando arriva il risultato. */
	typed?: string;
	/** Contenuto di `.claude/rewrite.json`; assente = il file non c'è. */
	project?: string;
}

/** Stub comuni: sessione interattiva su Claude Code 2.1.289. */
function session(on: On, { surfaces = ["terminal"], typed = "", project }: SessionSetup = {}): Seen {
	const seen: Seen = { forks: [], completes: [], dialogs: [], filled: [], messages: [] };
	mock.clock(on);
	on("session.surfaces", () => ({ value: surfaces }));
	on("session.version", () => ({ value: { version: "2.1.289" } }));
	on("session.model", () => ({ value: "claude-sonnet-5-5" }));
	on("prompt.read", () => ({ value: { text: typed, cursor: 0 } }));
	on("prompt.fill", ($, e) => {
		seen.filled.push(e.text);
		return { isFilled: true };
	});
	on("ui.toast", ($, e) => {
		seen.messages.push(e.text);
		return { value: undefined };
	});
	on("ui.log", ($, e) => {
		seen.messages.push(e.text);
		return { value: undefined };
	});
	on("fs.exists", () => ({ value: project !== undefined }));
	on("fs.read", () => ({ value: project ?? "" }));
	return seen;
}

/** Il fork della sessione risponde con `replies`, nell'ordine. */
function forks(on: On, seen: Seen, replies: ModelForkResult[]): void {
	on("model.fork", ($, e) => {
		seen.forks.push(e.prompt);
		const reply = replies[seen.forks.length - 1];
		if (!reply) throw new Error("unexpected fork");
		return { value: reply };
	});
}

/** `$.model.complete` risponde con `replies`, nell'ordine, su una conversazione di due messaggi. */
function completes(on: On, seen: Seen, replies: ModelCompleteResult[]): void {
	on("model.complete", ($, e) => {
		seen.completes.push({ model: e.model, system: e.system, prompt: e.prompt, effort: e.effort, maxTokens: e.maxTokens });
		const reply = replies[seen.completes.length - 1];
		if (!reply) throw new Error("unexpected completion");
		return { value: reply };
	});
	on("session.messages", () => ({
		value: [
			{ role: "user", content: [{ type: "text", text: "the login fails" }] },
			{ role: "assistant", content: [{ type: "text", text: "Look at auth.ts" }] },
		],
	}));
	on("prompt.compose", () => ({
		sections: [
			{ id: "intro", text: "You are Claude Code.", scope: "shared" },
			{ id: "env", text: "Working directory: /work", scope: "session" },
		],
	}));
}

/** Il dialogo delle domande risponde con `answers` (testo della domanda → risposta); `undefined` = chiuso. */
function dialog(on: On, seen: Seen, answers: Record<string, string> | undefined): void {
	on("tool.call", ($, e) => {
		if (e.tool !== "AskUserQuestion") throw new Error(`unexpected tool ${e.tool}`);
		seen.dialogs.push(e.questions);
		return answers ? { result: { questions: e.questions, answers } } : { deny: "The user doesn't want to proceed with this tool use." };
	});
}

/** `/rewrite <args>` scritto nel prompt. */
function rewrite($: Engine, args: string) {
	return $.command.run({ command: "rewrite", args, origin: { kind: "composer" }, presentation: { isFullscreen: false, columns: 120 } });
}

test("asks every question in one dialog, rewrites with the answers and appends the result to the prompt", async ($, on) => {
	const seen = session(on, { typed: "typed meanwhile" });
	forks(on, seen, [QUESTIONS, answered("REWRITTEN")]);
	dialog(on, seen, { "Scope?": "Module (Recommended)", "Checks?": "Tests, Lint" });

	await rewrite($, "fix the login bug");

	expect(seen.dialogs).toEqual([
		[
			{
				question: "Scope?",
				header: "Scope",
				options: [
					{ label: "Module (Recommended)", description: "Only auth" },
					{ label: "Repo", description: "Everything" },
				],
				multiSelect: false,
			},
			{
				question: "Checks?",
				header: "Question 2",
				options: [
					{ label: "Tests", description: "" },
					{ label: "Lint", description: "" },
				],
				multiSelect: true,
			},
		],
	]);
	expect(seen.forks[1]).toContain("- Q: Scope?\n  A: Module\n- Q: Checks?\n  A: Tests, Lint");
	expect(seen.filled).toEqual(["typed meanwhile\n\nREWRITTEN"]);
});

test("Esc while the model works puts the draft back", async ($, on) => {
	const seen = session(on);
	forks(on, seen, [{ isAnswered: false, reason: "aborted", usage }]);

	await rewrite($, "fix the login bug");

	expect(seen.filled).toEqual(["fix the login bug"]);
	expect(seen.messages).toContain("/rewrite: cancelled; draft restored to the prompt");
});

test("closing the questions dialog puts the draft back without rewriting", async ($, on) => {
	const seen = session(on);
	forks(on, seen, [QUESTIONS]);
	dialog(on, seen, undefined);

	await rewrite($, "fix the login bug");

	expect(seen.forks).toHaveLength(1);
	expect(seen.filled).toEqual(["fix the login bug"]);
});

test("an API error puts the draft back and says why", async ($, on) => {
	const seen = session(on);
	forks(on, seen, [{ isAnswered: false, reason: "api-error", status: 529, error: "overloaded", usage }]);

	await rewrite($, "fix the login bug");

	expect(seen.filled).toEqual(["fix the login bug"]);
	expect(seen.messages).toContain("/rewrite: failed (the model request failed: overloaded (HTTP 529)); draft restored to the prompt");
});

test("unreadable questions are skipped with a warning", async ($, on) => {
	const seen = session(on);
	forks(on, seen, [answered("The draft is clear enough."), answered("REWRITTEN")]);

	await rewrite($, "fix the login bug");

	expect(seen.messages).toContain("/rewrite: couldn't read the model's questions; rewriting without them");
	expect(seen.forks[1]).toContain("<decisions>\n(none)\n</decisions>");
	expect(seen.filled).toEqual(["REWRITTEN"]);
});

test("a headless run fails before calling the model", async ($, on) => {
	const seen = session(on, { surfaces: [] });
	forks(on, seen, []);

	const result = await rewrite($, "fix the login bug");

	expect(result.text).toMatch(/needs an interactive session/);
	expect(seen.forks).toHaveLength(0);
});

test("an empty draft shows the usage", async ($, on) => {
	const seen = session(on);
	forks(on, seen, []);

	await rewrite($, "  ");

	expect(seen.messages).toEqual(["/rewrite: empty draft; usage: /rewrite <draft>"]);
	expect(seen.forks).toHaveLength(0);
});

test("a new session with nothing to fork sends both requests to the session's model", async ($, on) => {
	const seen = session(on);
	forks(on, seen, [{ isAnswered: false, reason: "nothing-to-fork" }]);
	completes(on, seen, [NO_QUESTIONS, answered("REWRITTEN")]);

	await rewrite($, "fix the login bug");

	expect(seen.forks).toHaveLength(1);
	expect(seen.completes.map(c => c.model)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
	expect(seen.completes[0]?.system).toBe("You are Claude Code.\n\nWorking directory: /work");
	expect(seen.filled).toEqual(["REWRITTEN"]);
});

test(
	"the configured model gets the conversation as a transcript, its effort and room for a long rewrite",
	{ options: { model: "haiku", effort: "low" } },
	async ($, on) => {
		const seen = session(on);
		forks(on, seen, []);
		completes(on, seen, [NO_QUESTIONS, answered("REWRITTEN")]);

		await rewrite($, "fix the login bug");

		expect(seen.forks).toHaveLength(0);
		expect(seen.completes[0]).toMatchObject({ model: "haiku", effort: "low", maxTokens: 16000 });
		expect(seen.completes[0]?.prompt).toContain("<conversation>\n[User]: the login fails\n\n[Assistant]: Look at auth.ts\n</conversation>");
		expect(seen.filled).toEqual(["REWRITTEN"]);
	},
);

test("a model the provider doesn't know falls back to the session's model with a warning", { options: { model: "nope-1" } }, async ($, on) => {
	const seen = session(on);
	forks(on, seen, [NO_QUESTIONS, answered("REWRITTEN")]);
	completes(on, seen, [{ isAnswered: false, reason: "api-error", status: 404, error: "model_not_found", usage }]);

	await rewrite($, "fix the login bug");

	expect(seen.messages).toContain('/rewrite: the model "nope-1" can\'t be used (model_not_found); using the session\'s model');
	expect(seen.forks).toHaveLength(2);
	expect(seen.filled).toEqual(["REWRITTEN"]);
});

test(
	"global and project instructions both reach the rewrite prompt, with the project's mode",
	{ options: { instructions: "GLOBAL TEXT", instructions_mode: "append" } },
	async ($, on) => {
		const seen = session(on, { project: '{ "instructions": "PROJECT TEXT", "instructionsMode": "replace" }' });
		forks(on, seen, [NO_QUESTIONS, answered("REWRITTEN")]);

		await rewrite($, "fix the login bug");

		const rewritePrompt = seen.forks[1] ?? "";
		expect(rewritePrompt).toContain("<global>\nGLOBAL TEXT\n</global>");
		expect(rewritePrompt).toContain("<project>\nPROJECT TEXT\n</project>");
		expect(rewritePrompt).toMatch(/^<custom_instructions>\nThe user replaced the default rewrite rules/);
	},
);

test("an unreadable project file is ignored with a warning instead of stopping the rewrite", async ($, on) => {
	const seen = session(on, { project: "{ not json" });
	forks(on, seen, [NO_QUESTIONS, answered("REWRITTEN")]);

	await rewrite($, "fix the login bug");

	expect(seen.messages.some(m => m.startsWith("/rewrite: ignoring the project instructions (can't read .claude/rewrite.json"))).toBe(true);
	expect(seen.filled).toEqual(["REWRITTEN"]);
});
