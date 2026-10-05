import type {
	ExtensionAPI,
	ExtensionAskDialogQuestion,
	ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import {
	DEFAULT_MODE,
	describeLayer,
	type InstructionsEdit,
	type InstructionsMode,
	type LayerValues,
	type ModeChoice,
	modeChoices,
	readLayer,
	resolveInstructions,
	type Scope,
} from "./instructions";
import { pickTarget, roleTurn, sessionTurn, showRoleInSelector, type Turn } from "./model";
import { type Answer, parseQuestions, previewRows, questionsPrompt, rewritePrompt } from "./rewrite";
import { type HostSettings, projectConfigPath, saveGlobal, saveProject } from "./storage";

/**
 * /rewrite <bozza>
 *
 * Side turn stile /btw: usa il contesto della sessione corrente e non scrive nulla
 * nella history. Flusso: domande di direzione (0–4) → riscrittura → composer.
 * Le istruzioni personalizzate (globali e di progetto) si aggiungono al prompt di
 * riscrittura, o lo sostituiscono. Il ruolo `rewrite` del selettore dei modelli
 * (/model) sceglie un modello diverso da quello della sessione.
 *
 * /rewrite-settings
 *
 * Modifica quelle istruzioni: il pannello /settings di omp non ospita campi di estensioni.
 */

const WIDGET_KEY = "rewrite";
const PREVIEW_ROWS = 8;
// Al più un aggiornamento del widget ogni 100 ms: in RPC ogni aggiornamento è un frame sul canale.
const PREVIEW_INTERVAL_MS = 100;
// Esc legacy e con kitty keyboard protocol.
const ESCAPE = /^\x1b(\[27(;1)?u)?$/;
// Prima versione di omp con ctx.runEphemeralTurn per le estensioni.
const MIN_OMP_VERSION = "18.3.0";
// Prima versione di omp con il registry delle impostazioni (tag del ruolo, /rewrite-settings).
const REGISTRY_OMP_VERSION = "18.3.1";
const CANCELLED = "/rewrite: cancelled; draft restored to the composer";

/** Mostra le domande; `undefined` = l'utente ha annullato. */
async function askQuestions(
	ctx: ExtensionCommandContext,
	questions: ExtensionAskDialogQuestion[],
): Promise<Answer[] | undefined> {
	if (ctx.ui.askDialog) {
		const result = await ctx.ui.askDialog(questions);
		if (result?.kind !== "submit") return undefined;
		return result.results.flatMap(r => {
			const parts = [...r.selectedOptions, r.customInput?.trim()].filter(Boolean);
			if (r.note?.trim()) parts.push(`(note: ${r.note.trim()})`);
			return parts.length ? [{ question: r.question, answer: parts.join("; ") }] : [];
		});
	}

	// Host senza ask dialog (es. RPC): una select per domanda + risposta libera.
	// Le domande multi accettano una sola scelta; l'opzione consigliata è indicata nella descrizione.
	const OTHER = "Other…";
	const answers: Answer[] = [];
	for (const q of questions) {
		const options = q.options.map((o, i) =>
			i === q.recommended ? { label: o.label, description: o.description ? `Recommended. ${o.description}` : "Recommended" } : o,
		);
		const choice = await ctx.ui.select(q.question, [...options, { label: OTHER, description: "Free-form answer" }]);
		if (choice === undefined) return undefined;
		const answer = choice === OTHER ? await ctx.ui.input(q.question, "Free-form answer") : choice;
		if (answer === undefined) return undefined;
		if (answer.trim()) answers.push({ question: q.question, answer: answer.trim() });
	}
	return answers;
}

/**
 * Richiesta con widget di avanzamento sopra il composer; Esc annulla (solo TUI).
 * `undefined` = annullato dall'utente.
 */
async function sideTurn(
	ctx: ExtensionCommandContext,
	turn: Turn,
	label: string,
	promptText: string,
	{ preview }: { preview: boolean },
): Promise<string | undefined> {
	const { theme } = ctx.ui;
	// Esc arriva all'estensione solo nella TUI: altrove il suggerimento sarebbe falso.
	const header = theme.fg("accent", `✎ /rewrite · ${label}`) + (ctx.mode === "tui" ? theme.fg("muted", "  (Esc to cancel)") : "");
	let streamed = "";
	let lastRender = 0;
	const render = () => {
		const lines = [header];
		if (streamed.trim()) {
			const width = Math.max(20, (process.stdout.columns ?? 100) - 4);
			for (const row of previewRows(streamed, width, PREVIEW_ROWS)) lines.push(theme.fg("muted", row));
		}
		ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
	};

	const controller = new AbortController();
	const unsubscribe = ctx.ui.onTerminalInput(data => {
		if (!ESCAPE.test(data)) return undefined;
		controller.abort();
		return { consume: true };
	});
	render();
	try {
		const replyText = await turn(promptText, {
			signal: controller.signal,
			onText: preview
				? text => {
						streamed = text;
						const now = Date.now();
						if (now - lastRender < PREVIEW_INTERVAL_MS) return;
						lastRender = now;
						render();
					}
				: undefined,
		});
		// Esc premuto mentre il turno si chiudeva: vale comunque come annullamento.
		return controller.signal.aborted ? undefined : replyText;
	} catch (err) {
		if (controller.signal.aborted) return undefined;
		throw err;
	} finally {
		unsubscribe();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}
}

/** Mette il testo nel composer senza cancellare quello che l'utente ha scritto nel frattempo. */
function putInComposer(ctx: ExtensionCommandContext, text: string): void {
	const current = ctx.ui.getEditorText();
	ctx.ui.setEditorText(current.trim() ? `${current.trimEnd()}\n\n${text}` : text);
}

/** Modello → domande → riscrittura → composer. Su annullamento o errore la bozza torna nel composer. */
async function rewrite(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	runEphemeralTurn: NonNullable<ExtensionCommandContext["runEphemeralTurn"]>,
	draft: string,
): Promise<void> {
	const restore = (message: string, type: "info" | "error") => {
		putInComposer(ctx, draft);
		ctx.ui.notify(message, type);
	};
	try {
		// Le impostazioni si leggono qui, non all'avvio: valgono le ultime modifiche.
		const settings = pi.pi.settings;
		const { target, warning } = await pickTarget(ctx, settings, pi.getThinkingLevel());
		if (warning) ctx.ui.notify(warning, "warning");
		const turn = target.kind === "role" ? await roleTurn(ctx, pi.pi, settings, target) : sessionTurn(runEphemeralTurn);
		const via = target.kind === "role" ? ` · ${target.model.provider}/${target.model.id}` : "";

		const analysis = await sideTurn(ctx, turn, `analyzing the draft${via}`, questionsPrompt(draft), { preview: false });
		if (analysis === undefined) return restore(CANCELLED, "info");

		const questions = parseQuestions(analysis);
		if (!questions) ctx.ui.notify("/rewrite: couldn't read the model's questions; rewriting without them", "warning");

		let answers: Answer[] = [];
		if (questions?.length) {
			const answered = await askQuestions(ctx, questions);
			if (!answered) return restore(CANCELLED, "info");
			answers = answered;
		}

		const { custom, warnings } = resolveInstructions(settings.getGlobalSettings(), settings.getProjectSettings());
		for (const warning of warnings) ctx.ui.notify(warning, "warning");
		const rewritten = await sideTurn(ctx, turn, `rewriting the prompt${via}`, rewritePrompt(draft, answers, custom), {
			preview: true,
		});
		if (rewritten === undefined) return restore(CANCELLED, "info");
		if (!rewritten.trim()) throw new Error("the model returned an empty rewrite");

		putInComposer(ctx, rewritten.trim());
		ctx.ui.notify("/rewrite: prompt rewritten into the composer; review it and press Enter", "info");
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		restore(`/rewrite: failed (${reason}); draft restored to the composer`, "error");
	}
}

/** Sceglie la modalità di combinazione; `undefined` = annullato. `"inherit"` solo per il progetto. */
async function pickMode(ctx: ExtensionCommandContext, scope: Scope, current: InstructionsMode | undefined): Promise<ModeChoice | undefined> {
	const { options, current: initialIndex } = modeChoices(scope, current);
	const choice = await ctx.ui.select(`Custom instructions mode (${scope})`, options, { initialIndex });
	return choice as ModeChoice | undefined;
}

/**
 * /rewrite-settings: ambito → testo (salvare vuoto lo svuota) → modalità. Esc in un
 * qualsiasi passo annulla senza modificare nulla.
 */
async function editInstructions(ctx: ExtensionCommandContext, settings: HostSettings): Promise<void> {
	const layers: Record<Scope, LayerValues> = {
		global: readLayer(settings.getGlobalSettings(), "global"),
		project: readLayer(settings.getProjectSettings(), "project"),
	};
	const choice = await ctx.ui.select("Custom rewrite instructions: which scope?", [
		{ label: "Global", description: `${describeLayer(layers.global)}; applies to every project` },
		{ label: "Project", description: `${describeLayer(layers.project)}; ${projectConfigPath(settings.getCwd())}` },
	]);
	if (choice === undefined) return;
	const scope: Scope = choice === "Global" ? "global" : "project";

	const typed = await ctx.ui.editor(`Custom /rewrite instructions (${scope}); save empty to clear`, layers[scope].instructions ?? "");
	if (typed === undefined) return;
	const instructions = typed.trim();
	let edit: InstructionsEdit = { instructions: undefined, mode: undefined };
	if (instructions) {
		const mode = await pickMode(ctx, scope, layers[scope].mode);
		if (mode === undefined) return;
		edit = { instructions, mode: mode === "inherit" ? undefined : mode };
	}

	let where: string;
	if (scope === "global") {
		await saveGlobal(settings, edit);
		where = "the global settings";
	} else {
		where = await saveProject(settings, edit);
	}
	const mode = edit.mode ?? (scope === "global" ? DEFAULT_MODE : "inherited");
	const what = instructions ? `saved (mode ${mode})` : "cleared";
	ctx.ui.notify(`/rewrite-settings: ${scope} instructions ${what} in ${where}`, "info");
}

export default function rewriteExtension(pi: ExtensionAPI) {
	let busy = false;

	// Il ruolo `rewrite` compare nel selettore dei modelli (/model → Roles) senza scrivere file.
	pi.on("session_start", async () => {
		if (Bun.semver.order(pi.pi.VERSION, REGISTRY_OMP_VERSION) >= 0) await showRoleInSelector(pi.pi.settings);
	});

	pi.registerCommand("rewrite", {
		description: "Rewrite a draft into a thorough prompt, asking about its direction first (/btw-style side turn)",
		handler: async (args, ctx) => {
			// Senza UI (print/json) non c'è composer dove consegnare il risultato: fallire subito, prima di chiamare il modello.
			if (!ctx.hasUI) throw new Error("/rewrite: needs an interactive UI (TUI or RPC); the result goes to the composer");
			const runEphemeralTurn = ctx.runEphemeralTurn;
			if (!runEphemeralTurn) {
				ctx.ui.notify(`/rewrite: requires omp ${MIN_OMP_VERSION} or newer (side turns for extensions)`, "error");
				return;
			}
			if (busy) {
				ctx.ui.notify("/rewrite: already running", "warning");
				return;
			}

			busy = true;
			try {
				let draft = args.trim();
				if (!draft) {
					const typed = await ctx.ui.editor("Draft prompt to rewrite");
					// Editor chiuso con Esc: annullamento esplicito, nessun avviso.
					if (typed === undefined) return;
					draft = typed.trim();
				}
				if (!draft) {
					ctx.ui.notify("/rewrite: empty draft; usage: /rewrite <draft>", "warning");
					return;
				}
				await rewrite(ctx, pi, runEphemeralTurn, draft);
			} finally {
				busy = false;
			}
		},
	});

	pi.registerCommand("rewrite-settings", {
		description: "Edit the custom instructions added to the /rewrite prompt (global or project)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) throw new Error("/rewrite-settings: needs an interactive UI (TUI or RPC)");
			try {
				await editInstructions(ctx, pi.pi.settings);
			} catch (err) {
				ctx.ui.notify(`/rewrite-settings: failed (${err instanceof Error ? err.message : String(err)})`, "error");
			}
		},
	});
}
