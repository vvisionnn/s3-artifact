/**
 * The subset of `@actions/core` these actions need, speaking the same runner protocol. The real
 * package drags in an HTTP stack (undici, ~900 KiB) for OIDC tokens; the build aliases
 * `@actions/core` to this module so dependencies such as `@actions/glob` share it.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { EOL } from "node:os";

const TRUE_VALUES = new Set(["true", "True", "TRUE"]);
const FALSE_VALUES = new Set(["false", "False", "FALSE"]);

/** Parses a boolean using the YAML 1.2 core schema, like `core.getBooleanInput`. */
export function parseBoolean(name: string, value: string): boolean {
	if (TRUE_VALUES.has(value)) return true;
	if (FALSE_VALUES.has(value)) return false;
	throw new TypeError(
		`Input does not meet YAML 1.2 "Core Schema" specification: ${name}\nSupport boolean input list: \`true | True | TRUE | false | False | FALSE\``,
	);
}

export function getInput(name: string, options?: { required?: boolean }): string {
	const value = process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "";
	if (options?.required && !value) {
		throw new Error(`Input required and not supplied: ${name}`);
	}
	return value.trim();
}

export function getBooleanInput(name: string, options?: { required?: boolean }): boolean {
	return parseBoolean(name, getInput(name, options));
}

export function setOutput(name: string, value: unknown): void {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	const file = process.env.GITHUB_OUTPUT;
	if (file) {
		const delimiter = `ghadelimiter_${randomUUID()}`;
		appendFileSync(file, `${name}<<${delimiter}${EOL}${text}${EOL}${delimiter}${EOL}`, "utf8");
		return;
	}
	process.stdout.write(EOL);
	command("set-output", text, `name=${name}`);
}

export function info(message: string): void {
	process.stdout.write(`${message}${EOL}`);
}

export function debug(message: string): void {
	command("debug", message);
}

export function warning(message: string): void {
	command("warning", message);
}

export function setFailed(message: string): void {
	process.exitCode = 1;
	command("error", message);
}

function command(name: string, message: string, properties = ""): void {
	const data = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
	process.stdout.write(`::${name}${properties ? ` ${properties}` : ""}::${data}${EOL}`);
}
