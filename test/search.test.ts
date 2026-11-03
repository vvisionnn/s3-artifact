import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { findCaseConflicts, findFilesToUpload, getMultiPathLCA } from "../src/shared/search.ts";
import { tempDir } from "./helpers.ts";

let dir: Awaited<ReturnType<typeof tempDir>>;
beforeEach(async () => {
	dir = await tempDir();
});
afterEach(() => dir.cleanup());

const rel = (files: string[]) =>
	files.map((f) => relative(dir.root, f).split("\\").join("/")).sort();

describe("findFilesToUpload", () => {
	test("single file uses its parent directory as root", async () => {
		const file = await dir.write("out/report.txt");
		const result = await findFilesToUpload(file);
		expect(result.filesToUpload).toEqual([file]);
		expect(result.rootDirectory).toBe(join(dir.root, "out"));
	});

	test("directory search keeps the directory as root and includes descendants", async () => {
		await dir.write("dist/a.txt");
		await dir.write("dist/nested/b.txt");
		const result = await findFilesToUpload(join(dir.root, "dist"));
		expect(rel(result.filesToUpload)).toEqual(["dist/a.txt", "dist/nested/b.txt"]);
		expect(result.rootDirectory).toBe(join(dir.root, "dist"));
	});

	test("multiple search paths use their least common ancestor as root", async () => {
		await dir.write("a/one/x.txt");
		await dir.write("a/two/y.txt");
		const result = await findFilesToUpload(
			`${join(dir.root, "a/one")}\n${join(dir.root, "a/two")}`,
		);
		expect(rel(result.filesToUpload)).toEqual(["a/one/x.txt", "a/two/y.txt"]);
		expect(result.rootDirectory).toBe(join(dir.root, "a"));
	});

	test("excludes hidden files unless requested", async () => {
		await dir.write("d/visible.txt");
		await dir.write("d/.hidden");
		await dir.write("d/.git/config");
		expect(rel((await findFilesToUpload(join(dir.root, "d"))).filesToUpload)).toEqual([
			"d/visible.txt",
		]);
		expect(rel((await findFilesToUpload(join(dir.root, "d"), true)).filesToUpload)).toEqual([
			"d/.git/config",
			"d/.hidden",
			"d/visible.txt",
		]);
	});

	test("supports wildcards and exclusion patterns", async () => {
		await dir.write("w/keep.log");
		await dir.write("w/skip.log");
		await dir.write("w/other.txt");
		const result = await findFilesToUpload(
			`${join(dir.root, "w/*.log")}\n!${join(dir.root, "w/skip.log")}`,
		);
		expect(rel(result.filesToUpload)).toEqual(["w/keep.log"]);
		expect(result.rootDirectory).toBe(join(dir.root, "w"));
	});

	test("follows symbolic links to files", async () => {
		await dir.write("real/data.txt", "data");
		await dir.write("links/plain.txt");
		await symlink(join(dir.root, "real/data.txt"), join(dir.root, "links/data.txt"));
		const result = await findFilesToUpload(join(dir.root, "links"));
		expect(rel(result.filesToUpload)).toEqual(["links/data.txt", "links/plain.txt"]);
	});

	test("returns no files when nothing matches", async () => {
		const result = await findFilesToUpload(join(dir.root, "missing/**"));
		expect(result.filesToUpload).toEqual([]);
	});
});

describe("getMultiPathLCA", () => {
	test("requires at least two paths", () => {
		expect(() => getMultiPathLCA(["/only"])).toThrow("At least two search paths");
	});

	test("returns the filesystem root for disjoint absolute paths", () => {
		expect(getMultiPathLCA([join("/", "foo"), join("/", "bar")])).toBe(join("/"));
	});

	test("handles relative paths", () => {
		expect(getMultiPathLCA([join("x", "y", "a"), join("x", "y", "b"), join("x", "z")])).toBe("x");
	});
});

describe("findCaseConflicts", () => {
	test("reports paths that differ only by case", () => {
		expect(
			findCaseConflicts(["/a/File.txt", "/a/file.txt", "/a/other.txt", "/a/FILE.TXT"]),
		).toEqual([
			"Uploads are case insensitive: /a/file.txt was detected that it will be overwritten by another file with the same path",
			"Uploads are case insensitive: /a/FILE.TXT was detected that it will be overwritten by another file with the same path",
		]);
		expect(findCaseConflicts(["/a/x", "/a/y"])).toEqual([]);
	});
});
