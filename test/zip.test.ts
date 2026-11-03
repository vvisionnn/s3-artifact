import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWriteStream } from "node:fs";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZipStream, extractZip } from "../src/shared/zip.ts";
import { tempDir } from "./helpers.ts";

let dir: Awaited<ReturnType<typeof tempDir>>;
beforeEach(async () => {
	dir = await tempDir();
});
afterEach(() => dir.cleanup());

async function zipTo(entries: Parameters<typeof createZipStream>[0], level = 6): Promise<string> {
	const target = join(dir.root, `archive-${level}.zip`);
	await pipeline(createZipStream(entries, level), createWriteStream(target));
	return target;
}

describe("zip round trip", () => {
	test.each([0, 1, 6, 9])("preserves content and layout at compression level %d", async (level) => {
		const a = await dir.write("src/a.txt", "alpha".repeat(1000));
		const b = await dir.write("src/nested/ü b.txt", "beta");
		const empty = await dir.write("src/empty.txt", "");
		const archive = await zipTo(
			[
				{ sourcePath: a, destinationPath: "a.txt" },
				{ sourcePath: b, destinationPath: "nested/ü b.txt" },
				{ sourcePath: empty, destinationPath: "empty.txt" },
			],
			level,
		);
		const out = join(dir.root, "out");
		expect(await extractZip(archive, out)).toBe(3);
		expect(await readFile(join(out, "a.txt"), "utf8")).toBe("alpha".repeat(1000));
		expect(await readFile(join(out, "nested/ü b.txt"), "utf8")).toBe("beta");
		expect(await readFile(join(out, "empty.txt"), "utf8")).toBe("");
	});

	test("compresses more at higher levels", async () => {
		const file = await dir.write("big.txt", "compressible ".repeat(10_000));
		const stored = await zipTo([{ sourcePath: file, destinationPath: "big.txt" }], 0);
		const deflated = await zipTo([{ sourcePath: file, destinationPath: "big.txt" }], 9);
		expect((await stat(deflated)).size).toBeLessThan((await stat(stored)).size / 10);
	});

	test.skipIf(process.platform === "win32")("keeps the executable bit", async () => {
		const script = await dir.write("run.sh", "#!/bin/sh\necho hi\n");
		await chmod(script, 0o755);
		const archive = await zipTo([{ sourcePath: script, destinationPath: "run.sh" }]);
		const out = join(dir.root, "out");
		await extractZip(archive, out);
		expect((await stat(join(out, "run.sh"))).mode & 0o777).toBe(0o755);
	});

	test("overwrites existing files when extracting", async () => {
		const file = await dir.write("f.txt", "new");
		const archive = await zipTo([{ sourcePath: file, destinationPath: "f.txt" }]);
		const out = join(dir.root, "out");
		await dir.write("out/f.txt", "old");
		await extractZip(archive, out);
		expect(await readFile(join(out, "f.txt"), "utf8")).toBe("new");
	});

	test("fails when a source file disappears", async () => {
		const archive = zipTo([
			{ sourcePath: join(dir.root, "gone.txt"), destinationPath: "gone.txt" },
		]);
		await expect(archive).rejects.toThrow();
	});
});

describe("extractZip safety", () => {
	test("extracts directory entries", async () => {
		const archive = join(dir.root, "dirs.zip");
		await writeFile(
			archive,
			rawZip([
				{ name: "folder/", data: "" },
				{ name: "folder/x.txt", data: "x" },
			]),
		);
		const out = join(dir.root, "out");
		expect(await extractZip(archive, out)).toBe(1);
		expect((await stat(join(out, "folder"))).isDirectory()).toBe(true);
	});

	test.each(["../evil.txt", "/abs/evil.txt", "a/../../evil.txt"])(
		"rejects entry %p",
		async (name) => {
			const archive = join(dir.root, "evil.zip");
			await writeFile(archive, rawZip([{ name, data: "pwned" }]));
			await expect(extractZip(archive, join(dir.root, "out"))).rejects.toThrow();
			expect(await Bun.file(join(dir.root, "evil.txt")).exists()).toBe(false);
		},
	);

	test("rejects files that are not zip archives", async () => {
		const archive = await dir.write("not.zip", "plain text");
		await expect(extractZip(archive, join(dir.root, "out"))).rejects.toThrow();
	});
});

/** Builds a stored (uncompressed) zip without any name validation, to simulate hostile archives. */
function rawZip(entries: Array<{ name: string; data: string }>): Uint8Array {
	const chunks: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const { name, data } of entries) {
		const nameBuf = Buffer.from(name);
		const dataBuf = Buffer.from(data);
		const crc = Bun.hash.crc32(dataBuf);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(dataBuf.length, 18);
		local.writeUInt32LE(dataBuf.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		const header = Buffer.alloc(46);
		header.writeUInt32LE(0x02014b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(20, 6);
		header.writeUInt32LE(crc, 16);
		header.writeUInt32LE(dataBuf.length, 20);
		header.writeUInt32LE(dataBuf.length, 24);
		header.writeUInt16LE(nameBuf.length, 28);
		header.writeUInt32LE(offset, 42);
		chunks.push(local, nameBuf, dataBuf);
		central.push(header, nameBuf);
		offset += local.length + nameBuf.length + dataBuf.length;
	}
	const centralBuf = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBuf.length, 12);
	end.writeUInt32LE(offset, 16);
	return new Uint8Array(Buffer.concat([...chunks, centralBuf, end]));
}
