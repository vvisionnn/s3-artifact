import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Minimatch } from "minimatch";
import * as core from "../shared/core.ts";
import { fetchArtifact, mapLimit } from "../shared/fetch-artifact.ts";
import {
	createStore,
	currentRun,
	getBoolean,
	getCompressionLevel,
	getInput,
	getRetentionDays,
} from "../shared/inputs.ts";
import { findFilesToUpload } from "../shared/search.ts";
import { uploadFiles } from "../shared/upload-files.ts";

const PARALLEL_DOWNLOADS = 5;

export async function runMerge(): Promise<void> {
	const name = getInput("name") || "merged-artifacts";
	const pattern = getInput("pattern") || "*";
	const separateDirectories = getBoolean("separate-directories", false);
	const deleteMerged = getBoolean("delete-merged", false);
	const includeHiddenFiles = getBoolean("include-hidden-files", false);
	const retentionDays = getRetentionDays();
	const compressionLevel = getCompressionLevel();

	const run = currentRun();
	const store = createStore();
	const matcher = new Minimatch(pattern);
	const artifacts = (await store.list(run)).filter((a) => matcher.match(a.name));
	if (artifacts.length === 0) {
		throw new Error(`No artifacts found matching pattern '${pattern}'`);
	}
	core.info("Preparing to download the following artifacts:");
	for (const a of artifacts) core.info(`- ${a.name} (ID: ${a.id}, Size: ${a.size})`);

	const tempRoot = process.env.RUNNER_TEMP || tmpdir();
	await mkdir(tempRoot, { recursive: true });
	const workDir = await mkdtemp(join(tempRoot, "merge-artifact-"));
	try {
		const results = await mapLimit(artifacts, PARALLEL_DOWNLOADS, (artifact) =>
			fetchArtifact(store, artifact, separateDirectories ? join(workDir, artifact.name) : workDir, {
				skipDecompress: false,
				keepOnMismatch: false,
			}),
		);
		const mismatched = artifacts.filter((_, i) => results[i]?.digestMismatch).map((a) => a.name);
		if (mismatched.length) {
			throw new Error(`Digest validation failed for artifact(s): ${mismatched.join(", ")}`);
		}

		const { filesToUpload, rootDirectory } = await findFilesToUpload(workDir, includeHiddenFiles);
		await uploadFiles(store, run, {
			name,
			files: filesToUpload,
			rootDirectory,
			archive: true,
			compressionLevel,
			retentionDays,
			overwrite: false,
		});
		core.info(`The ${artifacts.length} artifact(s) have been successfully merged!`);

		if (deleteMerged) {
			for (const artifact of artifacts.filter((a) => a.name !== name)) {
				await store.delete(artifact);
			}
			core.info(`The ${artifacts.length} artifact(s) have been deleted`);
		}
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}
