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
  --cutoff 2026-09-02T16:00:00.000Z
```

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
