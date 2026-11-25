# Protected storage (feature 10) — 12 November 2026

What was built:

- **Envelope encryption.** One 256-bit data key per business in `tenant_data_keys` (row-level security, forced), stored only wrapped by a master key. `src/server/keys/`: `provider.ts` picks the provider, `kms.ts` (AWS KMS, `@aws-sdk/client-kms`), `local.ts` (a local master key for development and tests), `ring.ts` (load, cache, rotate), `envelope.ts` (format), `records.ts` (`sealBytes` and `openBytes`, signatures unchanged), `secrets.ts` (for other features' secrets).
- **Key versions.** A ciphertext starts `k2` and carries its 32-bit key version, which is bound into the authentication tag with the business id. The old format (`v1`, `KALENDR_RECORDS_KEY`) is version 0 and still opens. `visit_records`, `visit_record_files`, `forms` (answers) and `media_assets` have a `key_version` column. New writes use version 1 onward.
- **Rotation and re-encryption.** `key-rotation` (02:30 daily, rotates a key once it is a year old) and **Replace key now** on Settings → Data protection (owner and admin, idempotent, checked against the version on screen). `storage-re-encrypt` (every 10 minutes) moves older items forward in batches and retires versions nothing uses, including version 0.
- **S3 adapter** (`src/server/file-store-s3.ts`, `@aws-sdk/client-s3`). Keys `tenant/{tenantId}/{record|media}/{id}`. Bytes are encrypted before upload. No public or presigned links. A file that carried a virus is purged with every version. `scripts/s3-bucket.mjs` sets up and checks the bucket: versioning on, public access blocked, an old-versions lifecycle rule.
- **ClamAV** (`src/server/scan/clamav.ts`, the clamd `INSTREAM` protocol). `scan_status` on record files and pictures: pending, clean, infected or skipped. Pending files cannot be opened or shared and show "Checking file…". Infected files are purged, marked and audited. In production with no scanner, uploads are refused.
- **Pictures** (business pictures and staff photos) move to the file store; `media-backfill` moves existing ones.
- **Migration** `drizzle/0016_protected_storage.sql`, self-contained. The worker's cross-business reads are `kalendr_storage_tenants(job)` (ids only) and `kalendr_storage_health()` (counts only), both SECURITY DEFINER and revoked from PUBLIC and the web role.
- **`compose.yaml`** has `minio` and `clamav` under the `storage` profile.
- **`docs/BACKUP_AND_RESTORE.md`** covers point-in-time recovery, versioning, keys and a recorded restore drill.

Everything below ran on this machine against local containers: PostgreSQL 18.6, MinIO (Chainguard build), and ClamAV 1.4 (`clamav/clamav-debian`, signatures downloaded at start). The key provider was `local`; `KALENDR_RECORDS_KEY` held a generated test value. The app ran `next start` with `NODE_ENV=production`, `KALENDR_FILE_STORE=s3` and ClamAV on, on its own port. The worker ran in `local_capture` mode. Generated secrets lived only in git-ignored scratch files. The containers were removed afterwards.

**Not verified:** real AWS S3, real AWS KMS (`kms.ts` is unit-tested against a stubbed client only), and a restore on a managed database provider.

## "Done when", one by one

| Criterion | What was done | Result |
| --- | --- | --- |
| An uploaded report is unreadable in the bucket | Uploaded a 117-byte PDF containing "HAEMOGLOBIN 13.5" through `POST /api/staff/records/:id/files`, then read the object straight from MinIO | 201 with `scanStatus: pending`. The row has `key_version 1` and `storage_key tenant/<business>/record/<file>`. The object is 151 bytes, starts with `k2`, and contains neither `%PDF` nor `HAEMOGLOBIN`. |
| It opens through the app | The worker scanned it (clean, about 1 s), then `GET …/files/:fileId` | 200 `application/pdf`, the same 117 bytes. |
| It is blocked while pending | Open and share before the scan | Open: 409 `file_pending`. Share: 409 `file_pending`. The record drawer shows "Checking file… It can be opened and shared once the check is done." with a spinner, and sharing is disabled. Checked at 360 px and in dark mode. |
| EICAR is rejected | A raw EICAR file, then a PDF with EICAR embedded as a file | The raw file is refused by the type check before upload. The PDF is accepted as pending, then the scan finds `Eicar-Signature`. Open returns 410 `file_infected`. The current object returns 404, with 0 versions and 0 delete markers left in bucket history. An audit row `record.file.infected` (system, denied) holds the file id, record id, uploader id and signature. The list shows it struck through: "Removed — a virus was found. Nobody can open it." |
| After rotation, old and new records are both readable | Data protection status, then **Replace key now** through the API | Status before: key 1, 2 items on older keys, scanning on. POST: `{keyVersion: 2}`. The same idempotency key returns the same answer. A stale version with a new key returns 409 `key_changed`. A record written afterwards is on key 2. Records on versions 0, 1 and 2, and the version-1 file, all open. |
| Re-encryption moves everything forward | `reEncryptStorage` (the `storage-re-encrypt` job) twice | First run: 1 business, 4 items. Second run: 0. Keys: version 0 (server-wide) retired, 1 retired, 2 current. Every record and clean file is on 2. The legacy object is rewritten as `k2` version 2. Everything still opens, and sharing now succeeds (200). Infected files stay on their version and never open. |
| Records written before the change still open | A record and a file planted in the pre-feature format (`v1`, server-wide key, old storage key `{business}/{uuid}`) | Both open before and after rotation. After re-encryption they are on key 2, and the server-wide key no longer opens anything of that business. |
| Restore drill recorded | Base backup, damage (rows and the bucket object deleted), point-in-time recovery into a new container, delete marker removed, app pointed at the restored copy | Database restored in 5 s. Counts match. The file opens through the app with the same bytes. Full table in `docs/BACKUP_AND_RESTORE.md`, "Drill 1". |
| Screen work | Settings → Data protection, and the record drawer | At 360 px in dark mode: "Key 2 · since 12 Nov 2026", "All on the current key", **Replace key now** (confirm dialog), and the File checks card. No horizontal scroll (scroll width 360). The record drawer opens and works by keyboard. Built from coss Card, Alert, AlertDialog, Badge, Button and Spinner. |

## Automated tests

| File | What it checks |
| --- | --- |
| `src/server/record-crypto.test.ts` | Round trip; only the wrapped key is stored; nothing seals before keys are loaded; businesses are kept apart, including a key row moved to another business; tampering, including a changed version; a fresh nonce each time; version 0 still opens; after rotation old and new both open; a rotation by another process is picked up; a retired version still opens, and a retired version 0 is refused; two racing writers make one key; a wrong master key is named; production fails closed. |
| `src/server/keys/kms.test.ts` | Asks KMS for an AES-256 key bound to the business and version; unwraps with the same context and fails for another business; refuses a reply without a 32-byte key. Stubbed client. |
| `src/server/keys/secrets.test.ts` | Round trip and survival across rotation; bound to its purpose and business; never uses the server-wide key. |
| `src/server/file-store-s3.test.ts` | Writes opaque bytes under the business's prefix, once; replace and remove; purges every version of exactly one key, page by page; refuses keys that could escape a prefix; names an empty reply. Stubbed client. |
| `src/server/scan/clamav.test.ts` | Reads clamd's verdicts; streams in chunks; EICAR is infected; an error, a silent scanner and a closed port give no verdict; ping. Against a fake clamd socket. |
| `src/worker/storage-jobs.integration.test.ts` | Runs as the real worker role against PostgreSQL 18 in `verify-postgres18.sh`: lists only businesses with work, by id; backfills pictures, encrypted, waiting for a scan; a clean scan makes a picture usable, and an infected record file is removed, purged and audited; re-encryption, then the server-wide key is refused; rotation, with old and new both open, then everything moves forward and the old key retires; a year-old key rotates; businesses are kept apart by row-level security. |
| `src/server/env.test.ts`, `src/worker/worker.test.ts` | Production start-up names a missing key provider, master key, KMS settings or bucket; the four new schedules and two handlers are registered. |

## Commands

| Command | Result |
| --- | --- |
| `pnpm check` (lint, typecheck, unit tests, build) | Passed. Lint clean; 75 test files passed, 7 skipped; 557 tests passed, 38 skipped; build compiled. |
| `scripts/verify-postgres18.sh` | Passed. Migrations applied on PostgreSQL 18.6, seed verified, 5 integration files with 33 tests passed, including `storage-jobs.integration.test.ts`. |
| `KALENDR_E2E_PORT=5612 scripts/e2e.sh` | Passed: 16 tests, desktop and phone, in 1.3 min. The default port 5546 was in use by another session. |

## Known limits

- Real S3, real KMS and a production restore were not verified.
- If ClamAV is down for all 8 attempts (about 21 minutes), the scan goes to dead letter and the file stays pending. **Try again** on the Not sent panel re-queues it.
- The uploader is told of a virus through the file list and the audit log; a message waits for features 2–5.
- A version with a pending item is not retired until the item is scanned.
- Deploy order: old web code writes version 0, which fails for a business whose version 0 is retired. Do not roll back across this release once re-encryption has run.
- A staff photo or picture is hidden until its scan is clean.
- **Replace key now** rotates at once; moving existing items follows within 10 minutes.
- If an object is rewritten but the row update then fails, the object still opens, because a file opens by the version written in it.
- `KALENDR_RECORDS_KEY` stays required in production until every business has retired version 0.
- Purging a virus needs `s3:ListBucketVersions` and `s3:DeleteObjectVersion`.
- ClamAV finds EICAR inside a PDF only when it is embedded as a file; EICAR text appended after a PDF header is not flagged.
