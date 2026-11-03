/**
 * Starts the fake S3 server in the background for end-to-end workflow runs and exports its settings
 * to GITHUB_ENV. Readiness is signalled over IPC once the server listens, so no polling is needed.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const child = spawn(process.execPath, [join(import.meta.dir, "fake-s3-server.ts")], {
	detached: true,
	stdio: ["ignore", "ignore", "inherit", "ipc"],
});

const settings = await new Promise<{ endpoint: string; bucket: string; accessKeyId: string }>(
	(resolve, reject) => {
		child.once("message", (message) => resolve(message as never));
		child.once("exit", (code) => reject(new Error(`fake S3 exited early with code ${code}`)));
	},
);

const env = [
	`ARTIFACT_S3_ENDPOINT=${settings.endpoint}`,
	`ARTIFACT_S3_BUCKET=${settings.bucket}`,
	`AWS_ACCESS_KEY_ID=${settings.accessKeyId}`,
	"AWS_SECRET_ACCESS_KEY=fake-secret",
	`FAKE_S3_PID=${child.pid}`,
].join("\n");
if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${env}\n`);
console.log(env);

child.disconnect();
child.unref();
