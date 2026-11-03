/**
 * Character rules mirror `@actions/artifact` so artifacts stay portable across file systems (NTFS
 * in particular) and behave exactly like the official actions.
 */
const invalidFilePathCharacters = new Map<string, string>([
	['"', ' Double quote "'],
	[":", " Colon :"],
	["<", " Less than <"],
	[">", " Greater than >"],
	["|", " Vertical bar |"],
	["*", " Asterisk *"],
	["?", " Question mark ?"],
	["\r", " Carriage return \\r"],
	["\n", " Line feed \\n"],
]);

const invalidArtifactNameCharacters = new Map<string, string>([
	...invalidFilePathCharacters,
	["\\", " Backslash \\"],
	["/", " Forward slash /"],
]);

const describeAll = (characters: Map<string, string>): string => [...characters.values()].join(",");

export function validateArtifactName(name: string): void {
	if (!name) {
		throw new Error("Provided artifact name input during validation is empty");
	}
	if (name === "." || name === "..") {
		throw new Error(`The artifact name is not valid: ${name}. Names cannot be '.' or '..'.`);
	}
	for (const [character, description] of invalidArtifactNameCharacters) {
		if (name.includes(character)) {
			throw new Error(
				`The artifact name is not valid: ${name}. Contains the following character: ${description}\n\nInvalid characters include: ${describeAll(invalidArtifactNameCharacters)}\n\nThese characters are not allowed in the artifact name due to limitations with certain file systems such as NTFS.`,
			);
		}
	}
}

export function validateFilePath(path: string): void {
	if (!path) {
		throw new Error("Provided file path input during validation is empty");
	}
	for (const [character, description] of invalidFilePathCharacters) {
		if (path.includes(character)) {
			throw new Error(
				`The path for one of the files in artifact is not valid: ${path}. Contains the following character: ${description}\n\nInvalid characters include: ${describeAll(invalidFilePathCharacters)}\n\nThese characters are not allowed in files that are uploaded due to limitations with certain file systems such as NTFS.`,
			);
		}
	}
}
