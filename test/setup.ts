// Keep test output readable: @actions/core logs to stdout. Set S3_ARTIFACT_TEST_LOGS=1 to see it.
if (!process.env.S3_ARTIFACT_TEST_LOGS) {
	process.stdout.write = (() => true) as typeof process.stdout.write;
}
