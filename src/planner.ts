import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	CurrentDecisionPolicyRevision,
	type ManifestAction,
	ManifestActionSchema,
	type ReviewPacket,
	ReviewPacketSchema,
	type RunConfig,
	SchemaVersion,
	type SourceDecision,
	SourceDecisionSchema,
} from "./contracts.ts";
import {
	DecisionQualityCollector,
	decisionPartQualityIssues,
	validateDecisionAgainstPacket,
} from "./decision-quality.ts";
import { sha256 } from "./hash.ts";
import {
	appendRunEvent,
	listPartFiles,
	partFileName,
	pathExists,
	readJsonLines,
	runDirectory,
	writeJsonAtomic,
} from "./io.ts";
import { readPacketCheckpoint } from "./packets.ts";

export function compileDecision(
	config: RunConfig,
	packet: ReviewPacket,
	decision: SourceDecision,
): ManifestAction | null {
	validateDecisionAgainstPacket(config, packet, decision);
	if (decision.disposition === "keep" || decision.disposition === "review") return null;
	const source = packet.candidates.find(({ id }) => id === decision.sourceUnitId);
	if (!source) throw new Error(`Source evidence missing from packet: ${decision.sourceUnitId}`);
	const decisionHash = sha256(decision);
	const actionIdentity = {
		runId: config.runId,
		packetId: packet.packetId,
		sourceUnitId: source.id,
		disposition: decision.disposition,
		decisionHash,
	};
	const actionId = sha256(actionIdentity);
	const common = {
		schemaVersion: SchemaVersion,
		runId: config.runId,
		actionId,
		packetId: packet.packetId,
		inputHash: packet.inputHash,
		decisionHash,
		sourceUnitId: source.id,
		expectedSourceUpdatedAt: source.updatedAt,
		confidence: decision.confidence,
		reason: decision.reason,
		approval:
			decision.confidence === "high" ? ("canary_candidate" as const) : ("human_required" as const),
		idempotencyKey: `zhcr:${config.runId}:${actionId.slice(0, 32)}`,
	};

	if (decision.disposition === "merge") {
		const target = packet.candidates.find(({ id }) => id === decision.targetUnitId);
		if (!target) throw new Error(`Target evidence missing from packet: ${decision.targetUnitId}`);
		return ManifestActionSchema.parse({
			...common,
			kind: "merge",
			targetUnitId: target.id,
			expectedTargetUpdatedAt: target.updatedAt,
		});
	}
	if (decision.disposition === "soft_delete")
		return ManifestActionSchema.parse({ ...common, kind: "soft_delete" });
	return ManifestActionSchema.parse({
		...common,
		kind: "revision_proposal",
		approval: "human_required",
		patches: decision.patches,
	});
}

async function loadDecisions(path: string): Promise<Map<string, SourceDecision>> {
	const decisions = new Map<string, SourceDecision>();
	if (!(await pathExists(path))) return decisions;
	for await (const decision of readJsonLines(path, SourceDecisionSchema)) {
		if (decisions.has(decision.sourceUnitId))
			throw new Error(`Duplicate decision for ${decision.sourceUnitId}`);
		decisions.set(decision.sourceUnitId, decision);
	}
	return decisions;
}

export async function generateManifest(config: RunConfig): Promise<{
	readonly sourceCount: number;
	readonly actionCount: number;
	readonly byKind: Readonly<Record<string, number>>;
}> {
	if (config.decisionPolicyRevision !== CurrentDecisionPolicyRevision)
		throw new Error(
			`Run decision policy ${config.decisionPolicyRevision} cannot produce a quality-gated manifest`,
		);
	const packetCheckpoint = await readPacketCheckpoint(config);
	if (!packetCheckpoint.complete)
		throw new Error("Online source traversal is incomplete; continue next/record before planning");
	const directory = runDirectory(config.runId);
	const manifestDirectory = join(directory, "manifests");
	const finalPath = join(manifestDirectory, "actions.jsonl");
	if (await pathExists(finalPath)) throw new Error("Manifest already exists; runs are immutable");
	await mkdir(manifestDirectory, { recursive: true });
	const temporaryPath = `${finalPath}.${process.pid}.tmp`;
	await writeFile(temporaryPath, "", { encoding: "utf8", flag: "wx" });
	let sourceCount = 0;
	let actionCount = 0;
	const byKind: Record<string, number> = {};
	const quality = new DecisionQualityCollector(config);

	try {
		for (const packetPath of await listPartFiles(join(directory, "packets"))) {
			const match = /part-(\d{5,12})\.jsonl$/u.exec(packetPath);
			if (!match?.[1]) throw new Error(`Unexpected packet part path: ${packetPath}`);
			const part = Number(match[1]);
			const decisions = await loadDecisions(join(directory, "decisions", partFileName(part)));
			const consumedDecisionIds = new Set<string>();
			let partSourceCount = 0;
			for await (const packet of readJsonLines(packetPath, ReviewPacketSchema)) {
				for (const sourceUnitId of packet.sourceUnitIds) {
					sourceCount += 1;
					partSourceCount += 1;
					quality.addSources(1);
					const decision = decisions.get(sourceUnitId);
					if (!decision) throw new Error(`Missing decision for source ${sourceUnitId}`);
					consumedDecisionIds.add(sourceUnitId);
					quality.addDecision(decision);
					const action = compileDecision(config, packet, decision);
					if (!action) continue;
					await writeFile(temporaryPath, `${JSON.stringify(action)}\n`, {
						encoding: "utf8",
						flag: "a",
					});
					actionCount += 1;
					byKind[action.kind] = (byKind[action.kind] ?? 0) + 1;
				}
			}
			for (const sourceUnitId of decisions.keys())
				if (!consumedDecisionIds.has(sourceUnitId))
					throw new Error(`Decision has no source in packet part ${part}: ${sourceUnitId}`);
			for (const issue of decisionPartQualityIssues(part, [...decisions.values()], partSourceCount))
				quality.addIssue(issue);
		}
		const qualityReport = quality.finish();
		await writeJsonAtomic(join(directory, "reports", "decision-quality.json"), qualityReport);
		if (qualityReport.status !== "passed")
			throw new Error(
				`Decision quality gate failed with ${qualityReport.issueCount} issue(s); inspect reports/decision-quality.json`,
			);
		await rename(temporaryPath, finalPath);
	} catch (error) {
		await Bun.file(temporaryPath).delete();
		throw error;
	}

	const summary = { sourceCount, actionCount, byKind };
	await writeJsonAtomic(join(directory, "reports", "manifest-summary.json"), {
		schemaVersion: SchemaVersion,
		runId: config.runId,
		...summary,
	});
	await appendRunEvent(config.runId, "manifest.generated", {
		sourceCount,
		actionCount,
		byKind,
	});
	return summary;
}
