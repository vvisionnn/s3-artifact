import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeS3 } from "./fake-s3.ts";
import { parseOutputs, tempDir, withEnv } from "./helpers.ts";

/** A fake runner: temp workspace, GITHUB_* variables, outputs file and a fake S3 bucket. */
export async function actionEnv(extra: Record<string, string | undefined> = {}) {
	const dir = await tempDir();
	const s3 = new FakeS3({ maxKeys: 5 });
	const outputFile = join(dir.root, "github-output");
	await writeFile(outputFile, "");
	const restore = withEnv({
		GITHUB_OUTPUT: outputFile,
		GITHUB_WORKSPACE: join(dir.root, "workspace"),
		RUNNER_TEMP: join(dir.root, "runner-temp"),
		GITHUB_REPOSITORY: "octo/repo",
		GITHUB_RUN_ID: "42",
		GITHUB_RUN_ATTEMPT: "1",
		GITHUB_RETENTION_DAYS: undefined,
		ARTIFACT_S3_BUCKET: s3.bucket,
		ARTIFACT_S3_ENDPOINT: s3.endpoint,
		AWS_ACCESS_KEY_ID: s3.accessKeyId,
		AWS_SECRET_ACCESS_KEY: "secret",
		...extra,
	});
	return {
		dir,
		s3,
		workspace: join(dir.root, "workspace"),
		async outputs() {
			const text = await readFile(outputFile, "utf8");
			await writeFile(outputFile, "");
			return parseOutputs(text);
		},
		async cleanup() {
			restore();
			await s3.stop();
			await dir.cleanup();
		},
	};
}
