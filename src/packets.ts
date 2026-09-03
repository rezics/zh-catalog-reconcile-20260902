import { join } from "node:path";

import {
	type BookEvidence,
	PacketCheckpointSchema,
	type ReviewPacket,
	ReviewPacketSchema,
	type RunConfig,
	SchemaVersion,
} from "./contracts.ts";
import { withOnlineCatalog } from "./database.ts";
import { sha256 } from "./hash.ts";
import {
	appendRunEvent,
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
import {
	candidateQuality,
	normalizedPrefix,
	preferredChineseTitle,
	suspiciousSignals,
} from "./normalize.ts";

function uniqueCandidates(
	sources: readonly BookEvidence[],
	candidates: readonly BookEvidence[],
	maximum: number,
): BookEvidence[] {
	const unique = [...sources, ...candidates].filter(
		(book, index, books) => books.findIndex(({ id }) => id === book.id) === index,
	);
	const sourceIds = new Set(sources.map(({ id }) => id));
	const sourceEntries = unique.filter(({ id }) => sourceIds.has(id));
	const ranked = unique
		.filter(({ id }) => !sourceIds.has(id))
		.sort((left, right) => {
			const quality = candidateQuality(right) - candidateQuality(left);
			if (quality !== 0) return quality;
			const age = left.createdAt.localeCompare(right.createdAt);
			return age !== 0 ? age : left.id.localeCompare(right.id);
		})
		.slice(0, Math.max(0, maximum - sourceEntries.length));
	return [...sourceEntries, ...ranked];
}

export function buildReviewPacket(
	config: RunConfig,
	part: number,
	prefix: string,
	sources: readonly BookEvidence[],
	candidates: readonly BookEvidence[],
): ReviewPacket {
	if (sources.length === 0 || sources.length > 20)
		throw new Error("Packet source count is outside the schema bound");
	for (const source of sources)
		if (!source.sourceEligible)
			throw new Error(`Protected Unit cannot be a packet source: ${source.id}`);
	const sourceUnitIds = sources.map(({ id }) => id).sort();
	const packetIdentity = {
		runId: config.runId,
		part,
		normalizedPrefix: prefix,
		sourceUnitIds,
	};
	const packetId = sha256(packetIdentity);
	const withoutHash = {
		schemaVersion: SchemaVersion,
		runId: config.runId,
		part,
		packetId,
		normalizedPrefix: prefix,
		sourceUnitIds,
		suspiciousSignals: Object.fromEntries(
			sources.map((source) => [source.id, suspiciousSignals(source)]),
		),
		candidates: uniqueCandidates(sources, candidates, config.maxCandidatesPerPacket),
	};
	return ReviewPacketSchema.parse({ ...withoutHash, inputHash: sha256(withoutHash) });
}

function compareSourcePosition(
	left: Pick<BookEvidence, "createdAt" | "id">,
	right: Pick<BookEvidence, "createdAt" | "id">,
): number {
	const time = Date.parse(left.createdAt) - Date.parse(right.createdAt);
	return time !== 0 ? time : left.id.localeCompare(right.id);
}

export async function readPacketCheckpoint(config: RunConfig) {
	const packetDirectory = join(runDirectory(config.runId), "packets");
	const checkpointPath = join(packetDirectory, "checkpoint.json");
	const partPaths = await listPartFiles(packetDirectory);
	let sourceCount = 0;
	let packetCount = 0;
	let lastSource: BookEvidence | undefined;

	for (const [expectedPart, partPath] of partPaths.entries()) {
		const partMatch = /part-(\d{5,12})\.jsonl$/u.exec(partPath);
		if (!partMatch?.[1] || Number(partMatch[1]) !== expectedPart)
			throw new Error(`Online packet parts are not contiguous at ${partPath}`);
		for await (const packet of readJsonLines(partPath, ReviewPacketSchema)) {
			if (packet.part !== expectedPart)
				throw new Error(`Packet part does not match its file: ${packet.packetId}`);
			packetCount += 1;
			for (const sourceUnitId of packet.sourceUnitIds) {
				const source = packet.candidates.find(({ id }) => id === sourceUnitId);
				if (!source?.sourceEligible)
					throw new Error(`Online packet source evidence is invalid: ${sourceUnitId}`);
				if (lastSource && compareSourcePosition(source, lastSource) <= 0)
					throw new Error(`Online packet source order is not strictly increasing: ${sourceUnitId}`);
				lastSource = source;
				sourceCount += 1;
			}
		}
	}

	let complete = false;
	if (await pathExists(checkpointPath)) {
		const stored = await readJson(checkpointPath, PacketCheckpointSchema);
		if (stored.runId !== config.runId) throw new Error("Packet checkpoint run ID mismatch");
		const matchesFiles =
			stored.sourceCount === sourceCount &&
			stored.packetCount === packetCount &&
			stored.nextPart === partPaths.length &&
			stored.lastSourceUnitId === (lastSource?.id ?? null) &&
			stored.lastSourceCreatedAt === (lastSource?.createdAt ?? null);
		if (stored.complete && !matchesFiles)
			throw new Error("A complete packet checkpoint does not match its packet files");
		complete = stored.complete && matchesFiles;
	}

	return PacketCheckpointSchema.parse({
		schemaVersion: SchemaVersion,
		runId: config.runId,
		evidenceMode: "online-batched",
		lastSourceCreatedAt: lastSource?.createdAt ?? null,
		lastSourceUnitId: lastSource?.id ?? null,
		sourceCount,
		packetCount,
		nextPart: partPaths.length,
		complete,
		updatedAt: nowIso(),
	});
}

export async function captureNextOnlinePacketBatch(config: RunConfig) {
	const packetDirectory = join(runDirectory(config.runId), "packets");
	const lockPath = join(packetDirectory, "capture.lock");
	return withFileLock(lockPath, async () => {
		let checkpoint = await readPacketCheckpoint(config);
		if (checkpoint.complete) return checkpoint;

		const groups = await withOnlineCatalog(config, (reader) =>
			reader.readEvidencePage({
				afterCreatedAt: checkpoint.lastSourceCreatedAt,
				afterUnitId: checkpoint.lastSourceUnitId,
				limit: config.onlineBatchSize,
				maxCandidates: config.maxCandidatesPerPacket,
			}),
		);
		if (groups.length === 0) {
			checkpoint = PacketCheckpointSchema.parse({
				...checkpoint,
				complete: true,
				updatedAt: nowIso(),
			});
			await writeJsonAtomic(join(packetDirectory, "checkpoint.json"), checkpoint);
			await appendRunEvent(config.runId, "packets.online.complete", {
				sourceCount: checkpoint.sourceCount,
				packetCount: checkpoint.packetCount,
			});
			return checkpoint;
		}

		const part = checkpoint.nextPart;
		const packets = groups.map(({ source, candidates }) =>
			buildReviewPacket(
				config,
				part,
				normalizedPrefix(preferredChineseTitle(source)) || source.id,
				[source],
				candidates,
			),
		);
		await writeJsonLinesAtomic(join(packetDirectory, partFileName(part)), packets);
		const lastSource = groups.at(-1)?.source;
		if (!lastSource) throw new Error("Online packet batch unexpectedly has no final source");
		checkpoint = PacketCheckpointSchema.parse({
			...checkpoint,
			lastSourceCreatedAt: lastSource.createdAt,
			lastSourceUnitId: lastSource.id,
			sourceCount: checkpoint.sourceCount + groups.length,
			packetCount: checkpoint.packetCount + packets.length,
			nextPart: part + 1,
			complete: groups.length < config.onlineBatchSize,
			updatedAt: nowIso(),
		});
		await writeJsonAtomic(join(packetDirectory, "checkpoint.json"), checkpoint);
		await appendRunEvent(config.runId, "packets.online.captured", {
			part,
			capturedSources: groups.length,
			sourceCount: checkpoint.sourceCount,
			packetCount: checkpoint.packetCount,
			complete: checkpoint.complete,
		});
		return checkpoint;
	});
}
