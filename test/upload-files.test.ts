import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { S3Client } from "../src/shared/s3.ts";
import { ArtifactStore } from "../src/shared/store.ts";
import { uploadFiles } from "../src/shared/upload-files.ts";
import { FakeS3 } from "./fake-s3.ts";
import { tempDir } from "./helpers.ts";

let dir: Awaited<ReturnType<typeof tempDir>>;
let s3: FakeS3;
let store: ArtifactStore;
const run = { repository: "o/r", runId: "1", runAttempt: 1 };
const options = { archive: true, compressionLevel: 6, retentionDays: 1, overwrite: false };

beforeEach(async () => {
	dir = await tempDir();
	s3 = new FakeS3();
	store = new ArtifactStore(
		new S3Client({
			bucket: s3.bucket,
			endpoint: s3.endpoint,
			region: "us-east-1",
			accessKeyId: s3.accessKeyId,
			secretAccessKey: "s",
			prefix: "",
			forcePathStyle: true,
			urlExpiresIn: 60,
		}),
		"",
	);
});
afterEach(async () => {
	await s3.stop();
	await dir.cleanup();
});

test("rejects a root directory that does not exist", async () => {
	const file = await dir.write("f.txt");
	await expect(
		uploadFiles(store, run, {
			...options,
			name: "a",
			files: [file],
			rootDirectory: join(dir.root, "missing"),
		}),
	).rejects.toThrow("is not a valid directory");
});

test("rejects files outside of the root directory", async () => {
	const file = await dir.write("outside/f.txt");
	await dir.write("root/keep.txt");
	await expect(
		uploadFiles(store, run, {
			...options,
			name: "a",
			files: [file],
			rootDirectory: join(dir.root, "root"),
		}),
	).rejects.toThrow("is not a parent directory of the file");
	expect(s3.keys()).toEqual([]);
});
