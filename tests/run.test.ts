import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import {
	CurrentLunaWorkerProtocol,
	HistoricalLunaWorkerProtocolV2,
	HistoricalLunaWorkerProtocolV3,
	WorkerProtocolSchema,
} from "../src/contracts.ts";
import { loadRunConfig, pathExists, repositoryRoot, runDirectory } from "../src/io.ts";
import { initializeRun } from "../src/run.ts";

test.each([undefined, 1, 20, 64, 100])(
	"initialization persists database page size %s",
	async (size) => {
		const runId = `run-batch-${randomUUID()}`;
		try {
			const config = await initializeRun({
				runId,
				rezicsRef: "v1.7.0",
				cutoff: "2026-09-02T16:00:00.000Z",
				...(size === undefined ? {} : { onlineBatchSize: size }),
			});
			expect(config.onlineBatchSize).toBe(size ?? 64);
			expect(config.workerProtocol).toBeNull();
			expect((await loadRunConfig(runId)).onlineBatchSize).toBe(size ?? 64);
		} finally {
			await rm(runDirectory(runId), { recursive: true, force: true });
		}
	},
);

test.each([0, -1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY])(
	"initialization rejects invalid page size %s before creating a run",
	async (size) => {
		const runId = `invalid-batch-${randomUUID()}`;
		await expect(
			initializeRun({
				runId,
				rezicsRef: "v1.7.0",
				cutoff: "2026-09-02T16:00:00.000Z",
				onlineBatchSize: size,
			}),
		).rejects.toThrow();
		expect(await pathExists(runDirectory(runId))).toBeFalse();
	},
);

test.each([
	{ args: ["--online-batch-size", "17"], valid: true },
	{ args: ["--online-batch-size", "101"], valid: false },
	{ args: ["--online-batch-size", "1.5"], valid: false },
	{ args: ["--online-batch-szie", "64"], valid: false },
])("init CLI validates and persists the database batch option", async ({ args, valid }) => {
	const runId = `cli-batch-${randomUUID()}`;
	try {
		const child = Bun.spawn(
			[
				process.execPath,
				"run",
				"src/cli.ts",
				"init",
				"--run",
				runId,
				"--rezics-ref",
				"v1.7.0",
				"--cutoff",
				"2026-09-02T16:00:00.000Z",
				...args,
			],
			{ cwd: repositoryRoot, stdout: "ignore", stderr: "ignore" },
		);
		expect(await child.exited).toBe(valid ? 0 : 1);
		if (valid) expect((await loadRunConfig(runId)).onlineBatchSize).toBe(17);
		else expect(await pathExists(runDirectory(runId))).toBeFalse();
	} finally {
		await rm(runDirectory(runId), { recursive: true, force: true });
	}
});

test("init CLI pins the requested full-run worker protocol", async () => {
	const runId = `cli-worker-${randomUUID()}`;
	try {
		const child = Bun.spawn(
			[
				process.execPath,
				"run",
				"src/cli.ts",
				"init",
				"--run",
				runId,
				"--rezics-ref",
				"v1.7.0",
				"--cutoff",
				"2026-09-02T16:00:00.000Z",
				"--worker-protocol",
				"full-online-luna-v4",
			],
			{ cwd: repositoryRoot, stdout: "ignore", stderr: "ignore" },
		);
		expect(await child.exited).toBe(0);
		expect((await loadRunConfig(runId)).workerProtocol).toEqual(CurrentLunaWorkerProtocol);
	} finally {
		await rm(runDirectory(runId), { recursive: true, force: true });
	}
});

test("historical v2 worker protocol remains readable", () => {
	expect(WorkerProtocolSchema.parse(HistoricalLunaWorkerProtocolV2)).toEqual(
		HistoricalLunaWorkerProtocolV2,
	);
});

test("historical v3 worker protocol remains readable", () => {
	expect(WorkerProtocolSchema.parse(HistoricalLunaWorkerProtocolV3)).toEqual(
		HistoricalLunaWorkerProtocolV3,
	);
});

test.each(["full-online-luna-v1", "full-online-luna-v2", "full-online-luna-v3"])(
	"init CLI rejects obsolete worker protocol %s before creating a run",
	async (workerProtocol) => {
		const runId = `cli-worker-obsolete-${randomUUID()}`;
		try {
			const child = Bun.spawn(
				[
					process.execPath,
					"run",
					"src/cli.ts",
					"init",
					"--run",
					runId,
					"--rezics-ref",
					"v1.7.0",
					"--cutoff",
					"2026-09-02T16:00:00.000Z",
					"--worker-protocol",
					workerProtocol,
				],
				{ cwd: repositoryRoot, stdout: "ignore", stderr: "ignore" },
			);
			expect(await child.exited).toBe(1);
			expect(await pathExists(runDirectory(runId))).toBeFalse();
		} finally {
			await rm(runDirectory(runId), { recursive: true, force: true });
		}
	},
);
