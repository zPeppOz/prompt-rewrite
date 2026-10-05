import { describe, expect, test } from "bun:test";
import { MAX_QUESTIONS, parseQuestions, previewRows, questionsPrompt, rewritePrompt, withTranscript } from "./rewrite";

const option = (label: string) => ({ label });

describe("rewritePrompt", () => {
	const draft = "fix the login bug";
	const answers = [{ question: "Scope?", answer: "Only auth" }];
	// Regole di default = tutto ciò che precede i dati; evita di fissare il loro testo nei test.
	const defaultRules = rewritePrompt("", []).split("\n\n<draft>")[0];

	test("without custom instructions there is no custom block", () => {
		const prompt = rewritePrompt(draft, answers);
		expect(prompt).not.toContain("custom_instructions");
		expect(prompt.startsWith(defaultRules)).toBe(true);
	});

	test("append keeps the default rules and adds the labelled instructions before the data", () => {
		const prompt = rewritePrompt(draft, answers, { global: "GLOBAL TEXT", project: "PROJECT TEXT", mode: "append" });
		expect(prompt.startsWith(defaultRules)).toBe(true);
		expect(prompt).toContain("<global>\nGLOBAL TEXT\n</global>");
		expect(prompt).toContain("<project>\nPROJECT TEXT\n</project>");
		const at = (text: string) => prompt.indexOf(text);
		expect(at(defaultRules)).toBeLessThan(at("<custom_instructions>"));
		expect(at("GLOBAL TEXT")).toBeLessThan(at("PROJECT TEXT"));
		expect(at("</custom_instructions>")).toBeLessThan(at("<draft>"));
	});

	test("replace drops the default rules but keeps the draft and the decisions", () => {
		const prompt = rewritePrompt(draft, answers, { project: "ONLY PROJECT", mode: "replace" });
		expect(prompt).not.toContain(defaultRules);
		expect(prompt).toContain("<project>\nONLY PROJECT\n</project>");
		expect(prompt).not.toContain("<global>");
		expect(prompt).toContain(`<draft>\n${draft}\n</draft>`);
		expect(prompt).toContain("- Q: Scope?\n  A: Only auth");
	});

	test("the draft and the decisions come after the instructions in every mode", () => {
		for (const mode of ["append", "replace"] as const) {
			const prompt = rewritePrompt(draft, answers, { global: "G", mode });
			// L'introduzione può citare i tag per nome: si cercano i blocchi dati veri.
			const draftBlock = prompt.indexOf(`<draft>\n${draft}\n</draft>`);
			expect(prompt.indexOf("</custom_instructions>")).toBeLessThan(draftBlock);
			expect(draftBlock).toBeLessThan(prompt.indexOf("<decisions>\n- Q:"));
		}
	});

	test("only says which side wins when both scopes are present", () => {
		const both = rewritePrompt(draft, [], { global: "G", project: "P", mode: "append" });
		const one = rewritePrompt(draft, [], { global: "G", mode: "append" });
		expect(both).toContain("project instructions win");
		expect(one).not.toContain("project instructions win");
	});
});

describe("withTranscript", () => {
	const prompt = questionsPrompt("fix the login bug");

	test("puts the conversation before the unchanged side-turn prompt", () => {
		const request = withTranscript("[User]: the login fails\n\n[Assistant]: see auth.ts", prompt);
		const block = "<conversation>\n[User]: the login fails\n\n[Assistant]: see auth.ts\n</conversation>";
		expect(request).toContain(block);
		expect(request.endsWith(`\n\n${prompt}`)).toBe(true);
		expect(request.indexOf(block)).toBeLessThan(request.indexOf(prompt));
	});

	test("an empty session sends no conversation block", () => {
		const request = withTranscript("  \n", prompt);
		expect(request).not.toContain("<conversation>");
		expect(request.endsWith(`\n\n${prompt}`)).toBe(true);
	});
});

describe("parseQuestions", () => {
	test("a malformed question is dropped without losing the valid ones", () => {
		const reply = JSON.stringify({
			questions: [
				{ question: "Scope?", options: [option("Module"), option("Repo")] },
				{ question: "No options" },
				{ question: "Output?", options: ["stdout", "stderr"] },
			],
		});
		expect(parseQuestions(reply)?.map(q => [q.question, q.options.map(o => o.label)])).toEqual([
			["Scope?", ["Module", "Repo"]],
			["Output?", ["stdout", "stderr"]],
		]);
	});

	test("invalid accessory fields are ignored instead of rejecting the question", () => {
		const reply = JSON.stringify({
			questions: [
				{ question: "A?", options: [option("x"), option("y")], recommended: "0", multi: "yes", header: 42 },
				{ question: "B?", options: [option("x"), option("y")], recommended: 2 },
				{ question: "C?", options: [option("x"), option("y")], recommended: 1, header: "A very long header" },
			],
		});
		expect(parseQuestions(reply)?.map(({ question, header, multi, recommended }) => ({ question, header, multi, recommended }))).toEqual([
			{ question: "A?", header: undefined, multi: false, recommended: undefined },
			{ question: "B?", header: undefined, multi: false, recommended: undefined },
			{ question: "C?", header: "A very long", multi: false, recommended: 1 },
		]);
	});

	test("reads JSON wrapped in prose or code fences", () => {
		const reply = 'Here you go:\n```json\n{"questions":[{"question":"Q?","options":["a","b"]}]}\n```';
		expect(parseQuestions(reply)?.length).toBe(1);
	});

	test(`keeps at most ${MAX_QUESTIONS} questions, with unique ids`, () => {
		const questions = Array.from({ length: MAX_QUESTIONS + 2 }, (_, i) => ({ question: `Q${i}?`, options: ["a", "b"] }));
		const parsed = parseQuestions(JSON.stringify({ questions })) ?? [];
		expect(parsed.map(q => q.question)).toEqual(["Q0?", "Q1?", "Q2?", "Q3?"]);
		expect(new Set(parsed.map(q => q.id)).size).toBe(MAX_QUESTIONS);
	});

	test("distinguishes 'no questions needed' from an unreadable reply", () => {
		expect(parseQuestions('{"questions":[]}')).toEqual([]);
		expect(parseQuestions("The draft is clear.")).toBeUndefined();
		expect(parseQuestions('{"questions": "none"}')).toBeUndefined();
	});
});

describe("previewRows", () => {
	test("follows the tail of a line longer than the width", () => {
		const rows = previewRows(`${"word ".repeat(40)}LATEST`, 20, 3);
		expect(rows.at(-1)).toEndWith("LATEST");
		expect(rows).toHaveLength(3);
		for (const row of rows) expect(row.length).toBeLessThanOrEqual(20);
	});

	test("hard-wraps a long token with no spaces", () => {
		expect(previewRows("x".repeat(45), 20, 8)).toEqual(["x".repeat(20), "x".repeat(20), "x".repeat(5)]);
	});

	test("keeps only the last rows across lines", () => {
		expect(previewRows("1\n2\n3\n4\n", 20, 2)).toEqual(["3", "4"]);
	});
});
