# Backup and restore

What Kalendr keeps, where it lives, how it is backed up, and how to bring it back. Written for the person on call. A backup that has never been restored is not a recovery control, so the drill at the end is run and recorded.

## What has to come back together

| Part | Where | Backed up by |
| --- | --- | --- |
| Database | Managed PostgreSQL 18 | The provider's point-in-time recovery (PITR): a daily base backup plus the write-ahead log (WAL), so any second in the retention window can be restored. Keep at least 35 days. |
| Files (record reports, business pictures, staff photos) | One private S3 bucket, keys `tenant/{tenantId}/{record\|media}/{id}` | Bucket versioning: an overwrite or delete keeps the earlier version. Old versions are removed after `S3_NONCURRENT_DAYS` (default 35) by the lifecycle rule `scripts/s3-bucket.mjs` sets. Match it to the database's PITR window. |
| Data keys | `tenant_data_keys` in the database, each wrapped by the master key | The database backup. The rows are useless without the master key. |
| Master key | AWS KMS (`KMS_KEY_ID`) | KMS itself. Never schedule its deletion while any backup inside the retention window may still need it. |
| Old server-wide key | `KALENDR_RECORDS_KEY` (secret manager) | The secret manager. Keep it while any backup may hold rows on key version 0. |

Every file is encrypted by the app before upload (`k2` format, AES-256-GCM with the business's data key; the business id and key version are bound in, so an object copied to another business will not open). A copy of the bucket alone, or the database alone, reveals nothing; restoring needs the database, the bucket version and the master key from the same point in time.

## Set up (once per environment)

1. **Database:** turn on PITR on the managed provider, retention 35 days or more, and encrypted backups. Restrict who can restore.
2. **Bucket:** run `node scripts/s3-bucket.mjs` with the `S3_*` variables. It creates the bucket if missing, turns versioning on, blocks all public access (AWS) or checks there is no bucket policy (MinIO), and adds the old-versions rule. `node scripts/s3-bucket.mjs --check` changes nothing and exits 1 if any of that is missing; run it in the release checklist.
3. **Bucket permissions for the app and worker:** `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucketVersions` and `s3:DeleteObjectVersion` on the bucket only. The last two are used only to purge every version of a file that carried a virus. Nobody gets `s3:PutBucketPolicy` or a public ACL. The bucket's own encryption (SSE-S3 or SSE-KMS) is a second layer set in the cloud account.
4. **KMS:** the app's role needs `kms:GenerateDataKey` and `kms:Decrypt` on the one key. Kalendr sends the encryption context `kalendr_tenant` and `kalendr_key_version`; a key policy condition on `kms:EncryptionContextKeys` can require it. Turn on KMS key rotation in AWS too; Kalendr's own yearly data-key rotation is separate.

## Restore the database to a moment

Use this for a damaging migration, a mistaken bulk delete, or corruption.

1. Pick the moment `T`: just before the damage. Read it from the audit log (`audit_events.occurred_at`), the deploy log or the error report.
2. Stop the worker first, then the web app, so nothing writes to the damaged database. Export anything made after `T` that must be kept, if the database still answers.
3. On the provider, restore to a **new** instance at `T`. Never restore over the damaged one.
4. Check the restored copy:
   - `select kalendr_schema_version();` gives the value this build expects;
   - row counts for the tables involved look as they did at `T`;
   - row-level security is still forced (`docs/OPERATIONS.md`, "Restore a backup", step 3);
   - start one web container against it and check `/api/ready` returns 200.
5. Bring files back to the same moment (next section) for anything deleted after `T`.
6. Point `DATABASE_URL`, `WORKER_DATABASE_URL` and `DATABASE_OWNER_URL` at the new instance, start the web app, then the worker.
7. Open one record file and one business picture through the app. A file that opens proves the database row, the bucket object and the master key all match.

Transactions committed after `T` are lost. Re-encryption and scans that ran after `T` simply run again: both jobs are safe to repeat.

## Restore files

Files are never deleted by a normal action in one step: a plain delete leaves a delete marker and keeps the version.

- **A deleted file:** delete the newest delete marker for that key (`DeleteObject` with the marker's `VersionId`). The earlier version becomes current again.
- **An overwritten file:** copy the earlier version over the current one (`CopyObject` with `CopySource=bucket/key?versionId=…`).
- **Everything back to a moment:** for each key under `tenant/`, make the newest version older than `T` current. Do this only for keys whose database row was also restored, so row and object match.

Which version matches a restored row: the row's `key_version` must match the version number in the object's header (bytes 2–5 after `k2`). If a re-encryption ran after `T`, the newest object is on a newer key than the restored row says; it still opens, because a file opens by the version written in it, and the next re-encryption run sets the column right.

Files that carried a virus are purged with every version, on purpose. They cannot be restored.

## Keys and restore

- A restored database may hold rows on key versions that were later retired. They still open: retired versions stay in `tenant_data_keys` and are only refused for new writes.
- Do not delete the KMS master key, or the old `KALENDR_RECORDS_KEY`, while any backup inside the retention window may still need it.
- A restore to before a rotation brings back the older key list. The yearly job rotates again when it is due, and an owner can rotate at once from **Settings → Data protection**.

## Restore drill

Run one each quarter and after any change to storage or keys. Record the date, the moment chosen, the timings and anything that went wrong here.

### Drill 1 — 2026-11-12, local (feature 10)

Run against local containers: PostgreSQL 18.6 with WAL archiving on (`archive_command` copying to a local folder), MinIO with versioning, and the app on its own port. The database held one seeded business with records on key versions 0, 1 and 2.

| Step | What happened | Time |
| --- | --- | --- |
| Base backup | `pg_basebackup -Ft -z -X stream -c fast`, 4.7 MB | under 1 s |
| Before | 3 records, 4 record files | |
| Restore point `T` | 09:22:05.207857 UTC, recorded before the damage | |
| Damage | 4 file rows and 1 record deleted by hand; the report object deleted from the bucket (delete marker left). The app answered 404 for the file. WAL switched and archived (13 segments, 0 failures). | |
| Database restore | New container, base backup unpacked, `restore_command` from the archive, `recovery_target_time = T`, promote. Recovery stopped before the first commit after `T` and promoted. | 5 s, copy to ready |
| Restored | 3 records, 4 record files: the same as before | |
| Bucket restore | Deleted the delete marker; the earlier version was current again (151 bytes, `k2`) | under 1 s |
| Through the app | The app restarted against the restored database. The report opened (200, the same 117 bytes as uploaded). A record from before per-business keys (version 0) opened. The record the damage deleted opened. The original damaged database no longer had that record, so the 200 came from the restored copy. | about 10 s to restart |

Findings:

- The restore needs the archived WAL up to the moment chosen; a gap stops recovery early. Managed PITR handles this, but check the provider's retention covers the bucket's 35 days.
- The first commit after `T` was the worker's own job bookkeeping, three seconds later. Jobs that ran after `T` ran again after the restore without harm.

Not verified: a restore on a managed provider, real S3 versioning, real KMS, and a database of production size. Time those on the production provider before relying on these numbers.
