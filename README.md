# REZICS Chinese catalog reconciliation — 2026-09-02

This public repository prepares a one-time, resumable reconciliation of REZICS Book Units whose
complete metadata-localization language set is exactly `{zh}`. Every source and candidate is read
from the live REZICS production database in small, bounded transactions. The workflow never
copies the complete catalog locally, inspects the wider web, or implements production writes.

The production sample that motivated the work contains query fragments and character names
misrepresented as Books, duplicate author Entities, and incorrect attribution relationships. The
job therefore distinguishes identity merge, reversible deletion, metadata revision, and
uncertainty; it is not a moderation sweep.

## Scope

A source Book must be published, public, approved, not deleted, created before the run cutoff,
and currently have exactly one metadata localization whose language is `zh`. A Book with a `ja`
or any other localization is never a mutation source. It may be returned by the live candidate
search as a protected canonical merge target.

The classifier may use titles, summaries, descriptions, aliases, Book fields, timestamps, and
credit relationships stored by REZICS. URLs are treated only as stored text and are never
requested.

## Online data flow

`next` first returns any locally persisted but undecided packets. When none remain, it opens a
short repeatable-read, read-only production transaction and:

1. selects the next bounded page of exact-`zh` sources by `(created_at, id)` keyset;
2. invokes the existing bounded REZICS text-candidate search for each source inside one batch;
3. reads full evidence only for those sources and returned candidates;
4. closes the transaction;
5. atomically persists the resulting evidence packets and advances the recoverable cursor.

AI work happens only after the database transaction is closed. The repository stores the finite
packets actually considered, their hashes, decisions, checkpoints, and event logs. It does not
create `snapshot/books.jsonl` or another complete local catalog export.

New runs use the `evidence-claims-v3` decision policy. Routine decisions contain typed English
`basis` codes instead of generated prose. Every basis code points to exact stored citations by
index, and the validator proves that the cited Unit and field can support that claim. Reviews use
typed uncertainties linked to citations. A concise `note` is allowed only when an `other` code is
unavoidable. Earlier decision contracts remain readable through `status` and `audit`, but cannot
be resumed or planned.

The `work` command is the full-corpus inference path. One coordinator owns production capture and
recording while bounded ephemeral Codex workers run `gpt-5.6-luna` concurrently. Workers return
typed proposals with citations nested in their basis or uncertainty; the coordinator supplies
packet identity and actor fields, derives the persisted citation indexes, validates every proposal,
and records the part. An exhausted semantic part is deferred while independent parts continue, so
one long-tail item does not drain and restart the bounded pipeline. A keep proposal's unique equal-length source-title transcription may be
restored to the stored title before the same validator runs. Long matching synopsis evidence and
query-title contradictions retain their typed validation rules. A merge target typo is restored
only from one uniquely cited packet candidate. Invalid redundant basis claims are omitted only
when the remaining basis independently validates. A long `same_synopsis` citation may be restored
only to a unique same-field stored value differing by one character. Total work is not count-limited.

## Repository roles

- [`PLAN.md`](./PLAN.md) is the authoritative execution and approval plan.
- [`docs/decision-policy.md`](./docs/decision-policy.md) defines AI outcomes and evidence rules.
- [`docs/architecture.md`](./docs/architecture.md) explains online data flow and scaling.
- [`docs/runbook.md`](./docs/runbook.md) contains operator commands through manifest generation.
- [`references/decision-template.md`](./references/decision-template.md) lists the worker and
  persisted evidence-claim contract.
- [`.agents/skills/zh-catalog-reconcile/SKILL.md`](./.agents/skills/zh-catalog-reconcile/SKILL.md)
  instructs an AI task how to continue the run safely.
- `src/` contains deterministic online querying, packet, validation, and manifest tooling.
- `schemas/` is generated from the runtime Zod contracts.
- `runs/` receives ignored JSON and JSONL artifacts.

## Install and verify

```powershell
bun install --frozen-lockfile
bun run check
```

Initialize a run without connecting anywhere:

```powershell
bun run reconcile init --run rehearsal-001 --rezics-ref v1.7.0 --cutoff 2026-09-02T16:00:00.000Z
bun run reconcile status --run rehearsal-001
bun run reconcile audit --run rehearsal-001
```

Use `--after-run <run-id>` on `init` when a fresh policy run must begin after a validated online
packet cursor from an earlier run. Only the cursor is carried forward; earlier decisions and
evidence remain in the predecessor run.

Run a fresh full-corpus Luna reconciliation with bounded inference concurrency:

```powershell
bun run reconcile init --run full-online-luna-v6-20260904 --rezics-ref v1.7.0 --cutoff 2026-09-02T16:00:00.000Z --online-batch-size 256 --worker-protocol full-online-luna-v6
bun run reconcile work --run full-online-luna-v6-20260904 --concurrency 128 --packets-per-worker 4 --max-attempts 5
```

Do not use `--after-run` when replacing an untrusted predecessor. There is deliberately no
`--target` or count limit on `work`; concurrency is bounded independently from total work. Luna
workers explicitly use ChatGPT authentication, standard (non-Fast) service, medium reasoning,
and no tools; they do not inherit the operator's model, Fast, plugin, or MCP configuration. `work`
fails before capture when the run is not pinned to the current worker protocol.

New runs default to 64 sources per database page; the current production run uses the proven
256-source page. Set `init --online-batch-size N` (1–256) to choose a persisted page size. The full
worker pipelines at most eight parts, classifies 20 packets per guarded request, sends fallback
work to four-packet full decisions, and caps all model requests at 128. Existing runs retain their
original size; database concurrency remains one. The [Linux runbook](./docs/runbook.md#linux-full-run)
covers execution on a separate host.

Database commands accept either `REZICS_DATABASE_SECRET_FILE` or a dedicated
`REZICS_DATABASE_READONLY_URL`, never both. With the secret document, the runner can reach a
private PostgreSQL listener through a loopback-only SSH stdio bridge without exposing PostgreSQL,
using SSH port forwarding, or changing the server. Run `bun run reconcile doctor` before a run.
After doctor passes, `probe --run ID` measures one bounded page and sanitized query plans without
persisting evidence, advancing the cursor, or invoking a model.

The monitoring profile is the default. If an operator explicitly selects the runtime profile
because monitoring lacks catalog access, the runner requires PostgreSQL connection-startup
`default_transaction_read_only=on` and a repeatable-read, read-only transaction for every batch.
The live doctor proves both guards and reports whether the credential itself is privileged;
credentials are never printed.

For a model-independent bounded pilot, use
[`prompts/1000-book-rehearsal.md`](./prompts/1000-book-rehearsal.md). The count limits durable
source decisions. It does not trigger a full-catalog export.

No command named `apply` exists in this repository.

## External reference

The read path follows PostgreSQL read-only transaction semantics and keyset pagination. See the
official [PostgreSQL transaction documentation](https://www.postgresql.org/docs/current/sql-set-transaction.html).
