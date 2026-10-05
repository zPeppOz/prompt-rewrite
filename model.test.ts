import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { reasoningOptions, roleThinking, withoutThinking } from "./model";

describe("roleThinking", () => {
	test("an explicit role level wins over the session level", () => {
		expect(roleThinking("low", "max")).toBe("low");
		expect(roleThinking("off", "high")).toBe("off");
	});

	test("no level, auto or inherit on the role fall back to the session level", () => {
		for (const explicit of [undefined, "", "auto", "inherit"]) expect(roleThinking(explicit, "high")).toBe("high");
		expect(roleThinking(undefined, undefined)).toBeUndefined();
	});
});

describe("reasoningOptions", () => {
	test("off disables reasoning instead of leaving the provider default", () => {
		expect(reasoningOptions("off")).toEqual({ disableReasoning: true });
	});

	test("a level becomes the reasoning effort", () => {
		expect(reasoningOptions("xhigh")).toEqual({ reasoning: "xhigh" });
	});

	test("no level leaves the provider default", () => {
		for (const level of [undefined, "", "auto", "inherit"]) expect(reasoningOptions(level)).toEqual({});
	});
});

describe("withoutThinking", () => {
	test("drops thinking blocks and keeps text and tool calls in order", () => {
		const call = { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } } as const;
		const content: AssistantMessage["content"] = [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "visible" }, call];
		const [out] = withoutThinking([{ role: "assistant", content } as AssistantMessage]);
		expect(out).toMatchObject({ role: "assistant", content: [{ type: "text", text: "visible" }, call] });
	});
});
