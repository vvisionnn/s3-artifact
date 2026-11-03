import { createWriteStream } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import yazl from "yazl";

export interface ZipEntry {
	sourcePath: string;
	/** Path inside the archive, using `/` separators and no leading slash. */
	destinationPath: string;
}

/** Streams a zip (ZIP64 when needed) of the given files. Errors surface on the returned stream. */
export function createZipStream(entries: ZipEntry[], compressionLevel: number): Readable {
	const zip = new yazl.ZipFile();
	const output = zip.outputStream as Readable;
	zip.on("error", (error: Error) => output.destroy(error));
	for (const entry of entries) {
		zip.addFile(entry.sourcePath, entry.destinationPath, {
			compress: compressionLevel > 0,
			compressionLevel,
		});
	}
	zip.end();
	return output;
}

/** Extracts a zip file into `directory`, refusing entries that would escape it. Returns the file count. */
export async function extractZip(zipPath: string, directory: string): Promise<number> {
	const root = resolve(directory);
	await mkdir(root, { recursive: true });
	const zip = await new Promise<yauzl.ZipFile>((done, fail) =>
		yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (error, file) =>
			error ? fail(error) : done(file),
		),
	);

	let files = 0;
	try {
		await new Promise<void>((done, fail) => {
			zip.on("error", fail);
			zip.on("end", done);
			zip.on("entry", (entry: yauzl.Entry) => {
				extractEntry(zip, entry, root).then((isFile) => {
					if (isFile) files++;
					zip.readEntry();
				}, fail);
			});
			zip.readEntry();
		});
	} finally {
		zip.close();
	}
	return files;
}

async function extractEntry(
	zip: yauzl.ZipFile,
	entry: yauzl.Entry,
	root: string,
): Promise<boolean> {
	const target = resolve(root, entry.fileName);
	if (target !== root && !target.startsWith(root + sep)) {
		throw new Error(`Refusing to extract ${entry.fileName}: it resolves outside of ${root}`);
	}
	if (entry.fileName.endsWith("/")) {
		await mkdir(target, { recursive: true });
		return false;
	}
	await mkdir(dirname(target), { recursive: true });
	const source = await new Promise<Readable>((done, fail) =>
		zip.openReadStream(entry, (error, stream) => (error ? fail(error) : done(stream))),
	);
	await pipeline(source, createWriteStream(target));
	const mode = (entry.externalFileAttributes >>> 16) & 0o777;
	if (mode && process.platform !== "win32") {
		await chmod(target, mode);
	}
	return true;
}
