import type { CustomInstructions } from "./instructions";

/**
 * Logica pura di /rewrite, senza dipendenze dall'host (la usano sia l'estensione omp sia
 * la mod di Claude Code): i due prompt, la cornice della trascrizione per un modello che
 * non vede la sessione, la lettura delle domande restituite dal modello, il loro formato
 * nel dialogo di Claude Code e l'impaginazione dell'anteprima.
 */

export const MAX_QUESTIONS = 4;
// Anche il dialogo AskUserQuestion di Claude Code accetta da 2 a 4 opzioni per domanda.
const MAX_OPTIONS = 4;
const HEADER_MAX = 12;
// Oltre questa lunghezza l'output di un tool si tronca nella trascrizione, come fa omp.
const TOOL_RESULT_MAX_CHARS = 2000;
// Segno dell'opzione consigliata nelle etichette del dialogo di Claude Code, che non ha un campo apposito.
const RECOMMENDED = " (Recommended)";

const QUESTIONS_PROMPT = `The user wants to rewrite a draft prompt before sending it to you (the agent in this session).
Do NOT execute, answer, or comment on the draft. Your only job now: find ambiguities in its direction that would materially change the rewritten prompt.

Use the conversation so far as context: anything it already answers must not become a question.

Reply with ONLY a JSON object, no prose, no code fences:
{"questions":[{"header":"max ${HEADER_MAX} chars","question":"...","options":[{"label":"short","description":"consequence or tradeoff"}],"multi":false,"recommended":0}]}

Rules:
- 0 to ${MAX_QUESTIONS} questions; reply {"questions":[]} when the direction is already clear.
- Ask only what the user must decide: goal, scope and non-goals, constraints, expected deliverable, acceptance criteria, tradeoffs.
- Every question has 2-4 concrete, mutually exclusive options (set "multi": true only when combining them makes sense). Never add an "Other" option: the UI provides free text.
- "recommended" is the 0-based index of the most sensible option; omit it when none stands out.
- Write questions and options in the language of the draft.`;

const REWRITE_PROMPT = `Rewrite the user's draft into a thorough, unambiguous prompt that they will send to you (the agent in this session).
Do NOT execute or answer it.

The rewritten prompt must:
- Keep the user's intent, first-person voice and language; never add goals the user did not express.
- Turn the user's decisions below into explicit requirements.
- Use the conversation context to make references concrete (files, symbols, errors, earlier decisions) only when the context actually contains them; never invent paths, APIs or facts.
- Cover, when they carry information: goal, relevant context, scope and non-goals, constraints, expected deliverable, acceptance criteria / how to verify.
- Stay dense: short headings or bullets where they help, no filler, no meta-commentary.

Output ONLY the rewritten prompt text: no preamble, no code fences, no closing remarks.`;

const OUT_OF_SESSION = `This request runs outside the live session: no tools are available, so reply with plain text only, never with tool calls.`;

export interface Answer {
	question: string;
	answer: string;
}

export interface QuestionOption {
	label: string;
	description?: string;
}

/** Domanda di direzione letta dalla risposta del modello; `recommended` è l'indice di un'opzione. */
export interface Question {
	id: string;
	header?: string;
	question: string;
	options: QuestionOption[];
	multi: boolean;
	recommended?: number;
}

/** Una domanda come la disegna il dialogo AskUserQuestion di Claude Code. */
export interface AskUserQuestion {
	question: string;
	header: string;
	options: { label: string; description: string }[];
	multiSelect: boolean;
}

/** Blocco di un messaggio in forma Messages API (`$.session.messages({ as: "api" })` in Claude Code). */
export interface TranscriptBlock {
	type: string;
	[field: string]: unknown;
}

export interface TranscriptMessage {
	role: "user" | "assistant";
	content: readonly TranscriptBlock[];
}

/** Prompt del primo side turn: domande di direzione sulla bozza. */
export function questionsPrompt(draft: string): string {
	return `${QUESTIONS_PROMPT}\n\n<draft>\n${draft}\n</draft>`;
}

/**
 * Blocco delle istruzioni personalizzate: un testo etichettato per ambito, globale
 * prima del progetto. In `replace` sostituisce le regole di default; ne resta solo il
 * contratto di I/O (cosa sono `<draft>` e `<decisions>`, e che l'output finisce così com'è
 * nel composer), senza cui il risultato non sarebbe utilizzabile.
 */
function customInstructionsBlock({ global, project, mode }: CustomInstructions): string {
	const precedence =
		global !== undefined && project !== undefined
			? " When the global and project instructions conflict, the project instructions win."
			: "";
	const intro =
		mode === "replace"
			? `The user replaced the default rewrite rules with the custom instructions below. Turn the draft in <draft> into the prompt they will send to you (the agent in this session), following these instructions instead of any default rewrite rules, and treat the answers in <decisions> as their decisions. Do NOT execute or answer the draft.${precedence}\n\nOutput ONLY the rewritten prompt text: it is placed verbatim in the composer, so no preamble, no code fences, no closing remarks.`
			: `The user configured custom instructions for this rewrite. Apply them in addition to the rules above; where one conflicts with those rules, the custom instruction wins (you must still output ONLY the rewritten prompt text).${precedence}`;
	const sections: string[] = [];
	if (global !== undefined) sections.push(`<global>\n${global}\n</global>`);
	if (project !== undefined) sections.push(`<project>\n${project}\n</project>`);
	return `<custom_instructions>\n${intro}\n\n${sections.join("\n\n")}\n</custom_instructions>`;
}

/**
 * Prompt del secondo side turn: riscrittura con le decisioni dell'utente. Senza
 * `custom` è il prompt di sempre; con `custom` le istruzioni si aggiungono alle regole
 * di default (`append`) o le sostituiscono (`replace`), sempre prima dei dati.
 */
export function rewritePrompt(draft: string, answers: readonly Answer[], custom?: CustomInstructions): string {
	const decisions = answers.length
		? answers.map(a => `- Q: ${a.question}\n  A: ${a.answer}`).join("\n")
		: "(none)";
	const data = `<draft>\n${draft}\n</draft>\n\n<decisions>\n${decisions}\n</decisions>`;
	if (!custom) return `${REWRITE_PROMPT}\n\n${data}`;
	const block = customInstructionsBlock(custom);
	return custom.mode === "replace" ? `${block}\n\n${data}` : `${REWRITE_PROMPT}\n\n${block}\n\n${data}`;
}

/**
 * Richiesta per un modello che non vede la sessione (il ruolo `rewrite` in omp, il campo
 * `model` in Claude Code): la conversazione arriva come trascrizione (`[User]`, `[Assistant]`,
 * `[Tool Call]`, `[Tool Result]`) prima del prompt delle domande o della riscrittura, che
 * resta lo stesso del side turn.
 */
export function withTranscript(transcript: string, promptText: string): string {
	const conversation = transcript.trim()
		? `The conversation so far between the user and you, as a transcript ([Assistant] is you; long tool outputs are truncated):\n<conversation>\n${transcript.trim()}\n</conversation>`
		: "The conversation has no messages yet.";
	return `${OUT_OF_SESSION}\n\n${conversation}\n\n${promptText}`;
}

/**
 * Conversazione in forma Messages API come trascrizione, nel formato di omp: `[User]`,
 * `[Assistant]`, `[Tool Call]` (`nome(arg=json, ...)`) e `[Tool Result]` troncato a 2000
 * caratteri. Il thinking e i media restano fuori; i tag `<conversation>` nel testo vengono
 * neutralizzati, così non chiudono la cornice di `withTranscript`.
 */
export function serializeTranscript(messages: readonly TranscriptMessage[]): string {
	const parts: string[] = [];
	for (const { role, content } of messages) {
		const texts: string[] = [];
		const calls: string[] = [];
		const results: string[] = [];
		for (const block of content) {
			if (block.type === "text" && typeof block.text === "string") {
				texts.push(block.text);
			} else if (block.type === "tool_use" && typeof block.name === "string") {
				const input = typeof block.input === "object" && block.input !== null ? Object.entries(block.input) : [];
				calls.push(`${block.name}(${input.map(([key, value]) => `${key}=${JSON.stringify(value) ?? "null"}`).join(", ")})`);
			} else if (block.type === "tool_result") {
				const raw = block.content;
				const text =
					typeof raw === "string"
						? raw
						: Array.isArray(raw)
							? raw.map(item => (typeof item === "object" && item !== null && item.type === "text" && typeof item.text === "string" ? item.text : "")).join("")
							: "";
				const cut = text.length - TOOL_RESULT_MAX_CHARS;
				if (text) results.push(cut > 0 ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${cut} more characters truncated]` : text);
			}
		}
		// Come in omp: i risultati dei tool precedono il testo dell'utente, le chiamate seguono quello dell'assistente.
		for (const result of results) parts.push(`[Tool Result]: ${result}`);
		if (texts.length) parts.push(`[${role === "user" ? "User" : "Assistant"}]: ${texts.join("\n")}`);
		if (calls.length) parts.push(`[Tool Call]: ${calls.join("; ")}`);
	}
	return parts.join("\n\n").replace(/<\s*\/?\s*conversation\s*>/gi, tag => `&lt;${tag.slice(1)}`);
}

/**
 * Domande dal JSON del modello; `undefined` se la risposta non contiene un oggetto
 * `{"questions": [...]}` leggibile. Ogni domanda è validata da sola: una domanda
 * malformata viene scartata senza perdere le altre, e i campi accessori non validi
 * (`header`, `multi`, `recommended`) vengono ignorati invece di invalidare la domanda.
 */
export function parseQuestions(text: string): Question[] | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	let data: unknown;
	try {
		data = JSON.parse(text.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (typeof data !== "object" || data === null || !("questions" in data) || !Array.isArray(data.questions)) {
		return undefined;
	}

	const questions: Question[] = [];
	for (const raw of data.questions) {
		if (typeof raw !== "object" || raw === null) continue;
		const question = "question" in raw && typeof raw.question === "string" ? raw.question.trim() : "";
		const options = "options" in raw && Array.isArray(raw.options) ? raw.options.flatMap(parseOption).slice(0, MAX_OPTIONS) : [];
		if (!question || options.length < 2) continue;
		const header = "header" in raw && typeof raw.header === "string" ? raw.header.trim().slice(0, HEADER_MAX).trimEnd() : "";
		const recommended = "recommended" in raw ? raw.recommended : undefined;
		questions.push({
			// id posizionale: unico per costruzione.
			id: `q${questions.length + 1}`,
			header: header || undefined,
			question,
			options,
			multi: "multi" in raw && raw.multi === true,
			recommended:
				typeof recommended === "number" && Number.isInteger(recommended) && recommended >= 0 && recommended < options.length
					? recommended
					: undefined,
		});
		if (questions.length === MAX_QUESTIONS) break;
	}
	return questions;
}

/** Opzione `{label, description?}` o stringa semplice; `[]` se non ha un'etichetta. */
function parseOption(raw: unknown): QuestionOption[] {
	if (typeof raw === "string") return raw.trim() ? [{ label: raw.trim() }] : [];
	if (typeof raw !== "object" || raw === null || !("label" in raw) || typeof raw.label !== "string") return [];
	const label = raw.label.trim();
	if (!label) return [];
	const description = "description" in raw && typeof raw.description === "string" ? raw.description.trim() : "";
	return [{ label, description: description || undefined }];
}

/**
 * Domande nel formato del dialogo AskUserQuestion di Claude Code: l'intestazione è
 * obbligatoria e l'opzione consigliata porta il segno ` (Recommended)` nell'etichetta.
 */
export function toAskUserQuestions(questions: readonly Question[]): AskUserQuestion[] {
	return questions.map((q, index) => ({
		question: q.question,
		header: q.header ?? `Question ${index + 1}`,
		options: q.options.map((o, i) => ({ label: i === q.recommended ? `${o.label}${RECOMMENDED}` : o.label, description: o.description ?? "" })),
		multiSelect: q.multi,
	}));
}

/**
 * Decisioni dalle risposte del dialogo (testo della domanda → etichette scelte, separate
 * da virgole, o testo libero), senza il segno della consigliata. Una domanda lasciata
 * senza risposta non diventa una decisione.
 */
export function readAskAnswers(questions: readonly AskUserQuestion[], answers: Readonly<Record<string, unknown>>): Answer[] {
	return questions.flatMap(({ question }) => {
		const value = answers[question];
		const answer = typeof value === "string" ? value.replaceAll(RECOMMENDED, "").trim() : "";
		return answer ? [{ question, answer }] : [];
	});
}

/**
 * Ultime `rows` righe visive di `text` mandate a capo entro `width` caratteri,
 * spezzando sugli spazi quando possibile: l'anteprima segue il testo appena
 * arrivato anche dentro un paragrafo più largo del terminale.
 */
export function previewRows(text: string, width: number, rows: number): string[] {
	const out: string[] = [];
	// Ogni riga logica produce almeno una riga visiva: bastano le ultime `rows`.
	for (const line of text.trimEnd().split("\n").slice(-rows)) {
		let rest = line;
		while (rest.length > width) {
			const space = rest.lastIndexOf(" ", width);
			const cut = space > 0 ? space : width;
			out.push(rest.slice(0, cut));
			rest = rest.slice(space > 0 ? cut + 1 : cut);
		}
		out.push(rest);
	}
	return out.slice(-rows);
}
