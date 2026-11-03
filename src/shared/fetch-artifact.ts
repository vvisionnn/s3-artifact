import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "./core.ts";
import type { ArtifactManifest, ArtifactStore } from "./store.ts";
import { extractZip } from "./zip.ts";

export interface FetchOptions {
	skipDecompress: boolean;
	/** When false, a digest mismatch leaves the destination untouched. */
	keepOnMismatch: boolean;
}

/** Downloads one artifact into `destination`, extracting zips. Reports whether the digest matched. */
export async function fetchArtifact(
	store: ArtifactStore,
	manifest: ArtifactManifest,
	destination: string,
	options: FetchOptions,
): Promise<{ digestMismatch: boolean }> {
	const scratch = join(process.env.RUNNER_TEMP || tmpdir(), `s3-artifact-${randomUUID()}`);
	const temp = join(scratch, manifest.fileName);
	try {
		const digest = await store.download(manifest, temp);
		core.info(`SHA256 digest of downloaded artifact is ${digest.replace(/^sha256:/, "")}`);
		const digestMismatch = digest !== manifest.digest;
		if (digestMismatch) {
			core.debug(`Computed digest: ${digest}, expected digest: ${manifest.digest}`);
			if (!options.keepOnMismatch) return { digestMismatch };
		}
		await mkdir(destination, { recursive: true });
		if (manifest.archive && !options.skipDecompress) {
			await extractZip(temp, destination);
		} else {
			await copyFile(temp, join(destination, manifest.fileName));
		}
		return { digestMismatch };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving result order. */
export async function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
