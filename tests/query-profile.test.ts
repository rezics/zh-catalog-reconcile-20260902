import { expect, test } from "bun:test";

import { assertCandidateLookupsBounded, parseQueryProfile } from "../src/query-profile.ts";

test("query profile retains measured operations but omits stored evidence and query literals", () => {
	const profile = parseQueryProfile("source_page", 4, [
		{
			"Planning Time": 1,
			"Execution Time": 2,
			Plan: {
				"Node Type": "Limit",
				"Actual Rows": 64,
				"Actual Loops": 1,
				"Shared Hit Blocks": 200,
				"Shared Read Blocks": 3,
				Filter: "private-fixture-book-title",
				Plans: [
					{
						"Node Type": "Index Scan",
						"Index Name": "source_keyset_idx",
						"Actual Rows": 64,
						"Actual Loops": 1,
						"Index Cond": "private-fixture-unit-id",
					},
				],
			},
		},
	]);
	expect(profile).toMatchObject({
		stage: "source_page",
		roundTripMs: 4,
		explainExecutionMs: 2,
		sharedHitBlocks: 200,
		sharedReadBlocks: 3,
		tempWrittenBlocks: 0,
	});
	expect(profile.nodes).toHaveLength(2);
	expect(profile.nodes[1]?.indexName).toBe("source_keyset_idx");
	expect(JSON.stringify(profile)).not.toContain("private-fixture");
});

test("query profile fails closed for malformed database JSON", () => {
	expect(() => parseQueryProfile("source_page", 1, undefined)).toThrow();
	expect(() =>
		parseQueryProfile("source_page", 1, [{ "Planning Time": 1, "Execution Time": 1, Plan: {} }]),
	).toThrow();
});

test.each([
	{ "Node Type": "Index Only Scan", "Index Name": "book_pkey", "Actual Rows": 418846 },
	{
		"Node Type": "Index Scan",
		"Index Name": "unit_public_discoverable_idx",
		"Actual Rows": 418803,
	},
	{
		"Node Type": "Seq Scan",
		"Relation Name": "unit",
		"Actual Rows": 1,
		"Rows Removed by Filter": 418802,
	},
	{
		"Node Type": "Bitmap Heap Scan",
		"Relation Name": "book",
		"Actual Rows": 1,
		"Rows Removed by Index Recheck": 418845,
	},
])("candidate probe rejects broad scans even when most rows are discarded", (scan) => {
	const profile = parseQueryProfile("candidate_search", 1, [
		{ "Planning Time": 1, "Execution Time": 1, Plan: { "Actual Loops": 1, ...scan } },
	]);
	expect(() => assertCandidateLookupsBounded(profile, 64 * 20)).toThrow("bounded candidate set");
});

test("candidate probe accepts bounded per-ID lookups and does not impose its bound on source traversal", () => {
	const explain = [
		{
			"Planning Time": 1,
			"Execution Time": 1,
			Plan: {
				"Node Type": "Index Scan",
				"Index Name": "unit_pkey",
				"Actual Rows": 1,
				"Actual Loops": 1280,
			},
		},
	];
	const candidate = parseQueryProfile("candidate_search", 1, explain);
	expect(() => assertCandidateLookupsBounded(candidate, 1280)).not.toThrow();
	expect(() => assertCandidateLookupsBounded(candidate, 1279)).toThrow();
	expect(() =>
		assertCandidateLookupsBounded(parseQueryProfile("source_page", 1, explain), 64),
	).not.toThrow();
});

test("candidate probe tolerates rounded per-loop filter averages for bounded ID lookups", () => {
	const profile = parseQueryProfile("candidate_search", 1, [
		{
			"Planning Time": 1,
			"Execution Time": 1,
			Plan: {
				"Node Type": "Index Scan",
				"Relation Name": "unit",
				"Actual Rows": 0.3,
				"Rows Removed by Filter": 1,
				"Actual Loops": 1280,
			},
		},
	]);
	expect(() => assertCandidateLookupsBounded(profile, 1280)).not.toThrow();
});
