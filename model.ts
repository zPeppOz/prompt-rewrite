import type { Api, Message, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { isRecord } from "./instructions";
import { withTranscript } from "./rewrite";

/**
 * Modello di /rewrite: il ruolo `rewrite` del selettore dei modelli di omp (/model → Roles).
 * Senza ruolo, o con lo stesso modello e thinking della sessione, le richieste passano dal
 * side turn dell'host (`runEphemeralTurn`, che usa sempre il modello della sessione);
 * altrimenti /rewrite le manda da sé al modello del ruolo, con il system prompt della
 * sessione e la conversazione come trascrizione: il replay nativo dei messaggi su un altro
 * provider fallisce (Anthropic rifiuta i `tool_use` senza le definizioni dei tool).
 */

const ROLE = "rewrite";
const ROLE_NAME = "Rewrite";
// Selettori di thinking che non fissano un livello: valgono come "nessun livello".
const NO_LEVEL: Record<string, true> = { auto: true, inherit: true };

/** Una richiesta al modello: risposta intera, `onText` riceve il testo arrivato finora. */
export type Turn = (promptText: string, options: { signal: AbortSignal; onText?: (text: string) => void }) => Promise<string>;

/** Dove vanno le richieste di un /rewrite. */
export type Target = { kind: "session" } | { kind: "role"; model: Model<Api>; thinking: string | undefined };

/** La parte di `Settings` di omp (`pi.pi.settings`) usata da questo modulo. */
export interface RoleSettings {
	getModelRole(role: string): string | undefined;
	getProvenance(setting: unknown): string;
}

type RunEphemeralTurn = NonNullable<ExtensionCommandContext["runEphemeralTurn"]>;
type HostExports = Pick<ExtensionAPI["pi"], "buildSessionContext" | "convertToLlm" | "getAgentDir">;

// Moduli dell'host importati dinamicamente: esistono solo dentro omp (i test non li caricano).
// Gli specificatori devono restare letterali: omp li riscrive nel sorgente dell'estensione.

/**
 * Livello di thinking del ruolo: quello esplicito (`provider/id:high`), altrimenti, se
 * assente o `auto`, quello della sessione.
 */
export function roleThinking(explicit: string | undefined, session: string | undefined): string | undefined {
	return explicit && NO_LEVEL[explicit] !== true ? explicit : session;
}

/** Opzioni di stream per un livello: `off` spegne il ragionamento, nessun livello lascia il default del provider. */
export function reasoningOptions(level: string | undefined): Pick<SimpleStreamOptions, "reasoning" | "disableReasoning"> {
	if (level === "off") return { disableReasoning: true };
	if (!level || NO_LEVEL[level] === true) return {};
	return { reasoning: level as SimpleStreamOptions["reasoning"] };
}

/** Messaggi senza i blocchi di thinking: rumore per il rewrite, e Claude rifiuta il proprio ragionamento ricopiato. */
export function withoutThinking(messages: Message[]): Message[] {
	return messages.map(message => {
		if (message.role !== "assistant" || !message.content.some(block => block.type === "thinking")) return message;
		return { ...message, content: message.content.filter(block => block.type !== "thinking") };
	});
}

/**
 * Elenca il ruolo nel selettore dei modelli: omp mostra anche i ruoli che hanno solo un
 * tag in `modelTags`, e un tag di runtime non viene mai scritto su disco. Un tag `rewrite`
 * già configurato resta com'è.
 */
export async function showRoleInSelector(settings: RoleSettings): Promise<void> {
	const { lookup } = await import("@oh-my-pi/pi-coding-agent/config/registry");
	const tags = lookup("modelTags");
	if (!tags) return;
	const current: unknown = tags.get(settings);
	if (isRecord(current) && ROLE in current) return;
	// `override` sostituisce l'intero livello di runtime: le voci che altri vi hanno messo restano.
	const runtime = isRecord(current) && settings.getProvenance(tags) === "runtime" ? current : {};
	tags.override(settings, { ...runtime, [ROLE]: { name: ROLE_NAME } });
}

/**
 * Modello delle richieste: si legge a ogni /rewrite, così vale l'ultima scelta fatta in
 * /model. `warning` = il ruolo punta a un modello non disponibile e si usa la sessione.
 */
export async function pickTarget(
	ctx: ExtensionCommandContext,
	settings: RoleSettings,
	sessionThinking: string | undefined,
): Promise<{ target: Target; warning?: string }> {
	const value = settings.getModelRole(ROLE)?.trim();
	if (!value) return { target: { kind: "session" } };
	const [{ resolveModelRoleValue }, { clampThinkingLevelForModel }] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent/config/model-resolver"),
		import("@oh-my-pi/pi-catalog"),
	]);
	const resolved = resolveModelRoleValue(value, ctx.models.list(), { settings });
	const model = resolved.model;
	if (!model) {
		return {
			target: { kind: "session" },
			warning: `/rewrite: the "${ROLE}" model role (${value}) matches no available model; using the session model`,
		};
	}
	// Un livello esplicito arriva già adattato al modello; quello della sessione va adattato qui.
	const level = roleThinking(resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined, sessionThinking);
	const thinking = level && level !== "off" && NO_LEVEL[level] !== true ? clampThinkingLevelForModel(model, level) : level;
	const session = ctx.model;
	if (session?.provider === model.provider && session.id === model.id && thinking === sessionThinking) {
		return { target: { kind: "session" } };
	}
	return { target: { kind: "role", model, thinking } };
}

/** Richieste come side turn dell'host, sul modello della sessione. */
export function sessionTurn(runEphemeralTurn: RunEphemeralTurn): Turn {
	return async (promptText, { signal, onText }) => {
		let streamed = "";
		const { replyText } = await runEphemeralTurn({
			promptText,
			// Di default omp accorcia la risposta a 4 KiB (con "[…truncated]" in coda) e
			// comprime le righe ripetute: pensato per /btw, rovina un prompt riscritto o il JSON delle domande.
			dedupeReply: false,
			signal,
			onTextDelta: onText ? delta => onText((streamed += delta)) : undefined,
		});
		return replyText;
	};
}

/**
 * Richieste dirette al modello del ruolo. La trascrizione (branch corrente, dopo l'ultima
 * compattazione) e l'offuscatore dei segreti si preparano una volta e valgono per le due
 * richieste di un /rewrite. Come nel side turn dell'host, i segreti si offuscano solo nei
 * messaggi (non nel system prompt) e solo con `secrets.enabled`.
 */
export async function roleTurn(
	ctx: ExtensionCommandContext,
	host: HostExports,
	settings: RoleSettings,
	target: Extract<Target, { kind: "role" }>,
): Promise<Turn> {
	const [{ lookup }, secrets, { serializeConversationForSummary }, { streamSimple }] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent/config/registry"),
		import("@oh-my-pi/pi-coding-agent/secrets"),
		import("@oh-my-pi/pi-agent-core/compaction"),
		import("@oh-my-pi/pi-ai"),
	]);
	const { sessionManager } = ctx;
	const { messages } = host.buildSessionContext(sessionManager.getBranch(), sessionManager.getLeafId());
	const transcript = serializeConversationForSummary(withoutThinking(host.convertToLlm(messages)));
	const obfuscator =
		lookup("secrets.enabled")?.get(settings) === true
			? await secrets.buildSecretObfuscator(ctx.cwd, host.getAgentDir())
			: undefined;
	const reveal = (text: string) => (obfuscator ? obfuscator.deobfuscate(text) : text);
	const systemPrompt = ctx.getSystemPrompt();
	const sessionId = sessionManager.getSessionId();
	const apiKey = ctx.modelRegistry.resolver(target.model, sessionId);

	return async (promptText, { signal, onText }) => {
		const request: Message = {
			role: "user",
			content: [{ type: "text", text: withTranscript(transcript, promptText) }],
			attribution: "agent",
			timestamp: Date.now(),
		};
		// Se la lettura si interrompe (eccezione in `onText`), la richiesta non resta aperta.
		const stop = new AbortController();
		const stream = streamSimple(
			target.model,
			{ systemPrompt, messages: obfuscator ? secrets.obfuscateMessages(obfuscator, [request]) : [request] },
			{
				apiKey,
				sessionId: `${sessionId}:${ROLE}`,
				signal: AbortSignal.any([signal, stop.signal]),
				...reasoningOptions(target.thinking),
			},
		);
		let streamed = "";
		try {
			for await (const event of stream) {
				if (event.type === "text_delta") {
					streamed += event.delta;
					onText?.(reveal(streamed));
				} else if (event.type === "done") {
					return reveal(streamed).trim();
				} else if (event.type === "error") {
					throw new Error(event.error.errorMessage || "the model request failed");
				}
			}
		} finally {
			stop.abort();
		}
		throw new Error("the model request ended without a reply");
	};
}
