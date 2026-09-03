import { z } from "zod";

const ExplainDocumentSchema = z.tuple([
	z.object({
		"Planning Time": z.number().nonnegative(),
		"Execution Time": z.number().nonnegative(),
		Plan: z.unknown(),
	}),
]);

const PlanNodeSchema = z.object({
	"Node Type": z.string(),
	"Relation Name": z.string().optional(),
	"Index Name": z.string().optional(),
	"Actual Rows": z.number().nonnegative(),
	"Actual Loops": z.number().nonnegative(),
	"Rows Removed by Filter": z.number().nonnegative().default(0),
	"Rows Removed by Index Recheck": z.number().nonnegative().default(0),
	"Shared Hit Blocks": z.number().nonnegative().default(0),
	"Shared Read Blocks": z.number().nonnegative().default(0),
	"Temp Read Blocks": z.number().nonnegative().default(0),
	"Temp Written Blocks": z.number().nonnegative().default(0),
	Plans: z.array(z.unknown()).optional(),
});

export type QueryStage = "source_page" | "candidate_search" | "book_evidence";

export function parseQueryProfile(stage: QueryStage, roundTripMs: number, value: unknown) {
	const [document] = ExplainDocumentSchema.parse(value);
	const root = PlanNodeSchema.parse(document.Plan);
	const pending: unknown[] = [root];
	const nodes: {
		nodeType: string;
		relationName: string | null;
		indexName: string | null;
		rows: number;
		loops: number;
		rowsRemoved: number;
	}[] = [];
	while (pending.length > 0) {
		if (nodes.length >= 256) throw new Error("Query profile exceeds the 256-node boundary");
		const node = PlanNodeSchema.parse(pending.pop());
		nodes.push({
			nodeType: node["Node Type"],
			relationName: node["Relation Name"] ?? null,
			indexName: node["Index Name"] ?? null,
			rows: node["Actual Rows"],
			loops: node["Actual Loops"],
			rowsRemoved: node["Rows Removed by Filter"] + node["Rows Removed by Index Recheck"],
		});
		pending.push(...(node.Plans ?? []));
	}
	return {
		stage,
		roundTripMs,
		planningMs: document["Planning Time"],
		explainExecutionMs: document["Execution Time"],
		sharedHitBlocks: root["Shared Hit Blocks"],
		sharedReadBlocks: root["Shared Read Blocks"],
		tempReadBlocks: root["Temp Read Blocks"],
		tempWrittenBlocks: root["Temp Written Blocks"],
		nodes,
	};
}

export type QueryProfile = ReturnType<typeof parseQueryProfile>;

export function assertCandidateLookupsBounded(
	profile: QueryProfile,
	maximumCandidateRows: number,
): void {
	if (profile.stage !== "candidate_search") return;
	for (const node of profile.nodes) {
		// EXPLAIN rounds removal averages per loop. Summing them with fractional output
		// averages can falsely flag a one-row ID lookup whose row is sometimes filtered.
		const observedRowsPerLoop =
			node.loops > 1 ? Math.max(node.rows, node.rowsRemoved) : node.rows + node.rowsRemoved;
		if (
			(node.relationName !== null || node.indexName !== null) &&
			node.nodeType.includes("Scan") &&
			observedRowsPerLoop * node.loops > maximumCandidateRows
		)
			throw new Error(
				`Candidate query scans more rows than the bounded candidate set: ${node.indexName ?? node.relationName ?? node.nodeType}`,
			);
	}
}
