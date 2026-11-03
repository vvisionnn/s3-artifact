import * as core from "../shared/core.ts";
import { runDownload } from "./run.ts";

runDownload().catch((error: unknown) =>
	core.setFailed(
		`Unable to download artifact(s): ${error instanceof Error ? error.message : String(error)}`,
	),
);
