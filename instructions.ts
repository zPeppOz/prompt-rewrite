/**
 * Istruzioni personalizzate di /rewrite, senza dipendenze dall'host: lettura dei
 * livelli grezzi delle impostazioni (globale e progetto), risoluzione dell'ordine
 * di combinazione e modifica di un livello.
 */

export type Scope = "global" | "project";
export type InstructionsMode = "append" | "replace";

export const INSTRUCTIONS_MODES: readonly InstructionsMode[] = ["append", "replace"];
export const DEFAULT_MODE: InstructionsMode = "append";

// Chiavi annidate come tutte le impostazioni omp: `rewrite: { instructions, instructionsMode }`.
export const NAMESPACE = "rewrite";
export const INSTRUCTIONS_KEY = "instructions";
export const MODE_KEY = "instructionsMode";
export const INSTRUCTIONS_ID = `${NAMESPACE}.${INSTRUCTIONS_KEY}`;
export const MODE_ID = `${NAMESPACE}.${MODE_KEY}`;

/** Istruzioni effettive: testi per ambito (già ripuliti, mai vuoti) e modalità di combinazione. */
export interface CustomInstructions {
	global?: string;
	project?: string;
	mode: InstructionsMode;
}

/** Valori `rewrite.*` di un solo livello; `warnings` segnala i valori non validi ignorati. */
export interface LayerValues {
	instructions?: string;
	mode?: InstructionsMode;
	warnings: string[];
}

export interface InstructionsEdit {
	/** Testo vuoto o `undefined` = rimuove la chiave. */
	instructions: string | undefined;
	/** `undefined` = rimuove la chiave (il livello eredita). */
	mode: InstructionsMode | undefined;
}

/** Unica guardia di "mappa YAML/JSON" del pacchetto: i campi restano `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMode(value: unknown): value is InstructionsMode {
	return INSTRUCTIONS_MODES.includes(value as InstructionsMode);
}

/**
 * Valori di un livello grezzo. Come per le chiavi native di omp, un valore non
 * valido viene ignorato con un avviso e `null` vale "non impostato".
 */
export function readLayer(raw: unknown, scope: Scope): LayerValues {
	const values: LayerValues = { warnings: [] };
	const block = isRecord(raw) ? raw[NAMESPACE] : undefined;
	if (!isRecord(block)) return values;

	const text = block[INSTRUCTIONS_KEY];
	if (typeof text === "string") values.instructions = text.trim() || undefined;
	else if (text != null) values.warnings.push(`/rewrite: ignoring ${INSTRUCTIONS_ID} in the ${scope} settings (expected text)`);

	const mode = block[MODE_KEY];
	if (isMode(mode)) values.mode = mode;
	else if (mode != null) {
		const expected = INSTRUCTIONS_MODES.map(m => `"${m}"`).join(" or ");
		values.warnings.push(`/rewrite: ignoring ${MODE_ID} in the ${scope} settings (expected ${expected})`);
	}
	return values;
}

/**
 * Combina i due livelli: testi globale → progetto (un testo vuoto o assente lascia
 * solo l'altro), modalità progetto → globale → `append`. `custom` è `undefined`
 * quando nessun ambito ha testo, e il prompt resta quello di default.
 */
export function resolveInstructions(
	globalRaw: unknown,
	projectRaw: unknown,
): { custom: CustomInstructions | undefined; warnings: string[] } {
	const global = readLayer(globalRaw, "global");
	const project = readLayer(projectRaw, "project");
	const warnings = [...global.warnings, ...project.warnings];
	if (!global.instructions && !project.instructions) return { custom: undefined, warnings };
	return {
		custom: {
			global: global.instructions,
			project: project.instructions,
			mode: project.mode ?? global.mode ?? DEFAULT_MODE,
		},
		warnings,
	};
}

/**
 * Copia di un livello grezzo con `rewrite.*` aggiornato. Le altre chiavi restano
 * dove sono; un blocco `rewrite` rimasto vuoto sparisce.
 */
export function applyEdit(raw: Record<string, unknown>, edit: InstructionsEdit): Record<string, unknown> {
	const previous = raw[NAMESPACE];
	const block: Record<string, unknown> = isRecord(previous) ? { ...previous } : {};
	const text = edit.instructions?.trim();
	if (text) block[INSTRUCTIONS_KEY] = text;
	else delete block[INSTRUCTIONS_KEY];
	if (edit.mode) block[MODE_KEY] = edit.mode;
	else delete block[MODE_KEY];
	const keep = Object.keys(block).length > 0;

	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key !== NAMESPACE) next[key] = value;
		else if (keep) next[key] = block;
	}
	if (keep && !(NAMESPACE in next)) next[NAMESPACE] = block;
	return next;
}

/** Modalità scelta in /rewrite-settings: `inherit` toglie quella del progetto, che eredita la globale. */
export type ModeChoice = InstructionsMode | "inherit";

/**
 * Le modalità tra cui scegliere per un ambito, con la loro spiegazione (`inherit` solo per
 * il progetto), e l'indice di quella che corrisponde al livello com'è ora.
 */
export function modeChoices(
	scope: Scope,
	mode: InstructionsMode | undefined,
): { options: { label: ModeChoice; description: string }[]; current: number } {
	const options: { label: ModeChoice; description: string }[] = [
		{ label: "append", description: "Your instructions are added to the default rewrite rules" },
		{ label: "replace", description: "Your instructions replace the default rewrite rules (the draft and your answers are still sent)" },
	];
	if (scope === "project") options.unshift({ label: "inherit", description: `Use the global mode (default: ${DEFAULT_MODE})` });
	const selected = mode ?? (scope === "project" ? "inherit" : DEFAULT_MODE);
	return { options, current: Math.max(0, options.findIndex(o => o.label === selected)) };
}

/** Riassunto di un livello per la scelta dell'ambito: righe e modalità, o "not set". */
export function describeLayer({ instructions, mode }: LayerValues): string {
	return instructions ? `${instructions.split("\n").length} line(s), mode ${mode ?? "default"}` : "not set";
}
