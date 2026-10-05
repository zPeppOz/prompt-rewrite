import { expect, test } from "bun:test";
import claudeCatalog from "./.claude-plugin/marketplace.json";
import claudePlugin from "./.claude-plugin/plugin.json";
import catalog from "./.omp-plugin/marketplace.json";
import pkg from "./package.json";

// `omp plugin upgrade` confronta solo la `version` del catalogo: se resta indietro
// rispetto a package.json, gli utenti del marketplace non ricevono l'aggiornamento.
test("the omp marketplace entry tracks package.json", () => {
	const entry = catalog.plugins.find(p => p.name === pkg.name);
	expect(entry?.version).toBe(pkg.version);
});

// Claude Code aggiorna un plugin quando cambia la `version` di plugin.json, che vince su quella
// del catalogo: per questo il catalogo di Claude Code non ne ha una.
test("the Claude Code manifest tracks package.json and its catalog lists it", () => {
	expect(claudePlugin.name).toBe(pkg.name);
	expect(claudePlugin.version).toBe(pkg.version);
	expect(claudeCatalog.plugins.map(p => [p.name, p.source])).toEqual([[pkg.name, "."]]);
});
