import { createHash, randomInt } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as core from "./core.ts";
import { type CompletedPart, type S3Client, S3Error } from "./s3.ts";

/** Identifies the workflow run that owns a set of artifacts. */
export interface RunRef {
	/** `owner/repo` */
	repository: string;
	runId: string;
	runAttempt: number;
}

export interface ArtifactManifest {
	version: 1;
	id: number;
	name: string;
	fileName: string;
	archive: boolean;
	size: number;
	/** `sha256:<hex>`, the same format GitHub uses for artifact digests. */
	digest: string;
	contentType: string;
	createdAt: string;
	expiresAt: string | null;
	repository: string;
	runId: string;
	runAttempt: number;
}

export interface UploadRequest {
	name: string;
	fileName: string;
	archive: boolean;
	body: Readable;
	/** Days until expiry; 0 means never. */
	retentionDays: number;
	overwrite: boolean;
}

export interface StoreOptions {
	/** Multipart part size in bytes; also the threshold for using multipart at all. */
	partSize?: number;
	/** Parts uploaded in parallel. */
	concurrency?: number;
	now?: () => Date;
	generateId?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export class ArtifactConflictError extends Error {
	constructor(name: string) {
		super(
			`An artifact with the name '${name}' already exists for this workflow run. Use a different name or set 'overwrite: true' to replace it.`,
		);
		this.name = "ArtifactConflictError";
	}
}

const MANIFEST = "manifest.json";
const DOWNLOAD_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Artifact persistence on S3. Layout: `<prefix><owner>/<repo>/<run-id>/<name>/` holding the data
 * object and a `manifest.json` written last, so a manifest only exists for complete uploads.
 */
export class ArtifactStore {
	private readonly partSize: number;
	private readonly concurrency: number;
	private readonly now: () => Date;
	private readonly generateId: () => number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(
		private readonly client: S3Client,
		private readonly prefix: string,
		options: StoreOptions = {},
	) {
		this.partSize = options.partSize ?? 16 * 1024 * 1024;
		this.concurrency = options.concurrency ?? 4;
		this.now = options.now ?? (() => new Date());
		// Millisecond timestamp plus entropy: unique per artifact and a safe integer like GitHub IDs.
		this.generateId = options.generateId ?? (() => Date.now() * 1000 + randomInt(1000));
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	async upload(run: RunRef, request: UploadRequest): Promise<ArtifactManifest> {
		const existing = await this.get(run, request.name);
		if (existing && !request.overwrite && existing.runAttempt === run.runAttempt) {
			throw new ArtifactConflictError(request.name);
		}

		const base = this.artifactPrefix(run, request.name);
		const contentType = request.archive ? "application/zip" : "application/octet-stream";
		const { size, digest } = await this.putStream(`${base}${request.fileName}`, request.body, {
			"content-type": contentType,
			"content-disposition": contentDisposition(request.fileName),
		});

		const createdAt = this.now();
		const manifest: ArtifactManifest = {
			version: 1,
			id: this.generateId(),
			name: request.name,
			fileName: request.fileName,
			archive: request.archive,
			size,
			digest,
			contentType,
			createdAt: createdAt.toISOString(),
			expiresAt: request.retentionDays
				? new Date(createdAt.getTime() + request.retentionDays * DAY_MS).toISOString()
				: null,
			repository: run.repository,
			runId: run.runId,
			runAttempt: run.runAttempt,
		};
		await this.client.putObject(`${base}${MANIFEST}`, JSON.stringify(manifest, null, 2), {
			"content-type": "application/json",
		});

		const keep = new Set([`${base}${request.fileName}`, `${base}${MANIFEST}`]);
		for (const key of await this.client.listKeys(base)) {
			if (!keep.has(key)) await this.client.deleteObject(key);
		}
		return manifest;
	}

	/** Live (non-expired) artifacts of a run, sorted by name. */
	async list(run: Pick<RunRef, "repository" | "runId">): Promise<ArtifactManifest[]> {
		const keys = (await this.client.listKeys(this.runPrefix(run))).filter((key) =>
			key.endsWith(`/${MANIFEST}`),
		);
		const manifests = await Promise.all(keys.map((key) => this.readManifest(key)));
		return manifests
			.filter((m): m is ArtifactManifest => m !== undefined && this.isLive(m))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	async get(
		run: Pick<RunRef, "repository" | "runId">,
		name: string,
	): Promise<ArtifactManifest | undefined> {
		const manifest = await this.readManifest(`${this.artifactPrefix(run, name)}${MANIFEST}`);
		return manifest && this.isLive(manifest) ? manifest : undefined;
	}

	/** Downloads the artifact data to `target` and returns the computed `sha256:` digest. */
	async download(manifest: ArtifactManifest, target: string): Promise<string> {
		await mkdir(dirname(target), { recursive: true });
		const key = `${this.artifactPrefix(manifest, manifest.name)}${manifest.fileName}`;
		for (let attempt = 1; ; attempt++) {
			try {
				const response = await this.client.getObject(key);
				const hash = createHash("sha256");
				const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
				source.on("data", (chunk: Buffer) => hash.update(chunk));
				await pipeline(source, createWriteStream(target));
				return `sha256:${hash.digest("hex")}`;
			} catch (error) {
				const retryable =
					!(error instanceof S3Error) || error.status === 429 || error.status >= 500;
				if (!retryable || attempt >= DOWNLOAD_ATTEMPTS) throw error;
				core.info(`Download of ${manifest.name} failed (${(error as Error).message}), retrying`);
				await this.sleep(1000 * attempt);
			}
		}
	}

	async delete(manifest: ArtifactManifest): Promise<void> {
		const base = this.artifactPrefix(manifest, manifest.name);
		// Manifest first, so a half-deleted artifact is invisible rather than broken.
		await this.client.deleteObject(`${base}${MANIFEST}`);
		for (const key of await this.client.listKeys(base)) {
			await this.client.deleteObject(key);
		}
	}

	presign(manifest: ArtifactManifest): Promise<string> {
		return this.client.presignGet(
			`${this.artifactPrefix(manifest, manifest.name)}${manifest.fileName}`,
		);
	}

	private runPrefix(run: Pick<RunRef, "repository" | "runId">): string {
		return `${this.prefix}${run.repository}/${run.runId}/`;
	}

	private artifactPrefix(run: Pick<RunRef, "repository" | "runId">, name: string): string {
		return `${this.runPrefix(run)}${name}/`;
	}

	private isLive(manifest: ArtifactManifest): boolean {
		return manifest.expiresAt === null || Date.parse(manifest.expiresAt) > this.now().getTime();
	}

	private async readManifest(key: string): Promise<ArtifactManifest | undefined> {
		const text = await this.client.getText(key);
		if (text === undefined) return undefined;
		try {
			const parsed = JSON.parse(text) as ArtifactManifest;
			if (parsed.version === 1) return parsed;
		} catch {
			// fall through to the warning below
		}
		core.warning(`Ignoring unreadable artifact manifest ${key}`);
		return undefined;
	}

	/** Uploads a stream, switching to multipart once it exceeds one part. Hashes as it goes. */
	private async putStream(
		key: string,
		body: Readable,
		headers: Record<string, string>,
	): Promise<{ size: number; digest: string }> {
		const hash = createHash("sha256");
		let size = 0;
		let buffer = new Uint8Array(this.partSize);
		let filled = 0;
		let uploadId: string | undefined;
		const parts: CompletedPart[] = [];
		let nextPartNumber = 1;
		const inFlight = new Set<Promise<void>>();

		const sendPart = async (data: Uint8Array) => {
			uploadId ??= await this.client.createMultipartUpload(key, headers);
			const partNumber = nextPartNumber++;
			const id = uploadId;
			const task = this.client.uploadPart(key, id, partNumber, data).then((etag) => {
				parts.push({ partNumber, etag });
			});
			const tracked = task.finally(() => inFlight.delete(tracked));
			inFlight.add(tracked);
			if (inFlight.size >= this.concurrency) await Promise.race(inFlight);
		};

		try {
			for await (const chunk of body as AsyncIterable<Buffer>) {
				hash.update(chunk);
				size += chunk.byteLength;
				let offset = 0;
				while (offset < chunk.byteLength) {
					const take = Math.min(this.partSize - filled, chunk.byteLength - offset);
					buffer.set(chunk.subarray(offset, offset + take), filled);
					filled += take;
					offset += take;
					if (filled === this.partSize) {
						await sendPart(buffer);
						buffer = new Uint8Array(this.partSize);
						filled = 0;
					}
				}
			}
			if (uploadId === undefined) {
				await this.client.putObject(key, buffer.subarray(0, filled), headers);
			} else {
				if (filled > 0) await sendPart(buffer.subarray(0, filled));
				await Promise.all(inFlight);
				await this.client.completeMultipartUpload(key, uploadId, parts);
			}
		} catch (error) {
			await Promise.allSettled(inFlight);
			if (uploadId !== undefined) {
				await this.client.abortMultipartUpload(key, uploadId).catch(() => undefined);
			}
			throw error;
		}
		return { size, digest: `sha256:${hash.digest("hex")}` };
	}
}

/** RFC 6266 header with an ASCII fallback plus the exact UTF-8 name. */
function contentDisposition(fileName: string): string {
	const fallback = fileName
		.replace(/[^\x20-\x7e]/g, "_")
		.replace(/["\\]/g, (c) => (c === '"' ? "'" : "_"));
	const encoded = encodeURIComponent(fileName).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
