import { CurrentDecisionPolicyRevision, type RunConfig, RunConfigSchema } from "./contracts.ts";
import { withOnlineCatalog } from "./database.ts";
import { readPacketCheckpoint } from "./packets.ts";
import { assertCandidateLookupsBounded, type QueryProfile } from "./query-profile.ts";

export async function probeOnlinePage(config: RunConfig, batchSize = config.onlineBatchSize) {
	RunConfigSchema.shape.onlineBatchSize.parse(batchSize);
	if (config.decisionPolicyRevision !== CurrentDecisionPolicyRevision)
		throw new Error("Only the current decision policy can probe online evidence");
	const checkpoint = await readPacketCheckpoint(config);
	const profiles: QueryProfile[] = [];
	const startedAt = performance.now();
	const groups = await withOnlineCatalog(
		config,
		(reader) =>
			reader.readEvidencePage({
				afterCreatedAt:
					checkpoint.lastSourceCreatedAt ?? config.sourceStart?.afterCreatedAt ?? null,
				afterUnitId: checkpoint.lastSourceUnitId ?? config.sourceStart?.afterUnitId ?? null,
				limit: batchSize,
				maxCandidates: config.maxCandidatesPerPacket,
			}),
		{ onQueryProfile: (profile) => profiles.push(profile) },
	);
	const evidenceIds = new Set<string>();
	for (const group of groups) {
		evidenceIds.add(group.source.id);
		for (const candidate of group.candidates) evidenceIds.add(candidate.id);
	}
	for (const profile of profiles)
		assertCandidateLookupsBounded(profile, batchSize * config.maxCandidatesPerPacket);
	return {
		runId: config.runId,
		batchSize,
		sourceCount: groups.length,
		evidenceBookCount: evidenceIds.size,
		elapsedMs: performance.now() - startedAt,
		checkpointAdvanced: false,
		profiles,
	};
}
