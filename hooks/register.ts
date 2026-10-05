import type { EngineInterface, ModelEffort, ModelForkResult, PluginOptions, Register } from "claude-code";
import {
	applyEdit,
	DEFAULT_MODE,
	describeLayer,
	INSTRUCTIONS_KEY,
	type InstructionsEdit,
	isRecord,
	type LayerValues,
	MODE_KEY,
	type ModeChoice,
	modeChoices,
	NAMESPACE,
	readLayer,
	resolveInstructions,
	type Scope,
} from "../instructions";
import {
	type Answer,
	type AskUserQuestion,
	parseQuestions,
	type Question,
	questionsPrompt,
	readAskAnswers,
	rewritePrompt,
	serializeTranscript,
	toAskUserQuestions,
	withTranscript,
} from "../rewrite";

/**
 * prompt-rewrite come mod di Claude Code: /rewrite e /rewrite-settings con la logica
 * condivisa con l'estensione omp (`rewrite.ts`, `instructions.ts`).
 *
 * /rewrite <bozza>: domande di direzione (0–4) → riscrittura → prompt. Le richieste sono
 * fork della sessione (`$.model.fork`: stesso modello, system prompt e cache, niente tool)
 * o, con il campo `model` impostato, `$.model.complete` con la conversazione come
 * trascrizione. Un comando che risponde `{}` non lascia nulla nella conversazione.
 *
 * /rewrite-settings [global|project] [istruzioni]: istruzioni personalizzate, globali nei
 * campi `userConfig` (righe di /config), di progetto in `.claude/rewrite.json`.
 */

// Prima versione di Claude Code con l'API usata qui: `$.model.*` che risolve `isAnswered`/`reason`, `effort`.
const MIN_VERSION = "2.1.289";
// Relativo alla directory di lavoro della sessione.
const PROJECT_FILE = ".claude/rewrite.json";
// Tetto della risposta di `$.model.complete` (default 1024): un prompt riscritto, con margine per il ragionamento.
const MAX_TOKENS = 16_000;
const EFFORTS: readonly ModelEffort[] = ["low", "medium", "high", "xhigh", "max"];
const CANCELLED = "/rewrite: cancelled; draft restored to the prompt";
const SETTINGS_USAGE = "/rewrite-settings: usage: /rewrite-settings [global|project] [instructions]";

/** Dove vanno le richieste: il fork della sessione, o un modello che riceve la conversazione come trascrizione. */
type Target = { kind: "session" } | { kind: "model"; model: string; effort: ModelEffort | undefined; system: string; transcript: string };

let busy = false;
/** Riga sopra il prompt mentre /rewrite aspetta il modello; `undefined` altrimenti. */
let progress: { label: string; since: number } | undefined;
/**
 * Le domande di un /rewrite: `$.ui.ask` ne apre una sola, senza descrizioni, e il hook
 * `tool.call` mette tutte queste nel dialogo; `answers` sono le risposte a tutte.
 */
let pending: { questions: AskUserQuestion[]; answers?: Readonly<Record<string, unknown>> } | undefined;

/** Un'informazione è un toast; un avviso o un errore resta come riga della trascrizione, che il modello non legge. */
function notify($: EngineInterface, text: string, level: "info" | "warning" | "error"): void {
	if (level === "info") $.ui.toast(text);
	else $.ui.log(text);
}

/** `version` (`2.1.289`, `2.1.290-dev…`) è almeno `minimum`? Contano le parti numeriche di `minimum`. */
function isAtLeast(version: string, minimum: string): boolean {
	const own = version.split(/[.-]/).map(Number);
	for (const [index, part] of minimum.split(".").map(Number).entries()) {
		const have = own[index] ?? 0;
		if (have !== part) return have > part;
	}
	return true;
}

/** Perché un comando non può partire in questa sessione; `undefined` se può. */
async function blocker($: EngineInterface, command: string): Promise<{ text: string; headless: boolean } | undefined> {
	if ((await $.session.surfaces()).length === 0) {
		return { text: `${command}: needs an interactive session (terminal or desktop app); the result goes to the prompt box`, headless: true };
	}
	const { version } = await $.session.version();
	if (!isAtLeast(version, MIN_VERSION)) return { text: `${command}: requires Claude Code ${MIN_VERSION} or newer (this is ${version})`, headless: false };
	return undefined;
}

/** Il livello globale come lo legge `readLayer`: i campi `userConfig` della mod. */
function globalLayer(options: PluginOptions): Record<string, unknown> {
	return { [NAMESPACE]: { [INSTRUCTIONS_KEY]: options.instructions, [MODE_KEY]: options.instructions_mode } };
}

/** `.claude/rewrite.json`; `undefined` se manca. Un file che non è un oggetto JSON è un errore e non viene mai sovrascritto. */
async function readProjectFile($: EngineInterface): Promise<Record<string, unknown> | undefined> {
	if (!(await $.fs.exists(PROJECT_FILE))) return undefined;
	const text = await $.fs.read(PROJECT_FILE);
	let parsed: unknown;
	try {
		parsed = text.trim() ? JSON.parse(text) : {};
	} catch (err) {
		throw new Error(`can't read ${PROJECT_FILE}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!isRecord(parsed)) throw new Error(`${PROJECT_FILE} is not a JSON object; fix it by hand first`);
	return parsed;
}

/** Mette il testo nel prompt senza cancellare quello che l'utente ha scritto nel frattempo. */
async function putInPrompt($: EngineInterface, text: string): Promise<void> {
	const { text: current } = await $.prompt.read();
	const { isFilled } = await $.prompt.fill({ text: current.trim() ? `${current.trimEnd()}\n\n${text}` : text });
	// Il prompt è occupato da un dialogo o non c'è: il testo resta almeno nella trascrizione.
	if (!isFilled) $.ui.log(`/rewrite: the prompt box didn't take the text; here it is:\n${text}`);
}

/** Domande nel dialogo di Claude Code, tutte insieme; `undefined` = l'utente ha annullato. */
async function askQuestions($: EngineInterface, questions: readonly Question[]): Promise<Answer[] | undefined> {
	const asked = toAskUserQuestions(questions);
	const [first] = asked;
	if (!first) return [];
	pending = { questions: asked };
	try {
		const answer = await $.ui.ask(first.question, {
			options: first.options.map(o => o.label),
			header: first.header,
			multiSelect: first.multiSelect ? true : undefined,
		});
		// Se un'altra mod ha risposto al dialogo prima del nostro hook, c'è solo la prima risposta.
		return readAskAnswers(asked, pending.answers ?? { [first.question]: answer });
	} catch {
		// Dialogo chiuso con Esc o con "Chat about this".
		return undefined;
	} finally {
		pending = undefined;
	}
}

/** Il modello scelto riceve la conversazione come trascrizione e il system prompt della sessione. */
async function modelTarget($: EngineInterface, model: string, effort: ModelEffort | undefined): Promise<Target> {
	const [messages, { sections }] = await Promise.all([$.session.messages({ as: "api" }), $.prompt.compose()]);
	return { kind: "model", model, effort, system: sections.map(s => s.text).join("\n\n"), transcript: serializeTranscript(messages) };
}

/** Il campo `model` vuoto, o uguale al modello della sessione senza `effort`, vale il fork della sessione. */
async function pickTarget($: EngineInterface, options: PluginOptions): Promise<Target> {
	const model = typeof options.model === "string" ? options.model.trim() : "";
	const effort = EFFORTS.find(level => level === options.effort);
	if (!model || (model === (await $.session.model()) && !effort)) return { kind: "session" };
	return modelTarget($, model, effort);
}

/** Una richiesta, con l'avanzamento sopra il prompt (la risposta non arriva in streaming). */
async function request($: EngineInterface, target: Target, label: string, promptText: string): Promise<ModelForkResult> {
	progress = { label: target.kind === "model" ? `${label} · ${target.model}` : label, since: await $.clock.now() };
	$.ui.invalidate("ui.render");
	const timer = $.clock.every(1000, () => $.ui.invalidate("ui.render"));
	try {
		if (target.kind === "session") return await $.model.fork({ prompt: promptText });
		return await $.model.complete({
			model: target.model,
			system: target.system,
			prompt: withTranscript(target.transcript, promptText),
			maxTokens: MAX_TOKENS,
			effort: target.effort,
		});
	} finally {
		timer.cancel();
		progress = undefined;
		$.ui.invalidate("ui.render");
	}
}

/** Testo della risposta; `undefined` = annullata (Esc). Un errore dell'API diventa un'eccezione. */
function replyText(result: ModelForkResult): string | undefined {
	if (result.isAnswered) return result.text;
	switch (result.reason) {
		case "aborted":
			return undefined;
		case "empty-reply":
			return "";
		case "api-error":
			throw new Error(`the model request failed: ${result.error}${result.status === null ? "" : ` (HTTP ${result.status})`}`);
		case "nothing-to-fork":
			throw new Error("the session has nothing to fork yet");
	}
}

/** Bozza → domande → riscrittura → prompt. Su annullamento o errore la bozza torna nel prompt. */
async function rewrite($: EngineInterface, options: PluginOptions, draft: string): Promise<void> {
	const cancel = async () => {
		await putInPrompt($, draft);
		notify($, CANCELLED, "info");
	};
	try {
		let target = await pickTarget($, options);
		const analyze = async () => {
			const prompt = questionsPrompt(draft);
			try {
				const result = await request($, target, "analyzing the draft", prompt);
				// Un id che il provider non conosce: come per un ruolo omp senza modello, si usa la sessione.
				if (target.kind === "model" && !result.isAnswered && result.reason === "api-error" && result.status === 404) {
					throw new Error(result.error);
				}
				return result;
			} catch (err) {
				// Rifiutata prima di partire (modello bloccato, tetto troppo alto) o modello sconosciuto.
				if (target.kind !== "model") throw err;
				const reason = err instanceof Error ? err.message : String(err);
				notify($, `/rewrite: the model "${target.model}" can't be used (${reason}); using the session's model`, "warning");
				target = { kind: "session" };
				return request($, target, "analyzing the draft", prompt);
			}
		};
		let analysis = await analyze();
		if (!analysis.isAnswered && analysis.reason === "nothing-to-fork") {
			// Sessione appena iniziata: non c'è un turno da biforcare, la richiesta va al modello della sessione.
			target = await modelTarget($, await $.session.model(), undefined);
			analysis = await request($, target, "analyzing the draft", questionsPrompt(draft));
		}
		const analysisText = replyText(analysis);
		if (analysisText === undefined) return await cancel();

		const questions = parseQuestions(analysisText);
		if (!questions) notify($, "/rewrite: couldn't read the model's questions; rewriting without them", "warning");
		let answers: Answer[] = [];
		if (questions?.length) {
			const answered = await askQuestions($, questions);
			if (!answered) return await cancel();
			answers = answered;
		}

		// Un file di progetto illeggibile non ferma la riscrittura: vale come assente.
		let project: Record<string, unknown> | undefined;
		try {
			project = await readProjectFile($);
		} catch (err) {
			notify($, `/rewrite: ignoring the project instructions (${err instanceof Error ? err.message : String(err)})`, "warning");
		}
		const { custom, warnings } = resolveInstructions(globalLayer(options), { [NAMESPACE]: project });
		for (const warning of warnings) notify($, warning, "warning");

		const rewritten = replyText(await request($, target, "rewriting the prompt", rewritePrompt(draft, answers, custom)));
		if (rewritten === undefined) return await cancel();
		if (!rewritten.trim()) throw new Error("the model returned an empty rewrite");

		await putInPrompt($, rewritten.trim());
		notify($, "/rewrite: prompt rewritten into the prompt box; review it and press Enter", "info");
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		await putInPrompt($, draft);
		notify($, `/rewrite: failed (${reason}); draft restored to the prompt`, "error");
	}
}

/** Una scelta nel dialogo; `undefined` = annullato. Il testo libero torna così com'è. */
async function choose($: EngineInterface, question: Question): Promise<string | undefined> {
	const answers = await askQuestions($, [question]);
	return answers === undefined ? undefined : (answers[0]?.answer ?? "");
}

/** Scrive `rewrite.*` globale nei campi `userConfig`: come cambiarli in /config, e la mod si ricarica. */
async function saveGlobal($: EngineInterface, edit: InstructionsEdit): Promise<void> {
	const values: [string, string][] = [
		["instructions", edit.instructions ?? ""],
		["instructions_mode", edit.mode ?? DEFAULT_MODE],
	];
	for (const [field, value] of values) {
		const result = await $.config.set({ key: `${$.plugin.name}.${field}`, value });
		if (result.deny !== undefined) throw new Error(`/config refused ${field}: ${result.deny}`);
	}
}

/** Scrive `.claude/rewrite.json`, tenendo le altre chiavi; svuotare un file che non c'è non lo crea. */
async function saveProject($: EngineInterface, edit: InstructionsEdit): Promise<string> {
	const current = await readProjectFile($);
	const next = applyEdit({ [NAMESPACE]: current ?? {} }, edit)[NAMESPACE];
	const block = isRecord(next) ? next : {};
	if (current !== undefined || Object.keys(block).length > 0) await $.fs.write(PROJECT_FILE, `${JSON.stringify(block, null, 2)}\n`);
	return `${await $.session.cwd()}/${PROJECT_FILE}`;
}

/**
 * /rewrite-settings: senza argomenti chiede l'ambito e mette nel prompt il comando con il
 * testo attuale, da modificare su più righe; con ambito e testo chiede la modalità e salva.
 * Un ambito senza testo lo svuota. Esc in un dialogo annulla senza modificare nulla.
 */
async function editInstructions($: EngineInterface, options: PluginOptions, args: string): Promise<void> {
	const project = await readProjectFile($);
	const layers: Record<Scope, LayerValues> = {
		global: readLayer(globalLayer(options), "global"),
		project: readLayer({ [NAMESPACE]: project }, "project"),
	};
	const [, word = "", rest = ""] = /^(\S*)\s*([\s\S]*)$/.exec(args.trim()) ?? [];
	let scope: Scope | undefined = word.toLowerCase() === "global" ? "global" : word.toLowerCase() === "project" ? "project" : undefined;
	if (word && !scope) return notify($, SETTINGS_USAGE, "warning");

	if (!scope) {
		const choice = await choose($, {
			id: "scope",
			header: "Scope",
			question: "Which custom /rewrite instructions do you want to edit?",
			options: [
				{ label: "Global", description: `${describeLayer(layers.global)}; applies to every project` },
				{ label: "Project", description: `${describeLayer(layers.project)}; ${PROJECT_FILE}` },
			],
			multi: false,
		});
		if (choice === undefined) return;
		scope = choice.toLowerCase() === "global" ? "global" : choice.toLowerCase() === "project" ? "project" : undefined;
		if (!scope) return notify($, SETTINGS_USAGE, "warning");
		const { isFilled } = await $.prompt.fill({ text: `/rewrite-settings ${scope} ${layers[scope].instructions ?? ""}` });
		if (!isFilled) return notify($, "/rewrite-settings: the prompt box didn't take the text; type /rewrite-settings <scope> <instructions>", "warning");
		return notify($, `/rewrite-settings: edit the ${scope} instructions in the prompt and press Enter; leave them empty to clear`, "info");
	}

	const instructions = rest.trim();
	let edit: InstructionsEdit = { instructions: undefined, mode: undefined };
	if (instructions) {
		const { options: modes, current } = modeChoices(scope, layers[scope].mode);
		const choice = await choose($, {
			id: "mode",
			header: "Mode",
			question: `How should the ${scope} instructions combine with the default rewrite rules?`,
			options: modes,
			multi: false,
			recommended: current,
		});
		if (choice === undefined) return;
		const mode = modes.find(m => m.label === choice.trim().toLowerCase())?.label;
		if (!mode) return notify($, `/rewrite-settings: unknown mode "${choice}"; nothing changed`, "warning");
		edit = { instructions, mode: mode === "inherit" ? undefined : mode };
	}

	let where: string;
	if (scope === "global") {
		await saveGlobal($, edit);
		where = "the global settings (/config)";
	} else {
		where = await saveProject($, edit);
	}
	const mode: ModeChoice | "inherited" = edit.mode ?? (scope === "global" ? DEFAULT_MODE : "inherited");
	notify($, `/rewrite-settings: ${scope} instructions ${instructions ? `saved (mode ${mode})` : "cleared"} in ${where}`, "info");
}

export const register: Register = (on, options) => {
	on("session.start", async ($, e, next) => {
		const commands = [
			{ name: "rewrite", description: "Rewrite a draft into a thorough prompt, asking about its direction first", argumentHint: "<draft>" },
			{
				name: "rewrite-settings",
				description: "Edit the custom instructions added to the /rewrite prompt (global or project)",
				argumentHint: "[global|project] [instructions]",
			},
		];
		for (const command of commands) {
			// Un nome rifiutato (preso da un comando incorporato) non deve impedire l'altro.
			try {
				await $.command.register(command);
			} catch (err) {
				$.ui.log(`prompt-rewrite: /${command.name} not registered (${err instanceof Error ? err.message : String(err)})`);
			}
		}
		return next(e);
	});

	on("command.run", { command: "rewrite" }, async ($, e) => {
		const problem = await blocker($, "/rewrite");
		if (problem?.headless) return { text: problem.text };
		if (problem) notify($, problem.text, "error");
		else if (busy) notify($, "/rewrite: already running", "warning");
		else if (!e.args.trim()) notify($, "/rewrite: empty draft; usage: /rewrite <draft>", "warning");
		else {
			busy = true;
			try {
				await rewrite($, options, e.args.trim());
			} finally {
				busy = false;
			}
		}
		return {};
	});

	on("command.run", { command: "rewrite-settings" }, async ($, e) => {
		const problem = await blocker($, "/rewrite-settings");
		if (problem?.headless) return { text: problem.text };
		if (problem) notify($, problem.text, "error");
		else {
			try {
				await editInstructions($, options, e.args);
			} catch (err) {
				notify($, `/rewrite-settings: failed (${err instanceof Error ? err.message : String(err)})`, "error");
			}
		}
		return {};
	});

	// Il dialogo aperto da `askQuestions` mostra tutte le domande, con le descrizioni delle opzioni.
	on("tool.call", { tool: "AskUserQuestion" }, async ($, e, next) => {
		const batch = pending;
		if (!batch || e.questions[0]?.question !== batch.questions[0]?.question) return next(e);
		const result = await next({ ...e, questions: batch.questions });
		if ("result" in result && isRecord(result.result) && isRecord(result.result.answers)) batch.answers = result.result.answers;
		return result;
	});

	on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
		const shown = progress;
		if (!shown) return next(e);
		const { Box, Text } = $.ui.resolve(e);
		const seconds = Math.floor(((await $.clock.now()) - shown.since) / 1000);
		return Box({
			flexDirection: "column",
			children: [
				Text({ bold: true, wrap: "truncate", children: `✎ /rewrite · ${shown.label}` }),
				Text({ dimColor: true, children: `${seconds}s · Esc to cancel` }),
				await next(e),
			],
		});
	});
};
