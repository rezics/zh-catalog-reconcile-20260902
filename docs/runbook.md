# Preparation runbook

This runbook reads the live REZICS production database in bounded transactions and ends at
manifest generation. It does not authorize or implement production writes.

## 1. Verify the repository

```powershell
bun install --frozen-lockfile
bun run check
$codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
python (Join-Path $codexRoot 'skills\.system\skill-creator\scripts\quick_validate.py') .agents\skills\zh-catalog-reconcile
```

## 2. Configure and prove production read access

Keep only selectors in `.env`; credentials remain in the ignored operator secret document:

```powershell
$env:REZICS_DATABASE_SECRET_FILE = '<absolute-path-to-secret-document>'
$env:REZICS_SSH_BIND_INTERFACE = '<interface-name>'
$env:REZICS_DATABASE_SECRET_PROFILE = 'runtime'
bun run reconcile doctor
```

Omit the interface selector when the normal route reaches SSH. Omit the profile selector to use
the preferred monitoring credential. Use the runtime fallback only when monitoring lacks catalog
access. `doctor` must prove catalog reads, bounded candidate-search execution, and all applicable
read-only guards.

Alternatively, set a dedicated `REZICS_DATABASE_READONLY_URL`, never both database sources. This
connection reads REZICS itself; it is not an external Book-metadata lookup.

## 3. Initialize a new online run

Use an immutable creation cutoff and observed REZICS release or image digest:

```powershell
bun run reconcile init `
  --run prod-online-20260903 `
  --rezics-ref v1.7.0 `
  --cutoff 2026-09-02T16:00:00.000Z `
  --online-batch-size 64
```

To start a new policy run immediately after a previously captured online run, add
`--after-run <run-id>`. The runner validates that predecessor's packet cursor, cutoff, and
REZICS reference, and records the cursor as new-run metadata; it does not copy or resume the
predecessor's decisions.

New runs default to 64 sources per page. `--online-batch-size` accepts integers from 1 to 100 and
is persisted at initialization. Existing runs retain their page size; do not edit their run JSON
to change it.

Initialization is offline and writes `evidenceMode: "online-batched"` with `applyState: "locked"`.
It also writes `decisionPolicyRevision: "evidence-claims-v3"`. Do not resume a run reported as
`legacy-v1` or `evidence-grounded-v2`, a run that lacks the online evidence mode, or a run
containing `snapshot/books.jsonl`. Older decision runs may only be inspected with `status` and
`audit`.

## 4. Capture inventory

```powershell
bun run reconcile inventory --run prod-online-20260903
bun run reconcile status --run prod-online-20260903
```

Inventory writes aggregate counts only. It does not export Book rows.

## 5. Online decision loop

```powershell
bun run reconcile next --run prod-online-20260903 --limit 5
```

`next` returns persisted undecided packets first. Only when none remain does it open production,
fetch one bounded source/candidate page, atomically persist it, close the transaction, and return
up to the requested number of packets. It never creates a complete catalog file.

Decide only each packet's `undecidedSourceUnitIds`. Save the bounded decision array under `.temp/`
and validate/append it:

```powershell
bun run reconcile record --run prod-online-20260903 --file .temp\decisions.json
bun run reconcile status --run prod-online-20260903
```

Delete only the temporary decision input after successful recording. Repeat `next` and `record`.
The runner fetches another online page only after all current packets are decided, providing
backpressure to production.

Each decision must follow the repository decision template. Routine actions use typed English
`basis` codes whose `citationIndexes` point into the exact stored citations. Reviews use typed
uncertainties with the same linkage. Do not write an explanation; a concise `note` is accepted
only for an explicit `other` code. `record` rejects unsupported claim/field combinations,
unreferenced citations, insufficient keep/merge proof, and complete blanket-review parts.

For a complete run, prefer the single-coordinator concurrent inference command:

```powershell
bun run reconcile work `
  --run full-online-luna-20260904 `
  --concurrency 32 `
  --packets-per-worker 2 `
  --progress-every 1000
```

`work` has no decision-count target. It continues until the online cursor is complete or the
operator interrupts it. Only ephemeral `gpt-5.6-luna` inference is concurrent; capture and record
remain single-owner. On interruption, wait for the command to release its orchestration lock,
then run the same command to resume. Never use a run containing decisions from a different model
or prompt revision, and never use `--after-run` to skip an untrusted decision range. Workers force
ChatGPT login, standard (non-Fast) service, medium reasoning, and a tool-free isolated Codex
configuration. They never redeem a usage reset; an exhausted allowance is a resumable stop.

## Linux full run

Use the existing Linux checkout of this reconciliation repository, not the main REZICS checkout
or a Windows `D:` path. Require Bun 1.4 or newer and a Codex CLI supporting the worker's flags,
logged in with ChatGPT. Resolve the operator-approved secret and SSH-key paths on Linux; omit an
unneeded interface selector and never copy a Windows interface name blindly. Do not change the
approved credential profile or print credentials.

After repository checks and `doctor` pass, initialize a fresh replacement run from the beginning:

```bash
bun run reconcile init \
  --run full-online-luna-20260904 \
  --rezics-ref v1.7.0 \
  --cutoff 2026-09-02T16:00:00.000Z \
  --online-batch-size 64
bun run reconcile probe --run full-online-luna-20260904
bun run reconcile inventory --run full-online-luna-20260904
bun run reconcile work \
  --run full-online-luna-20260904 \
  --concurrency 32 \
  --packets-per-worker 2 \
  --progress-every 100
```

Never initialize an existing ID again. Inspect its policy, actor protocol, source start, cutoff,
REZICS reference, and persisted page size before resuming. Never use `--after-run` to skip an
untrusted predecessor.

`probe` reads the page after the captured cursor, even if that run has pending decisions. It
does not advance checkpoints, persist evidence, or call Luna. Its optional `--online-batch-size`
overrides only this diagnostic read, not the run configuration. For a nonempty page, each of
three SELECTs runs normally and again under `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, within the
same guarded read-only transaction. Do not run it for every part. `roundTripMs` includes normal
result delivery; EXPLAIN execution skips that delivery and may use warmer caches. `elapsedMs`
includes connection and diagnostic overhead, so it is not a normal page-throughput measurement.
Output omits evidence, IDs, query literals, and credentials. The probe rejects observed candidate
base-table/index traversal exceeding the candidate bound, considering filtered rows and per-loop
rounding. Investigate broad scans, temporary spills, and timeouts before starting work; one sample
is not a p95 benchmark or proof of the search function's internal plan.

The `work.started` event records configured and maximum effective parallelism. With a full
64-source page, 32 requests carry two packets each; tail pages use fewer requests. Database
capture and recording still have one owner. `--progress-every 100` controls reporting only, not
the number of decisions or duration of the run.

## 6. Validate and plan actions

```powershell
bun run reconcile status --run prod-online-20260903
bun run reconcile audit --run prod-online-20260903
bun run reconcile plan --run prod-online-20260903
```

`audit` writes `reports/decision-quality.json` and exits nonzero when quality fails. `plan` refuses
while the online source cursor is incomplete, decision coverage is incomplete, decision quality
fails, or any source, target, evidence hash, timestamp, or schema invariant fails. Success writes
`manifests/actions.jsonl`, `reports/decision-quality.json`, and
`reports/manifest-summary.json`.

## 7. Stop

Review and sanitize artifacts before staging anything. Do not add a database writer or call
production mutation endpoints as an incidental continuation. Applying the manifest requires the
separate authorization described in `PLAN.md`.
