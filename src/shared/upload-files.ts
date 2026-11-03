import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import * as core from "./core.ts";
import type { ArtifactStore, RunRef } from "./store.ts";
import { validateArtifactName, validateFilePath } from "./validation.ts";
import { createZipStream, type ZipEntry } from "./zip.ts";

export interface UploadFilesOptions {
	name: string;
	files: string[];
	rootDirectory: string;
	archive: boolean;
	compressionLevel: number;
	retentionDays: number;
	overwrite: boolean;
}

/** Uploads files as one artifact and sets the same outputs as `actions/upload-artifact`. */
export async function uploadFiles(
	store: ArtifactStore,
	run: RunRef,
	options: UploadFilesOptions,
): Promise<void> {
	let name = options.name;
	let fileName = `${name}.zip`;
	let body: NodeJS.ReadableStream;

	if (options.archive) {
		validateArtifactName(name);
		body = createZipStream(
			await zipEntries(options.files, options.rootDirectory),
			options.compressionLevel,
		);
	} else {
		const [file] = options.files;
		if (options.files.length !== 1 || file === undefined) {
			throw new Error(
				`When 'archive' is set to false, only a single file can be uploaded. Found ${options.files.length} files to upload.`,
			);
		}
		fileName = basename(file);
		name = fileName;
		validateArtifactName(name);
		body = createReadStream(file);
	}

	core.info(`Uploading artifact: ${fileName}`);
	const manifest = await store.upload(run, {
		name,
		fileName,
		archive: options.archive,
		body: body as import("node:stream").Readable,
		retentionDays: options.retentionDays,
		overwrite: options.overwrite,
	});

	const digest = manifest.digest.replace(/^sha256:/, "");
	core.info(
		`Artifact ${name} has been successfully uploaded! Final size is ${manifest.size} bytes. Artifact ID is ${manifest.id}`,
	);
	core.setOutput("artifact-id", manifest.id);
	core.setOutput("artifact-digest", digest);
	// A presigned link grants access to anyone holding it, so it is exposed as an output only.
	core.setOutput("artifact-url", await store.presign(manifest));
}

async function zipEntries(files: string[], rootDirectory: string): Promise<ZipEntry[]> {
	const root = resolve(rootDirectory);
	if (!(await stat(root).catch(() => undefined))?.isDirectory()) {
		throw new Error(`The provided rootDirectory ${rootDirectory} is not a valid directory`);
	}
	return files.map((file) => {
		const sourcePath = resolve(file);
		const destinationPath = relative(root, sourcePath).split(sep).join("/");
		if (destinationPath.startsWith("..")) {
			throw new Error(
				`The rootDirectory: ${root} is not a parent directory of the file: ${sourcePath}`,
			);
		}
		validateFilePath(destinationPath);
		return { sourcePath, destinationPath };
	});
}
