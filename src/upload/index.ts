import * as core from "../shared/core.ts";
import { runUpload } from "./run.ts";

runUpload().catch((error: unknown) =>
	core.setFailed(error instanceof Error ? error.message : String(error)),
);
