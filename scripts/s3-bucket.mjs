// Sets up the private file bucket, then checks it. Safe to run again: every step is idempotent.
//
//   S3_BUCKET=… S3_REGION=… [S3_ENDPOINT=… S3_FORCE_PATH_STYLE=true] \
//   S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=…  node scripts/s3-bucket.mjs [--check]
//
// What it sets:
// - the bucket, if it does not exist;
// - versioning on, so an overwritten or deleted object can be restored (docs/BACKUP_AND_RESTORE.md);
// - every public-access setting blocked (AWS; MinIO buckets are private unless given a policy,
//   so there the script checks that no bucket policy exists);
// - a lifecycle rule that removes old object versions after S3_NONCURRENT_DAYS (default 35)
//   and cleans up unfinished uploads after a day.
//
// --check changes nothing and exits 1 if any of that is missing. Objects are already
// encrypted by the app; the bucket's own encryption (SSE-S3 or SSE-KMS) is a second layer
// set by the cloud account, not here.
import {
  CreateBucketCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const checkOnly = process.argv.includes("--check");
const bucket = process.env.S3_BUCKET;
if (!bucket) {
  console.error("S3_BUCKET is not set.");
  process.exit(1);
}
const noncurrentDays = Number(process.env.S3_NONCURRENT_DAYS ?? 35);
if (!Number.isInteger(noncurrentDays) || noncurrentDays < 1) {
  console.error("S3_NONCURRENT_DAYS must be a whole number of days.");
  process.exit(1);
}
const region = process.env.S3_REGION || "us-east-1";
const client = new S3Client({
  region,
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
    ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
    : undefined,
});

const problems = [];
const errorName = (error) => error?.name ?? error?.Code ?? "Error";
const notImplemented = (error) => errorName(error) === "NotImplemented" || error?.$metadata?.httpStatusCode === 501;

async function exists() {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || errorName(error) === "NotFound") return false;
    throw error;
  }
}

if (!(await exists())) {
  if (checkOnly) {
    console.error(`Bucket ${bucket} does not exist.`);
    process.exit(1);
  }
  await client.send(new CreateBucketCommand({
    Bucket: bucket,
    ...(region !== "us-east-1" && !process.env.S3_ENDPOINT ? { CreateBucketConfiguration: { LocationConstraint: region } } : {}),
  }));
  console.log(`Created bucket ${bucket}.`);
}

// Versioning.
if (!checkOnly) {
  await client.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
}
const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
if (versioning.Status !== "Enabled") problems.push("versioning is not on");

// Public access.
const blockAll = { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true };
let publicAccessChecked = false;
// MinIO answers the read with NotImplemented and the write with MalformedXML, so read first.
try {
  await client.send(new GetPublicAccessBlockCommand({ Bucket: bucket })).catch((error) => {
    if (errorName(error) === "NoSuchPublicAccessBlockConfiguration") return null;
    throw error;
  });
  if (!checkOnly) await client.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: blockAll }));
  const block = await client.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
  const settings = block.PublicAccessBlockConfiguration ?? {};
  if (!Object.keys(blockAll).every((name) => settings[name] === true)) problems.push("public access is not fully blocked");
  publicAccessChecked = true;
} catch (error) {
  if (!notImplemented(error) && errorName(error) !== "NoSuchPublicAccessBlockConfiguration") throw error;
  if (errorName(error) === "NoSuchPublicAccessBlockConfiguration") problems.push("public access is not blocked");
}
if (!publicAccessChecked) {
  // MinIO: no public-access-block API. A bucket is private unless it has a policy.
  try {
    await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
    problems.push("the bucket has a policy; remove it so nothing is public");
  } catch (error) {
    if (errorName(error) !== "NoSuchBucketPolicy" && error?.$metadata?.httpStatusCode !== 404) throw error;
  }
}

// Lifecycle: keep old versions long enough to restore from, then let them go.
const rules = [{
  ID: "kalendr-old-versions",
  Status: "Enabled",
  Filter: { Prefix: "" },
  NoncurrentVersionExpiration: { NoncurrentDays: noncurrentDays },
  AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
}];
if (!checkOnly) {
  await client.send(new PutBucketLifecycleConfigurationCommand({ Bucket: bucket, LifecycleConfiguration: { Rules: rules } }));
}
try {
  const lifecycle = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
  const rule = lifecycle.Rules?.find((candidate) => candidate.ID === "kalendr-old-versions");
  if (!rule || rule.Status !== "Enabled") problems.push("the old-versions lifecycle rule is missing");
} catch (error) {
  if (errorName(error) !== "NoSuchLifecycleConfiguration") throw error;
  problems.push("the old-versions lifecycle rule is missing");
}

if (problems.length) {
  console.error(`Bucket ${bucket}: ${problems.join("; ")}.`);
  process.exit(1);
}
console.log(`Bucket ${bucket}: private, versioned, old versions kept ${noncurrentDays} days.`);
