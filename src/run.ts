import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { type RunConfig, RunConfigSchema, SchemaVersion } from "./contracts.ts";
import { appendRunEvent, nowIso, pathExists, runDirectory, writeJsonAtomic } from "./io.ts";

export type InitializeRunInput = {
	readonly runId: string;
	readonly rezicsRef: string;
	readonly cutoff: string;
};

export async function initializeRun(input: InitializeRunInput): Promise<RunConfig> {
	const directory = runDirectory(input.runId);
	if (await pathExists(directory)) throw new Error(`Run already exists: ${input.runId}`);
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
		decisionPolicyRevision: "evidence-grounded-v2",
		onlineBatchSize: 20,
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
		onlineBatchSize: config.onlineBatchSize,
		applyState: config.applyState,
	});
	return config;
}
