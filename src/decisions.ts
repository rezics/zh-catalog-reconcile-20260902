import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
	CurrentDecisionPolicyRevision,
	DecisionProgressCheckpointSchema,
	type PersistedSourceDecision,
	PersistedSourceDecisionSchema,
	type ReviewPacket,
	ReviewPacketSchema,
	type RunConfig,
	type SourceDecision,
	SourceDecisionSchema,
} from "./contracts.ts";
import {
	assertDecisionPartQuality,
	isCurrentDecision,
	validateDecisionAgainstPacket,
} from "./decision-quality.ts";
import {
	appendJsonLines,
	appendRunEvent,
	assertPathInsideRepository,
	listPartFiles,
	nowIso,
	partFileName,
	pathExists,
	readJson,
	readJsonLines,
	runDirectory,
	withFileLock,
	writeJsonAtomic,
	writeJsonLinesAtomic,
} from "./io.ts";
import { captureNextOnlinePacketBatch, readPacketCheckpoint } from "./packets.ts";

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

async function loadPersistedDecisions(path: string): Promise<PersistedSourceDecision[]> {
	const decisions: PersistedSourceDecision[] = [];
	const sourceIds = new Set<string>();
	if (!(await pathExists(path))) return decisions;
	for await (const decision of readJsonLines(path, PersistedSourceDecisionSchema)) {
		if (sourceIds.has(decision.sourceUnitId))
			throw new Error(`Duplicate persisted decision for ${decision.sourceUnitId}`);
		sourceIds.add(decision.sourceUnitId);
		decisions.push(decision);
	}
	return decisions;
}

async function loadExistingSourceIds(path: string): Promise<Set<string>> {
	return new Set((await loadPersistedDecisions(path)).map(({ sourceUnitId }) => sourceUnitId));
}

export async function recordDecisions(
	config: RunConfig,
	decisionPath: string,
): Promise<{ readonly recorded: number }> {
	return recordDecisionValues(config, await parseDecisionFile(decisionPath));
}

export async function recordDecisionValues(
	config: RunConfig,
	decisionsInput: readonly SourceDecision[],
): Promise<{ readonly recorded: number }> {
	if (config.decisionPolicyRevision !== CurrentDecisionPolicyRevision)
		throw new Error(
			`Run decision policy ${config.decisionPolicyRevision} is read-only; initialize a new run`,
		);
	const decisions = decisionsInput.map((decision) => SourceDecisionSchema.parse(decision));
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
			const persisted = await loadPersistedDecisions(outputPath);
			const existing = new Set(persisted.map(({ sourceUnitId }) => sourceUnitId));
			const current = persisted.filter(isCurrentDecision);
			if (current.length !== persisted.length)
				throw new Error(`Packet part ${part} contains legacy decisions and cannot be resumed`);
			for (const decision of partDecisions) {
				if (existing.has(decision.sourceUnitId))
					throw new Error(`Decision already exists for ${decision.sourceUnitId}`);
				const packet = packetMap.get(decision.packetId);
				if (!packet) throw new Error(`Packet not found: ${decision.packetId}`);
				validateDecisionAgainstPacket(config, packet, decision);
			}
			const expectedSourceCount = [...packetMap.values()].reduce(
				(count, packet) => count + packet.sourceUnitIds.length,
				0,
			);
			assertDecisionPartQuality(part, [...current, ...partDecisions], expectedSourceCount);
			if (persisted.length === 0) await writeJsonLinesAtomic(outputPath, partDecisions);
			else await appendJsonLines(outputPath, partDecisions);
		});
	}
	await appendRunEvent(config.runId, "decisions.recorded", {
		count: decisions.length,
		decisionPolicyRevision: config.decisionPolicyRevision,
	});
	return { recorded: decisions.length };
}

async function decisionsForPart(config: RunConfig, part: number): Promise<Set<string>> {
	return loadExistingSourceIds(join(runDirectory(config.runId), "decisions", partFileName(part)));
}

async function decisionProgressStart(config: RunConfig): Promise<number> {
	const checkpointPath = join(runDirectory(config.runId), "decisions", "checkpoint.json");
	if (!(await pathExists(checkpointPath))) return 0;
	const checkpoint = await readJson(checkpointPath, DecisionProgressCheckpointSchema);
	if (checkpoint.runId !== config.runId) throw new Error("Decision checkpoint run ID mismatch");
	return checkpoint.completedThroughPart + 1;
}

async function markDecisionPartComplete(config: RunConfig, part: number): Promise<void> {
	await writeJsonAtomic(
		join(runDirectory(config.runId), "decisions", "checkpoint.json"),
		DecisionProgressCheckpointSchema.parse({
			schemaVersion: 1,
			runId: config.runId,
			completedThroughPart: part,
			updatedAt: nowIso(),
		}),
	);
}

export async function nextPackets(
	config: RunConfig,
	limit: number,
): Promise<
	readonly { readonly packet: ReviewPacket; readonly undecidedSourceUnitIds: readonly string[] }[]
> {
	if (config.decisionPolicyRevision !== CurrentDecisionPolicyRevision)
		throw new Error(
			`Run decision policy ${config.decisionPolicyRevision} is read-only; initialize a new run`,
		);
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
	const packetCheckpoint = await readPacketCheckpoint(config);
	const packetDirectory = join(runDirectory(config.runId), "packets");
	const startPart = await decisionProgressStart(config);
	if (startPart > packetCheckpoint.nextPart)
		throw new Error("Decision checkpoint is ahead of the packet checkpoint");
	for (let part = startPart; part < packetCheckpoint.nextPart; part += 1) {
		const packetPath = join(packetDirectory, partFileName(part));
		if (!(await pathExists(packetPath)))
			throw new Error(`Decision checkpoint reached a missing packet part: ${part}`);
		const decided = await decisionsForPart(config, part);
		for await (const packet of readJsonLines(packetPath, ReviewPacketSchema)) {
			const undecidedSourceUnitIds = packet.sourceUnitIds.filter(
				(sourceUnitId) => !decided.has(sourceUnitId),
			);
			if (undecidedSourceUnitIds.length > 0) result.push({ packet, undecidedSourceUnitIds });
			if (result.length >= limit) return result;
		}
		if (result.length > 0) return result;
		await markDecisionPartComplete(config, part);
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
