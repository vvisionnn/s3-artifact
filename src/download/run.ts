import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Minimatch } from "minimatch";
import * as core from "../shared/core.ts";
import { fetchArtifact, mapLimit } from "../shared/fetch-artifact.ts";
import { createStore, currentRun, getBoolean, getInput } from "../shared/inputs.ts";
import type { ArtifactManifest } from "../shared/store.ts";
import { validateArtifactName } from "../shared/validation.ts";

const PARALLEL_DOWNLOADS = 5;
const DIGEST_BEHAVIORS = ["ignore", "info", "warn", "error"] as const;
type DigestBehavior = (typeof DIGEST_BEHAVIORS)[number];

export async function runDownload(): Promise<void> {
	const name = getInput("name");
	const artifactIdsInput = getInput("artifact-ids");
	const pattern = getInput("pattern");
	const mergeMultiple = getBoolean("merge-multiple", false);
	const skipDecompress = getBoolean("skip-decompress", false);
	const digestMismatch = (getInput("digest-mismatch") || "error") as DigestBehavior;
	if (!DIGEST_BEHAVIORS.includes(digestMismatch)) {
		throw new Error(
			`Invalid value for 'digest-mismatch': '${digestMismatch}'. Valid options are: ${DIGEST_BEHAVIORS.join(", ")}`,
		);
	}
	if (name && artifactIdsInput) {
		throw new Error(
			"Inputs 'name' and 'artifact-ids' cannot be used together. Please specify only one.",
		);
	}

	let path = getInput("path") || process.env.GITHUB_WORKSPACE || process.cwd();
	if (path.startsWith("~")) path = path.replace("~", homedir());
	const resolvedPath = resolve(path);

	const current = currentRun();
	const repository = getInput("repository") || current.repository;
	const runId = getInput("run-id") || current.runId;
	const segments = repository.split("/");
	if (
		segments.length !== 2 ||
		!segments.every((s) => /^[\w.-]+$/.test(s) && s !== "." && s !== "..")
	) {
		throw new Error(`Invalid repository: '${repository}'. Must be in format owner/repo`);
	}
	if (!/^\d+$/.test(runId)) {
		throw new Error(`Invalid run-id: '${runId}'. Must be a number.`);
	}
	if (getInput("github-token")) {
		core.info(
			"github-token is not needed: artifacts are read from S3 using the configured credentials.",
		);
	}
	const run = { repository, runId };
	const store = createStore();

	let artifacts: ArtifactManifest[];
	if (name) {
		core.info("Downloading single artifact");
		const artifact = await store.get(run, name);
		if (!artifact) throw new Error(`Artifact '${name}' not found`);
		artifacts = [artifact];
	} else if (artifactIdsInput) {
		core.info("Downloading artifacts by ID");
		const ids = parseIds(artifactIdsInput);
		artifacts = (await store.list(run)).filter((a) => ids.includes(a.id));
		if (artifacts.length === 0) throw new Error("None of the provided artifact IDs were found");
		const missing = ids.filter((id) => !artifacts.some((a) => a.id === id));
		if (missing.length)
			core.warning(`Could not find the following artifact IDs: ${missing.join(", ")}`);
	} else {
		artifacts = await store.list(run);
		if (pattern) {
			core.info(`Filtering artifacts by pattern '${pattern}'`);
			const matcher = new Minimatch(pattern);
			artifacts = artifacts.filter((a) => matcher.match(a.name));
		} else {
			core.info(
				"No input name, artifact-ids or pattern filtered specified, downloading all artifacts",
			);
		}
	}

	// Names become directory names below, so re-check manifests that may come from other tools.
	for (const artifact of artifacts) validateArtifactName(artifact.name);

	if (artifacts.length) {
		core.info("Preparing to download the following artifacts:");
		for (const a of artifacts) {
			core.info(`- ${a.name} (ID: ${a.id}, Size: ${a.size}, Expected Digest: ${a.digest})`);
		}
	}

	const flat = Boolean(name) || mergeMultiple || artifacts.length === 1;
	const results = await mapLimit(artifacts, PARALLEL_DOWNLOADS, (artifact) =>
		fetchArtifact(store, artifact, flat ? resolvedPath : join(resolvedPath, artifact.name), {
			skipDecompress,
			keepOnMismatch: digestMismatch !== "error",
		}),
	);

	const mismatched = artifacts.filter((_, i) => results[i]?.digestMismatch).map((a) => a.name);
	for (const artifactName of mismatched) {
		const message = `Artifact '${artifactName}' digest validation failed. Please verify the integrity of the artifact.`;
		if (digestMismatch === "info") core.info(message);
		if (digestMismatch === "warn") core.warning(message);
	}
	if (mismatched.length && digestMismatch === "error") {
		throw new Error(
			`Digest validation failed for artifact(s): ${mismatched.join(", ")}. Use 'digest-mismatch: warn' to continue on mismatch.`,
		);
	}

	core.info(`Total of ${artifacts.length} artifact(s) downloaded`);
	core.setOutput("download-path", resolvedPath);
	core.info("Download artifact has finished successfully");
}

function parseIds(input: string): number[] {
	const ids = input
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id !== "");
	if (ids.length === 0) throw new Error("No valid artifact IDs provided in 'artifact-ids' input");
	return ids.map((id) => {
		if (!/^\d+$/.test(id)) throw new Error(`Invalid artifact ID: '${id}'. Must be a number.`);
		return Number(id);
	});
}
