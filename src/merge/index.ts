import * as core from "../shared/core.ts";
import { runMerge } from "./run.ts";

runMerge().catch((error: unknown) =>
	core.setFailed(error instanceof Error ? error.message : String(error)),
);
