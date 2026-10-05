import type { On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";

/** Cosa ha cambiato /rewrite-settings. */
interface Seen {
	config: { key: string; value: unknown }[];
	writes: { path: string; text: string }[];
	filled: string[];
	dialogs: unknown[][];
	messages: string[];
}

/**
 * Stub di una sessione interattiva: `project` è `.claude/rewrite.json` (assente = il file
 * non c'è) e il dialogo risponde `answer` alla sua prima domanda (`undefined` = chiuso).
 */
function session(on: On, { project, answer }: { project?: string; answer?: string }): Seen {
	const seen: Seen = { config: [], writes: [], filled: [], dialogs: [], messages: [] };
	on("session.surfaces", () => ({ value: ["terminal"] }));
	on("session.version", () => ({ value: { version: "2.1.289" } }));
	on("session.cwd", () => ({ value: "/work" }));
	on("fs.exists", () => ({ value: project !== undefined }));
	on("fs.read", () => ({ value: project ?? "" }));
	on("fs.write", ($, e) => {
		seen.writes.push({ path: e.path, text: e.text });
		return { value: undefined };
	});
	on("config.set", ($, e) => {
		seen.config.push({ key: e.key, value: e.value });
		return { value: e.value };
	});
	on("prompt.fill", ($, e) => {
		seen.filled.push(e.text);
		return { isFilled: true };
	});
	on("tool.call", ($, e) => {
		if (e.tool !== "AskUserQuestion") throw new Error(`unexpected tool ${e.tool}`);
		seen.dialogs.push(e.questions);
		const [first] = e.questions;
		if (answer === undefined || !first) return { deny: "The user doesn't want to proceed with this tool use." };
		return { result: { questions: e.questions, answers: { [first.question]: answer } } };
	});
	on("ui.toast", ($, e) => {
		seen.messages.push(e.text);
		return { value: undefined };
	});
	on("ui.log", ($, e) => {
		seen.messages.push(e.text);
		return { value: undefined };
	});
	return seen;
}

/** `/rewrite-settings <args>` scritto nel prompt. */
function settings($: Engine, args: string) {
	return $.command.run({ command: "rewrite-settings", args, origin: { kind: "composer" }, presentation: { isFullscreen: false, columns: 120 } });
}

test("project instructions on several lines are saved with the chosen mode, keeping the other keys", async ($, on) => {
	const seen = session(on, { project: '{ "other": 1 }', answer: "replace" });

	await settings($, "project line one\nline two");

	// Il kit passa il percorso già risolto rispetto alla directory di lavoro.
	expect(seen.writes.map(w => w.path.endsWith("/.claude/rewrite.json"))).toEqual([true]);
	expect(seen.writes[0]?.text).toBe('{\n  "other": 1,\n  "instructions": "line one\\nline two",\n  "instructionsMode": "replace"\n}\n');
	expect(seen.messages).toEqual(["/rewrite-settings: project instructions saved (mode replace) in /work/.claude/rewrite.json"]);
});

test("inherit removes the project's mode so the global one applies", async ($, on) => {
	const seen = session(on, { project: '{ "instructions": "old", "instructionsMode": "replace" }', answer: "inherit" });

	await settings($, "project new text");

	expect(JSON.parse(seen.writes[0]?.text ?? "")).toEqual({ instructions: "new text" });
});

test("global instructions are saved through /config, one row per field", async ($, on) => {
	const seen = session(on, { answer: "append (Recommended)" });

	await settings($, "global Always answer in English.");

	expect(seen.config.map(c => [c.key.slice(c.key.lastIndexOf(".") + 1), c.value])).toEqual([
		["instructions", "Always answer in English."],
		["instructions_mode", "append"],
	]);
	expect(seen.writes).toEqual([]);
});

test("a scope with no text clears it, and clearing a missing project file creates nothing", async ($, on) => {
	const seen = session(on, {});

	await settings($, "project");
	await settings($, "global");

	expect(seen.writes).toEqual([]);
	expect(seen.dialogs).toEqual([]);
	expect(seen.config.map(c => c.value)).toEqual(["", "append"]);
});

test("without arguments the chosen scope's current text goes to the prompt for editing", async ($, on) => {
	const seen = session(on, { project: '{ "instructions": "Keep it short.\\nUse English." }', answer: "Project" });

	await settings($, "");

	expect(seen.filled).toEqual(["/rewrite-settings project Keep it short.\nUse English."]);
	expect(seen.writes).toEqual([]);
});

test("closing the mode dialog changes nothing", async ($, on) => {
	const seen = session(on, { project: '{ "instructions": "old" }' });

	await settings($, "project new text");

	expect(seen.dialogs).toHaveLength(1);
	expect(seen.writes).toEqual([]);
});

test("an unknown scope shows the usage", async ($, on) => {
	const seen = session(on, {});

	await settings($, "everywhere text");

	expect(seen.messages).toEqual(["/rewrite-settings: usage: /rewrite-settings [global|project] [instructions]"]);
	expect(seen.writes).toEqual([]);
});

test("a project file that isn't a JSON object is left untouched", async ($, on) => {
	const seen = session(on, { project: "[1, 2]", answer: "append" });

	await settings($, "project text");

	expect(seen.writes).toEqual([]);
	expect(seen.messages).toEqual(["/rewrite-settings: failed (.claude/rewrite.json is not a JSON object; fix it by hand first)"]);
});
