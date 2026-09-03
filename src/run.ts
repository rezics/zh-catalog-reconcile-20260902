import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
	CurrentDecisionPolicyRevision,
	type RunConfig,
	RunConfigSchema,
	SchemaVersion,
	SourceStartSchema,
} from "./contracts.ts";
import {
	appendRunEvent,
	loadRunConfig,
	nowIso,
	pathExists,
	runDirectory,
	writeJsonAtomic,
} from "./io.ts";
import { readPacketCheckpoint } from "./packets.ts";

export type InitializeRunInput = {
	readonly runId: string;
	readonly rezicsRef: string;
	readonly cutoff: string;
	readonly afterRunId?: string;
	readonly onlineBatchSize?: number;
};

export async function initializeRun(input: InitializeRunInput): Promise<RunConfig> {
	const directory = runDirectory(input.runId);
	if (await pathExists(directory)) throw new Error(`Run already exists: ${input.runId}`);
	let sourceStart = null;
	if (input.afterRunId !== undefined) {
		if (input.afterRunId === input.runId)
			throw new Error("A run cannot use itself as the source-start predecessor");
		const predecessor = await loadRunConfig(input.afterRunId);
		if (predecessor.evidenceMode !== "online-batched")
			throw new Error("The source-start predecessor is not an online-batched run");
		if (predecessor.cutoff !== input.cutoff)
			throw new Error("The source-start predecessor uses a different creation cutoff");
		if (predecessor.rezicsRef !== input.rezicsRef)
			throw new Error("The source-start predecessor uses a different REZICS release reference");
		const checkpoint = await readPacketCheckpoint(predecessor, { verifyAll: true });
		if (
			checkpoint.sourceCount === 0 ||
			checkpoint.lastSourceCreatedAt === null ||
			checkpoint.lastSourceUnitId === null
		)
			throw new Error("The source-start predecessor has no captured source cursor");
		sourceStart = SourceStartSchema.parse({
			fromRunId: predecessor.runId,
			afterCreatedAt: checkpoint.lastSourceCreatedAt,
			afterUnitId: checkpoint.lastSourceUnitId,
		});
	}
	const config = RunConfigSchema.parse({
		schemaVersion: SchemaVersion,
		runId: input.runId,
		createdAt: nowIso(),
		cutoff: input.cutoff,
		rezicsRef: input.rezicsRef,
		sourcePolicy: {
			kind: "book",
			metadataLanguagesExactly: ["zh"],
			status: "published",
			visibility: "public",
			moderationStatus: "approved",
			deleted: false,
		},
		networkPolicy: "rezics-only-no-external-metadata",
		evidenceMode: "online-batched",
		applyState: "locked",
		decisionPolicyRevision: CurrentDecisionPolicyRevision,
		sourceStart,
		onlineBatchSize: input.onlineBatchSize ?? 64,
		maxCandidatesPerPacket: 20,
	});

	await mkdir(directory, { recursive: false });
	for (const child of ["packets", "decisions", "manifests", "reports", ".work"])
		await mkdir(join(directory, child));
	await writeJsonAtomic(join(directory, "run.json"), config);
	await appendRunEvent(config.runId, "run.initialized", {
		cutoff: config.cutoff,
		rezicsRef: config.rezicsRef,
		evidenceMode: config.evidenceMode,
		decisionPolicyRevision: config.decisionPolicyRevision,
		sourceStart: config.sourceStart,
		onlineBatchSize: config.onlineBatchSize,
		applyState: config.applyState,
	});
	return config;
}
