import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";

import { buildSshArguments, SshStdioBridge } from "../src/ssh-stdio-bridge.ts";

const bridgeConfig = {
	sshHost: "server.example.test",
	sshUser: "operator",
	identityFile: "fixtures/operator-ed25519",
	bindAddress: "192.0.2.10",
	targetHost: "db.internal.example",
	targetPort: 5432,
} as const;

test("SSH arguments use an exec channel and never request port forwarding", () => {
	const arguments_ = buildSshArguments(bridgeConfig);
	expect(arguments_).toContain("ClearAllForwardings=yes");
	expect(arguments_).not.toContain("-L");
	expect(arguments_.slice(-3)).toEqual(["nc", "db.internal.example", "5432"]);
});

test("local bridge forwards binary data through a child stdio channel", async () => {
	const bridge = new SshStdioBridge(bridgeConfig, () =>
		spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		}),
	);
	try {
		const endpoint = await bridge.start();
		const socket = createConnection(endpoint);
		await once(socket, "connect");
		const received = once(socket, "data");
		socket.write(Buffer.from([0, 1, 2, 3, 255]));
		const [data] = await received;
		expect(Buffer.from(data as Buffer)).toEqual(Buffer.from([0, 1, 2, 3, 255]));
		socket.end();
	} finally {
		await bridge.close();
	}
});
