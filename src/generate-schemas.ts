import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { GeneratedSchemas } from "./contracts.ts";
import { repositoryRoot } from "./io.ts";

const outputDirectory = join(repositoryRoot, "schemas");
await mkdir(outputDirectory, { recursive: true });

for (const [name, schema] of Object.entries(GeneratedSchemas)) {
	const jsonSchema = z.toJSONSchema(schema, {
		target: "draft-2020-12",
		unrepresentable: "throw",
	});
	await writeFile(
		join(outputDirectory, `${name}.schema.json`),
		`${JSON.stringify(jsonSchema, null, 2)}\n`,
		"utf8",
	);
}
