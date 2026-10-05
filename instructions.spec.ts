import { describe, expect, test } from "bun:test";
import { applyEdit, resolveInstructions } from "./instructions";

const layer = (instructions?: unknown, instructionsMode?: unknown) => ({ rewrite: { instructions, instructionsMode } });

describe("resolveInstructions", () => {
	test("nothing configured means no custom instructions", () => {
		expect(resolveInstructions({}, {})).toEqual({ custom: undefined, warnings: [] });
		expect(resolveInstructions(undefined, null)).toEqual({ custom: undefined, warnings: [] });
	});

	test("global and project texts are both kept, each in its own slot", () => {
		const { custom } = resolveInstructions(layer("G"), layer("P"));
		expect(custom).toEqual({ global: "G", project: "P", mode: "append" });
	});

	test("a blank or missing side is dropped and the other one applies", () => {
		expect(resolveInstructions(layer("G"), layer("  \n ")).custom).toEqual({ global: "G", project: undefined, mode: "append" });
		expect(resolveInstructions({}, layer("P")).custom).toEqual({ global: undefined, project: "P", mode: "append" });
		expect(resolveInstructions(layer("   "), layer("")).custom).toBeUndefined();
	});

	test("texts are trimmed at the edges but keep inner formatting", () => {
		expect(resolveInstructions(layer("\n  a\n\n  - b  \n"), {}).custom?.global).toBe("a\n\n  - b");
	});

	test("mode resolves project, then global, then append", () => {
		expect(resolveInstructions(layer("G", "replace"), layer("P", "append")).custom?.mode).toBe("append");
		expect(resolveInstructions(layer("G", "replace"), layer("P")).custom?.mode).toBe("replace");
		expect(resolveInstructions(layer("G"), layer("P", "replace")).custom?.mode).toBe("replace");
		expect(resolveInstructions(layer("G"), layer("P")).custom?.mode).toBe("append");
	});

	test("invalid values are ignored with a warning naming the layer and the key", () => {
		const { custom, warnings } = resolveInstructions(layer("G", "replaced"), layer(42, "append"));
		expect(custom).toEqual({ global: "G", project: undefined, mode: "append" });
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("global");
		expect(warnings[0]).toContain("rewrite.instructionsMode");
		expect(warnings[1]).toContain("project");
		expect(warnings[1]).toContain("rewrite.instructions");
	});

	test("an invalid global mode does not hide a valid project mode, and vice versa", () => {
		expect(resolveInstructions(layer("G", "nope"), layer("P", "replace")).custom?.mode).toBe("replace");
		expect(resolveInstructions(layer("G", "replace"), layer("P", "nope")).custom?.mode).toBe("replace");
	});

	test("a non-mapping rewrite block is ignored", () => {
		expect(resolveInstructions({ rewrite: "text" }, { rewrite: ["x"] }).custom).toBeUndefined();
	});
});

describe("applyEdit", () => {
	test("sets both keys and keeps every unrelated key", () => {
		const before = { theme: { dark: "titanium" }, rewrite: { other: 1 } };
		expect(applyEdit(before, { instructions: "  text \n", mode: "replace" })).toEqual({
			theme: { dark: "titanium" },
			rewrite: { other: 1, instructions: "text", instructionsMode: "replace" },
		});
	});

	test("undefined removes a key, and an emptied rewrite block disappears", () => {
		const before = { a: 1, rewrite: { instructions: "x", instructionsMode: "replace" } };
		expect(applyEdit(before, { instructions: undefined, mode: undefined })).toEqual({ a: 1 });
		expect(applyEdit(before, { instructions: "x", mode: undefined })).toEqual({ a: 1, rewrite: { instructions: "x" } });
	});

	test("blank text counts as removal", () => {
		expect(applyEdit({ rewrite: { instructions: "x" } }, { instructions: " \n", mode: undefined })).toEqual({});
	});

	test("does not mutate its input", () => {
		const before = { rewrite: { instructions: "x" } };
		applyEdit(before, { instructions: "y", mode: "replace" });
		expect(before).toEqual({ rewrite: { instructions: "x" } });
	});
});
