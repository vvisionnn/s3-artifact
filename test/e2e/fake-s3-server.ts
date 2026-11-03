/** Child process: serves the fake S3 and reports its endpoint to the parent over IPC. */
import { FakeS3 } from "../fake-s3.ts";

const s3 = new FakeS3();
process.send?.({ endpoint: s3.endpoint, bucket: s3.bucket, accessKeyId: s3.accessKeyId });
