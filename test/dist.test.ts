import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildAll } from "../scripts/build.ts";
import { FakeS3 } from "./fake-s3.ts";
import { inputs, parseOutputs, tempDir } from "./helpers.ts";

/** Runs the bundled actions with Node, the way the GitHub runner does. */
let dir: Awaited<ReturnType<typeof tempDir>>;
let s3: FakeS3;
let bundles: string;

beforeAll(async () => {
	dir = await tempDir();
	s3 = new FakeS3();
	bundles = join(dir.root, "dist");
	await buildAll(bundles);
});
afterAll(async () => {
	await s3.stop();
	await dir.cleanup();
});

async function runBundle(action: string, values: Record<string, string>) {
	const outputFile = join(dir.root, `${action}-output`);
	await writeFile(outputFile, "");
	const child = Bun.spawn(["node", join(bundles, action, "index.js")], {
		env: {
			PATH: process.env.PATH ?? "",
			SYSTEMROOT: process.env.SYSTEMROOT ?? "",
			GITHUB_OUTPUT: outputFile,
			GITHUB_REPOSITORY: "octo/repo",
			GITHUB_RUN_ID: "1",
			RUNNER_TEMP: join(dir.root, "tmp"),
			ARTIFACT_S3_BUCKET: s3.bucket,
			ARTIFACT_S3_ENDPOINT: s3.endpoint,
			AWS_ACCESS_KEY_ID: s3.accessKeyId,
			AWS_SECRET_ACCESS_KEY: "secret",
			...inputs(values),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr, outputs: parseOutputs(await readFile(outputFile, "utf8")) };
}

describe("bundled actions under Node", () => {
	test("upload, merge and download round trip", async () => {
		await dir.write("src/a/1.txt", "one");
		await dir.write("src/b/2.txt", "two");
		for (const name of ["a", "b"]) {
			const upload = await runBundle("upload", { name, path: join(dir.root, "src", name) });
			expect(upload.stderr).toBe("");
			expect(upload.exitCode).toBe(0);
			expect(upload.outputs["artifact-id"]).toMatch(/^\d+$/);
		}

		const merge = await runBundle("merge", { name: "all", pattern: "*" });
		expect(merge.exitCode).toBe(0);

		const target = join(dir.root, "out");
		const download = await runBundle("download", { name: "all", path: target });
		expect(download.exitCode).toBe(0);
		expect(download.outputs["download-path"]).toBe(target);
		expect(await readFile(join(target, "1.txt"), "utf8")).toBe("one");
		expect(await readFile(join(target, "2.txt"), "utf8")).toBe("two");
	});

	test("failures set a non-zero exit code with an error annotation", async () => {
		const download = await runBundle("download", { name: "missing" });
		expect(download.exitCode).toBe(1);
		expect(download.stdout).toContain(
			"::error::Unable to download artifact(s): Artifact 'missing' not found",
		);
	});
});
