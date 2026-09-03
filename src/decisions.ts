import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
	type ReviewPacket,
	ReviewPacketSchema,
	type RunConfig,
	type SourceDecision,
	SourceDecisionSchema,
} from "./contracts.ts";
import {
	appendJsonLines,
	appendRunEvent,
	assertPathInsideRepository,
	listPartFiles,
	partFileName,
	pathExists,
	readJsonLines,
	runDirectory,
	withFileLock,
} from "./io.ts";
import { captureNextOnlinePacketBatch, readPacketCheckpoint } from "./packets.ts";

function packetEvidenceIds(packet: ReviewPacket): Set<string> {
	const ids = new Set(packet.candidates.map(({ id }) => id));
	for (const candidate of packet.candidates)
		for (const attribution of candidate.attributions) ids.add(attribution.creditedUnitId);
	return ids;
}

export function validateDecisionAgainstPacket(
	config: RunConfig,
	packet: ReviewPacket,
	decision: SourceDecision,
): void {
	if (decision.runId !== config.runId || packet.runId !== config.runId)
		throw new Error("Run ID mismatch");
	if (decision.part !== packet.part) throw new Error("Decision part does not match packet part");
	if (decision.packetId !== packet.packetId || decision.inputHash !== packet.inputHash)
		throw new Error("Decision is not bound to the packet hash");
	if (!packet.sourceUnitIds.includes(decision.sourceUnitId))
		throw new Error(`Decision source is not a packet source: ${decision.sourceUnitId}`);
	const source = packet.candidates.find(({ id }) => id === decision.sourceUnitId);
	if (!source?.sourceEligible)
		throw new Error(`Decision attempts to mutate a protected source: ${decision.sourceUnitId}`);

	const evidenceIds = packetEvidenceIds(packet);
	if (!decision.evidenceUnitIds.includes(decision.sourceUnitId))
		throw new Error("Decision evidence must include the source Unit");
	for (const evidenceUnitId of decision.evidenceUnitIds)
		if (!evidenceIds.has(evidenceUnitId))
			throw new Error(`Decision cites evidence outside the packet: ${evidenceUnitId}`);

	if (decision.disposition === "merge") {
		if (decision.targetUnitId === decision.sourceUnitId)
			throw new Error("A Unit cannot merge into itself");
		if (!packet.candidates.some(({ id }) => id === decision.targetUnitId))
			throw new Error(`Merge target is outside the packet: ${decision.targetUnitId}`);
	}
	if (decision.disposition === "revise") {
		for (const patch of decision.patches) {
			for (const evidenceUnitId of patch.evidenceUnitIds)
				if (!evidenceIds.has(evidenceUnitId))
					throw new Error(`Revision patch cites evidence outside the packet: ${evidenceUnitId}`);
			if (patch.kind === "credit_replacement" && !evidenceIds.has(patch.creditedUnitId))
				throw new Error(`Replacement credit is outside the packet: ${patch.creditedUnitId}`);
		}
	}
}

async function parseDecisionFile(pathInput: string): Promise<SourceDecision[]> {
	const path = assertPathInsideRepository(pathInput);
	const source = await readFile(path, "utf8");
	try {
		const value: unknown = JSON.parse(source);
		return Array.isArray(value)
			? value.map((item) => SourceDecisionSchema.parse(item))
			: [SourceDecisionSchema.parse(value)];
	} catch (jsonError) {
		const decisions: SourceDecision[] = [];
		for (const [index, line] of source.split(/\r?\n/u).entries()) {
			if (!line.trim()) continue;
			try {
				decisions.push(SourceDecisionSchema.parse(JSON.parse(line)));
			} catch (lineError) {
				throw new Error(`Invalid decision at ${path}:${index + 1}`, {
					cause: lineError ?? jsonError,
				});
			}
		}
		return decisions;
	}
}

async function loadPacketMap(path: string): Promise<Map<string, ReviewPacket>> {
	const packets = new Map<string, ReviewPacket>();
	for await (const packet of readJsonLines(path, ReviewPacketSchema))
		packets.set(packet.packetId, packet);
	return packets;
}

async function loadExistingSourceIds(path: string): Promise<Set<string>> {
	const sourceIds = new Set<string>();
	if (!(await pathExists(path))) return sourceIds;
	for await (const decision of readJsonLines(path, SourceDecisionSchema)) {
		if (sourceIds.has(decision.sourceUnitId))
			throw new Error(`Duplicate persisted decision for ${decision.sourceUnitId}`);
		sourceIds.add(decision.sourceUnitId);
	}
	return sourceIds;
}

export async function recordDecisions(
	config: RunConfig,
	decisionPath: string,
): Promise<{ readonly recorded: number }> {
	const decisions = await parseDecisionFile(decisionPath);
	if (decisions.length === 0) throw new Error("Decision file is empty");
	const incomingSourceIds = new Set<string>();
	for (const decision of decisions) {
		if (incomingSourceIds.has(decision.sourceUnitId))
			throw new Error(`Duplicate incoming decision for ${decision.sourceUnitId}`);
		incomingSourceIds.add(decision.sourceUnitId);
	}

	const grouped = Map.groupBy(decisions, ({ part }) => part);
	for (const [part, partDecisions] of grouped) {
		const packetPath = join(runDirectory(config.runId), "packets", partFileName(part));
		if (!(await pathExists(packetPath))) throw new Error(`Packet part does not exist: ${part}`);
		const outputPath = join(runDirectory(config.runId), "decisions", partFileName(part));
		const lockPath = join(runDirectory(config.runId), "decisions", `${partFileName(part)}.lock`);
		await withFileLock(lockPath, async () => {
			const packetMap = await loadPacketMap(packetPath);
			const existing = await loadExistingSourceIds(outputPath);
			for (const decision of partDecisions) {
				if (existing.has(decision.sourceUnitId))
					throw new Error(`Decision already exists for ${decision.sourceUnitId}`);
				const packet = packetMap.get(decision.packetId);
				if (!packet) throw new Error(`Packet not found: ${decision.packetId}`);
				validateDecisionAgainstPacket(config, packet, decision);
			}
			await appendJsonLines(outputPath, partDecisions);
		});
	}
	await appendRunEvent(config.runId, "decisions.recorded", { count: decisions.length });
	return { recorded: decisions.length };
}

async function decisionsForPart(config: RunConfig, part: number): Promise<Set<string>> {
	return loadExistingSourceIds(join(runDirectory(config.runId), "decisions", partFileName(part)));
}

export async function nextPackets(
	config: RunConfig,
	limit: number,
): Promise<
	readonly { readonly packet: ReviewPacket; readonly undecidedSourceUnitIds: readonly string[] }[]
> {
	const pending = await findPendingPackets(config, limit);
	if (pending.length > 0) return pending;
	const checkpoint = await readPacketCheckpoint(config);
	if (checkpoint.complete) return [];
	await captureNextOnlinePacketBatch(config);
	return findPendingPackets(config, limit);
}

async function findPendingPackets(
	config: RunConfig,
	limit: number,
): Promise<
	readonly { readonly packet: ReviewPacket; readonly undecidedSourceUnitIds: readonly string[] }[]
> {
	const result: {
		readonly packet: ReviewPacket;
		readonly undecidedSourceUnitIds: readonly string[];
	}[] = [];
	for (const packetPath of await listPartFiles(join(runDirectory(config.runId), "packets"))) {
		const match = /part-(\d{5,12})\.jsonl$/u.exec(packetPath);
		if (!match?.[1]) throw new Error(`Unexpected packet part path: ${packetPath}`);
		const decided = await decisionsForPart(config, Number(match[1]));
		for await (const packet of readJsonLines(packetPath, ReviewPacketSchema)) {
			const undecidedSourceUnitIds = packet.sourceUnitIds.filter(
				(sourceUnitId) => !decided.has(sourceUnitId),
			);
			if (undecidedSourceUnitIds.length > 0) result.push({ packet, undecidedSourceUnitIds });
			if (result.length >= limit) return result;
		}
	}
	return result;
}

export async function runStatus(config: RunConfig): Promise<{
	readonly packetCount: number;
	readonly sourceCount: number;
	readonly decisionCount: number;
	readonly remainingCount: number;
	readonly onlineComplete: boolean;
}> {
	let packetCount = 0;
	let sourceCount = 0;
	let decisionCount = 0;
	for (const packetPath of await listPartFiles(join(runDirectory(config.runId), "packets"))) {
		const match = /part-(\d{5,12})\.jsonl$/u.exec(packetPath);
		if (!match?.[1]) throw new Error(`Unexpected packet part path: ${packetPath}`);
		const decided = await decisionsForPart(config, Number(match[1]));
		decisionCount += decided.size;
		for await (const packet of readJsonLines(packetPath, ReviewPacketSchema)) {
			packetCount += 1;
			sourceCount += packet.sourceUnitIds.length;
		}
	}
	const checkpoint = await readPacketCheckpoint(config);
	return {
		packetCount,
		sourceCount,
		decisionCount,
		remainingCount: Math.max(0, sourceCount - decisionCount),
		onlineComplete: checkpoint.complete,
	};
}
