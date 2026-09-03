import { captureInventory, databaseDoctor } from "./database.ts";
import { nextPackets, recordDecisions, runStatus } from "./decisions.ts";
import { loadRunConfig } from "./io.ts";
import { generateManifest } from "./planner.ts";
import { initializeRun } from "./run.ts";

const usage = `
Usage: bun run reconcile <command> [options]

Commands:
  doctor
  init       --run ID --rezics-ref REF --cutoff ISO
  inventory  --run ID
  next       --run ID [--limit N]  (fetches the next online batch when needed)
  record     --run ID --file PATH
  status     --run ID
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
			const result = await initializeRun({
				runId,
				rezicsRef: required(values, "--rezics-ref"),
				cutoff: required(values, "--cutoff"),
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
		case "status": {
			const config = await loadRunConfig(runId);
			print({ run: config, progress: await runStatus(config) });
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
