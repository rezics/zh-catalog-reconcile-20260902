import { captureInventory, databaseDoctor } from "./database.ts";
import { auditDecisionQuality } from "./decision-quality.ts";
import { nextPackets, recordDecisions, runStatus } from "./decisions.ts";
import { loadRunConfig } from "./io.ts";
import { runConcurrentReconciliation } from "./orchestrator.ts";
import { generateManifest } from "./planner.ts";
import { initializeRun } from "./run.ts";

const usage = `
Usage: bun run reconcile <command> [options]

Commands:
  doctor
  init       --run ID --rezics-ref REF --cutoff ISO [--after-run ID]
  inventory  --run ID
  next       --run ID [--limit N]  (fetches the next online batch when needed)
  record     --run ID --file PATH
  work       --run ID [--concurrency N] [--packets-per-worker N] [--progress-every N]
  status     --run ID
  audit      --run ID
  plan       --run ID

There is intentionally no apply command.
`.trim();

function options(args: readonly string[]): Map<string, string> {
	const parsed = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key?.startsWith("--") || value === undefined || value.startsWith("--"))
			throw new Error(`Expected --name value pairs; received ${key ?? "<end>"}`);
		if (parsed.has(key)) throw new Error(`Duplicate option: ${key}`);
		parsed.set(key, value);
	}
	return parsed;
}

function required(values: ReadonlyMap<string, string>, name: string): string {
	const value = values.get(name)?.trim();
	if (!value) throw new Error(`Missing required option ${name}`);
	return value;
}

function integerOption(
	values: ReadonlyMap<string, string>,
	name: string,
	defaultValue?: number,
): number | undefined {
	const raw = values.get(name);
	if (raw === undefined) return defaultValue;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new Error(`${name} must be a positive integer`);
	return value;
}

function print(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (!command || command === "help" || command === "--help") {
		process.stdout.write(`${usage}\n`);
		return;
	}
	const values = options(args);
	if (command === "doctor") {
		if (values.size > 0) throw new Error("doctor does not accept options");
		print(await databaseDoctor());
		return;
	}
	const runId = required(values, "--run");

	switch (command) {
		case "init": {
			const afterRunId = values.get("--after-run");
			const result = await initializeRun({
				runId,
				rezicsRef: required(values, "--rezics-ref"),
				cutoff: required(values, "--cutoff"),
				...(afterRunId === undefined ? {} : { afterRunId }),
			});
			print(result);
			return;
		}
		case "inventory": {
			print(await captureInventory(await loadRunConfig(runId)));
			return;
		}
		case "next": {
			print(
				await nextPackets(await loadRunConfig(runId), integerOption(values, "--limit", 10) ?? 10),
			);
			return;
		}
		case "record": {
			print(await recordDecisions(await loadRunConfig(runId), required(values, "--file")));
			return;
		}
		case "work": {
			const allowed = new Set([
				"--run",
				"--concurrency",
				"--packets-per-worker",
				"--progress-every",
			]);
			for (const key of values.keys())
				if (!allowed.has(key))
					throw new Error(`work does not accept ${key}; total work is not count-limited`);
			const controller = new AbortController();
			const interrupt = () => controller.abort(new Error("Interrupted by user"));
			process.once("SIGINT", interrupt);
			process.once("SIGTERM", interrupt);
			try {
				print(
					await runConcurrentReconciliation(await loadRunConfig(runId), {
						concurrency: integerOption(values, "--concurrency", 8) ?? 8,
						packetsPerWorker: integerOption(values, "--packets-per-worker", 2) ?? 2,
						progressEvery: integerOption(values, "--progress-every", 1_000) ?? 1_000,
						signal: controller.signal,
						onProgress: (progress) => print({ progress }),
					}),
				);
			} finally {
				process.off("SIGINT", interrupt);
				process.off("SIGTERM", interrupt);
			}
			return;
		}
		case "status": {
			const config = await loadRunConfig(runId);
			print({ run: config, progress: await runStatus(config) });
			return;
		}
		case "audit": {
			const report = await auditDecisionQuality(await loadRunConfig(runId), { persist: true });
			print(report);
			if (report.status !== "passed") process.exitCode = 2;
			return;
		}
		case "plan": {
			print(await generateManifest(await loadRunConfig(runId)));
			return;
		}
		default:
			throw new Error(`Unknown command: ${command}\n\n${usage}`);
	}
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${JSON.stringify({ level: "error", message })}\n`);
	process.exitCode = 1;
});
