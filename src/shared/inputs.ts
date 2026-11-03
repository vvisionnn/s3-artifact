import { resolveS3Config } from "./config.ts";
import * as core from "./core.ts";
import { parseBoolean } from "./core.ts";
import { S3Client } from "./s3.ts";
import { ArtifactStore, type RunRef } from "./store.ts";

export const DEFAULT_RETENTION_DAYS = 90;

export const getInput = (name: string): string => core.getInput(name);

export function getBoolean(name: string, fallback: boolean): boolean {
	const value = getInput(name);
	return value === "" ? fallback : parseBoolean(name, value);
}

/** Retention in days: empty or 0 means the repository default, capped like GitHub does. */
export function getRetentionDays(name = "retention-days"): number {
	const raw = getInput(name);
	if (raw !== "" && !/^\d+$/.test(raw)) {
		throw new Error(`Invalid ${name}`);
	}
	const maxDays = Number(process.env.GITHUB_RETENTION_DAYS) || undefined;
	const requested = raw === "" ? 0 : Number(raw);
	if (requested === 0) return maxDays ?? DEFAULT_RETENTION_DAYS;
	if (maxDays !== undefined && requested > maxDays) {
		core.warning(
			`Retention days cannot be greater than the maximum allowed retention set within the repository. Using ${maxDays} instead.`,
		);
		return maxDays;
	}
	return requested;
}

export function getCompressionLevel(): number {
	const raw = getInput("compression-level");
	if (raw === "") return 6;
	if (!/^\d+$/.test(raw)) throw new Error("Invalid compression-level");
	const level = Number(raw);
	if (level > 9) throw new Error("Invalid compression-level. Valid values are 0-9");
	return level;
}

/** The run being executed, from the variables every GitHub Actions job provides. */
export function currentRun(): RunRef {
	const repository = process.env.GITHUB_REPOSITORY;
	const runId = process.env.GITHUB_RUN_ID;
	if (!repository || !runId) {
		throw new Error(
			"GITHUB_REPOSITORY and GITHUB_RUN_ID must be set. This action only runs inside GitHub Actions.",
		);
	}
	return { repository, runId, runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) || 1 };
}

export function createStore(): ArtifactStore {
	const config = resolveS3Config(getInput, process.env);
	return new ArtifactStore(new S3Client(config), config.prefix);
}
