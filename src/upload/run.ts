import * as core from "../shared/core.ts";
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

const NO_FILE_OPTIONS = ["warn", "error", "ignore"] as const;
type NoFileOption = (typeof NO_FILE_OPTIONS)[number];

export async function runUpload(): Promise<void> {
	const name = getInput("name") || "artifact";
	const searchPath = core.getInput("path", { required: true });
	const ifNoFilesFound = getInput("if-no-files-found") || "warn";
	if (!NO_FILE_OPTIONS.includes(ifNoFilesFound as NoFileOption)) {
		throw new Error(
			`Unrecognized if-no-files-found input. Provided: ${ifNoFilesFound}. Available options: ${NO_FILE_OPTIONS.join(",")}`,
		);
	}
	const retentionDays = getRetentionDays();
	const compressionLevel = getCompressionLevel();
	const overwrite = getBoolean("overwrite", false);
	const includeHiddenFiles = getBoolean("include-hidden-files", false);
	const archive = getBoolean("archive", true);

	const { filesToUpload, rootDirectory } = await findFilesToUpload(searchPath, includeHiddenFiles);
	if (filesToUpload.length === 0) {
		const message = `No files were found with the provided path: ${searchPath}. No artifacts will be uploaded.`;
		if (ifNoFilesFound === "error") throw new Error(message);
		if (ifNoFilesFound === "warn") core.warning(message);
		else core.info(message);
		return;
	}
	const s = filesToUpload.length === 1 ? "" : "s";
	core.info(`With the provided path, there will be ${filesToUpload.length} file${s} uploaded`);
	core.debug(`Root artifact directory is ${rootDirectory}`);

	await uploadFiles(createStore(), currentRun(), {
		name,
		files: filesToUpload,
		rootDirectory,
		archive,
		compressionLevel,
		retentionDays,
		overwrite,
	});
}
