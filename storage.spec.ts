import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveInstructions } from "./instructions";
import { projectConfigPath, saveProject } from "./storage";

let cwd: string;
let reloads: number;
const settings = () => ({
	getCwd: () => cwd,
	reloadFromDisk: async () => void reloads++,
});
const readProject = async () => Bun.YAML.parse(await readFile(projectConfigPath(cwd), "utf8"));

beforeEach(async () => {
	cwd = await mkdtemp(path.join(tmpdir(), "omp-rewrite-"));
	reloads = 0;
});
afterEach(() => rm(cwd, { recursive: true, force: true }));

describe("saveProject", () => {
	test("creates .omp/config.yml when missing and asks the host to reload", async () => {
		const file = await saveProject(settings(), { instructions: "Reply in English.", mode: "replace" });
		expect(file).toBe(path.join(cwd, ".omp", "config.yml"));
		expect(resolveInstructions(undefined, await readProject()).custom).toEqual({
			global: undefined,
			project: "Reply in English.",
			mode: "replace",
		});
		expect(reloads).toBe(1);
	});

	test("keeps every other key, including nested ones, and round-trips tricky text", async () => {
		const tricky = "- bullet: with colon\n# not a comment\n\n  indented \"quoted\" line";
		await mkdir(path.join(cwd, ".omp"));
		await writeFile(projectConfigPath(cwd), "theme:\n  dark: titanium\ndisabledProviders:\n  - groq\n");
		await saveProject(settings(), { instructions: tricky, mode: undefined });
		const saved = await readProject();
		expect(saved.theme).toEqual({ dark: "titanium" });
		expect(saved.disabledProviders).toEqual(["groq"]);
		expect(resolveInstructions(undefined, saved).custom?.project).toBe(tricky);
	});

	test("clearing removes the rewrite keys and leaves the rest of the file", async () => {
		await mkdir(path.join(cwd, ".omp"));
		await writeFile(projectConfigPath(cwd), "theme:\n  dark: titanium\nrewrite:\n  instructions: old\n  instructionsMode: replace\n");
		await saveProject(settings(), { instructions: "", mode: undefined });
		expect(await readProject()).toEqual({ theme: { dark: "titanium" } });
		expect(reloads).toBe(1);
	});

	test("clearing when there is no project file creates nothing", async () => {
		await saveProject(settings(), { instructions: undefined, mode: undefined });
		expect(await Bun.file(projectConfigPath(cwd)).exists()).toBe(false);
		expect(await Bun.file(path.join(cwd, ".omp")).exists()).toBe(false);
	});

	test("refuses a file that is not a YAML mapping and leaves it untouched", async () => {
		await mkdir(path.join(cwd, ".omp"));
		await writeFile(projectConfigPath(cwd), "- a\n- b\n");
		await expect(saveProject(settings(), { instructions: "x", mode: undefined })).rejects.toThrow("not a YAML mapping");
		expect(await readFile(projectConfigPath(cwd), "utf8")).toBe("- a\n- b\n");
		expect(reloads).toBe(0);
	});

	test("refuses unparseable YAML and leaves it untouched", async () => {
		await mkdir(path.join(cwd, ".omp"));
		await writeFile(projectConfigPath(cwd), "a: [unclosed\n");
		await expect(saveProject(settings(), { instructions: "x", mode: undefined })).rejects.toThrow(projectConfigPath(cwd));
		expect(await readFile(projectConfigPath(cwd), "utf8")).toBe("a: [unclosed\n");
	});

	test("an empty existing file is treated as an empty mapping", async () => {
		await mkdir(path.join(cwd, ".omp"));
		await writeFile(projectConfigPath(cwd), "");
		await saveProject(settings(), { instructions: "x", mode: undefined });
		expect(resolveInstructions(undefined, await readProject()).custom?.project).toBe("x");
	});
});
