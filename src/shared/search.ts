import { stat } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import * as glob from "@actions/glob";
import * as core from "./core.ts";

export interface SearchResult {
	filesToUpload: string[];
	rootDirectory: string;
}

/**
 * Least common ancestor of the search paths, used as the artifact root when several paths are
 * given. Identical to the official action so archive layouts match.
 */
export function getMultiPathLCA(searchPaths: string[]): string {
	if (searchPaths.length < 2) {
		throw new Error("At least two search paths must be provided");
	}
	const split = searchPaths.map((p) => normalize(p).split(sep));
	const shortest = Math.min(...split.map((parts) => parts.length));
	const common: string[] = [];
	if (searchPaths[0]?.startsWith(sep)) {
		common.push(sep);
	}
	for (let i = 0; i < shortest; i++) {
		const segment = split[0]?.[i];
		if (segment === undefined || split.some((parts) => parts[i] !== segment)) {
			break;
		}
		common.push(segment);
	}
	return join(...common);
}

export async function findFilesToUpload(
	searchPath: string,
	includeHiddenFiles = false,
): Promise<SearchResult> {
	const globber = await glob.create(searchPath, {
		followSymbolicLinks: true,
		implicitDescendants: true,
		omitBrokenSymbolicLinks: true,
		excludeHiddenFiles: !includeHiddenFiles,
	});

	const filesToUpload: string[] = [];
	const seen = new Set<string>();
	for (const result of await globber.glob()) {
		// stat (not lstat) so symlinked directories are skipped like real ones.
		if ((await stat(result)).isDirectory()) {
			continue;
		}
		filesToUpload.push(result);
		const key = result.toLowerCase();
		if (seen.has(key)) {
			core.info(
				`Uploads are case insensitive: ${result} was detected that it will be overwritten by another file with the same path`,
			);
		}
		seen.add(key);
	}

	const searchPaths = globber.getSearchPaths();
	if (searchPaths.length > 1) {
		const rootDirectory = getMultiPathLCA(searchPaths);
		core.info(`Multiple search paths detected. The least common ancestor is ${rootDirectory}`);
		return { filesToUpload, rootDirectory };
	}

	const [onlyPath = searchPath] = searchPaths;
	// A single explicit file keeps no directory structure: its parent becomes the root.
	if (filesToUpload.length === 1 && onlyPath === filesToUpload[0]) {
		return { filesToUpload, rootDirectory: dirname(onlyPath) };
	}
	return { filesToUpload, rootDirectory: onlyPath };
}
