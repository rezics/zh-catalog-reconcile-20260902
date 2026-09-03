# Production reconciliation plan

Status: **prepared; production reads allowed only through the guarded runner; writes not authorized**

Owner repository: `rezics/zh-catalog-reconcile-20260902`

Production contract observed: REZICS server `v1.7.0` surface on 2026-09-02; verify the immutable
server image digest and database migration head again before any apply phase.

## Objective

Reconcile published REZICS Books whose current complete metadata-localization language set is
exactly `{zh}`. Preserve real works, merge duplicate identities, soft-delete records that are not
Books, and propose evidence-backed metadata or attribution revisions. Read sources and candidates
online from REZICS; do not retrieve external metadata or copy the complete catalog locally.

## Invariants

1. A mutation source has exactly one distinct localization language, `zh`, when its packet is read.
2. A Unit with `ja` or any non-`zh` localization is protected. It may only be a merge target.
3. Selection uses `unit_localization.language`, never `contentLanguageSupport` or title script.
4. Every decision is bound to an immutable evidence packet hash and source `updatedAt`.
5. AI text is untrusted until it passes the generated runtime schema and semantic validator.
6. A merge target must occur in the packet's REZICS-derived online candidate set.
7. Unknown evidence produces `review`, not an invented correction.
8. Duplicate identities use Unit Merge. Non-Book junk uses Unit lifecycle soft-delete. Catalog
   quality errors do not use moderation removal.
9. Production writes use REZICS domain services and governance audit records, never ad hoc SQL.
10. This repository stops after a validated, complete action manifest.

## Phase 0 — freeze the run contract

- Record the deployed server image digest, root release tag, database migration head, creation
  cutoff, operator identity, model identity, prompt revision, and repository commit in `run.json`.
- Require `decisionPolicyRevision: "evidence-claims-v3"` for every new decision-producing run.
  Runs without that field are interpreted as `legacy-v1`; `evidence-grounded-v2` and `legacy-v1`
  runs remain available for audit but cannot be resumed or used to generate a manifest. Start a
  new run rather than rewriting their JSONL.
- Require `evidenceMode: "online-batched"`. Legacy runs without this field are incompatible and
  must not be resumed.
- Prefer a dedicated database role with `CONNECT`, catalog `SELECT`, and permission to execute the
  bounded REZICS candidate-search function. The monitoring profile is the default. If it lacks
  catalog access, an operator may explicitly select the existing runtime profile only through
  this runner: require connection-startup `default_transaction_read_only=on`, issue a
  repeatable-read, read-only transaction for every batch, and prove both settings live. Never use
  `DATABASE_ADMIN_URL`.
- Run `bun run reconcile doctor`, `bun run check`, and the repository Skill validator.
- Confirm `.env` and the run directory are ignored by Git.

Stop if the live production relations, candidate-search signature, or runtime schemas differ from
the query contract in `sql/`.

## Phase 1 — online inventory

Run the one-time aggregate inventory in a read-only transaction. Record:

- public, approved, active Book count created by the cutoff;
- current exact-`zh` source count;
- Books currently containing `ja`;
- Books with no localization;
- current localization-language-set distribution;
- earliest/latest source creation timestamps.

Inventory is a planning count, not a catalog export. Stop on proof failure, schema drift, or an
exact-`zh` count of zero.

## Phase 2 — online evidence and decisions

Repeat `next` and `record` until the online source cursor is complete:

1. Return already-persisted undecided packets before touching production.
2. When none remain, select at most `onlineBatchSize` exact-`zh` sources using the indexed
   `(created_at, id)` keyset and the immutable creation cutoff.
3. In the same short transaction, use the existing bounded REZICS text search to obtain Book
   candidate IDs for each source. Batch the calls in one database round trip; never issue an
   application-level N+1 sequence.
4. Read full metadata and credit evidence only for the selected sources and candidate IDs.
5. Parse database results through `BookEvidenceSchema`, compute `evidenceHash`, close the
   transaction, and atomically write one packet-part file.
6. Let the AI decide only after the database transaction has closed. Append validated decisions
   through `record`.

Each packet currently contains one source and at most `maxCandidatesPerPacket` total Books. The
source is always included. Candidate ranking may prefer multilingual/`ja` records, identifiers,
richer metadata, and older stable records, but ranking never makes a decision.

There is no `snapshot` command and no `snapshot/books.jsonl`. The durable artifacts are only the
evidence packets actually presented to the model, their cursor/checkpoint, decisions, and logs.
Part files are created atomically. On resume, the runner reconstructs source count and cursor from
validated parts, so a crash between a part rename and checkpoint update does not duplicate rows.
A run-wide capture lock rejects concurrent `next` fetches.

## Phase 3 — AI decision policy

Use the repository Skill and [`docs/decision-policy.md`](./docs/decision-policy.md). For every
source choose exactly one:

- `keep`
- `merge`
- `soft_delete`
- `revise`
- `review`

The model receives only packet evidence. It must not browse or call a third-party metadata API.
Record the exact public model/version identity and prompt revision.

Quality gates:

- schema-invalid decision rate: 0%;
- every decision cites exact stored packet evidence;
- every routine action uses typed English basis codes, each linked to compatible citations;
- every `keep` cites a Book-like title plus synopsis, attribution, or identifier corroboration;
- every `merge` cites a shared identifier or title correspondence plus synopsis or attribution;
- every `review` records typed uncertainties linked to source and related-candidate citations;
- free-form notes occur only for an explicit `other` reason or uncertainty;
- legacy repeated or evidence-substituted explanation templates: 0;
- a complete part containing only low-confidence `insufficient_evidence` reviews pauses the run;
- decision coverage: exactly one per discovered source;
- non-`zh` mutation-source leakage: 0;
- merge target outside packet: 0;
- high-confidence canary disagreements during human review: below 2%;
- every `revise` patch names stored evidence and remains human-approved at apply time.

## Phase 4 — manifest generation

- Require the online source cursor to be complete and every discovered source to have one decision.
- Require `reports/decision-quality.json` to pass. Manifest compilation evaluates quality in the
  same streaming pass used to compile actions, so it does not add another whole-corpus scan.
- Compile decisions into typed actions with expected timestamps and deterministic idempotency keys.
- Produce no action for `keep` or `review`.
- Mark every revision proposal and medium/low-confidence mutation as requiring human approval.
- Produce counts by action, confidence, reason, protected-target use, and source creation window.

The completed manifest is the terminal output of this repository.

## Phase 5 — production apply (deliberately out of scope)

Before apply, add a release-reviewed maintenance command to the main REZICS repository. It must:

- parse these generated schemas;
- re-read each Unit and reject stale timestamps;
- re-prove exact-`zh` source eligibility at write time;
- map semantic reasons to current governance rule IDs;
- call the existing Unit Merge, revision/association, and platform soft-delete services;
- record the AI contribution Entity and all governance/audit identifiers;
- support dry-run, bounded canaries, idempotent retries, backpressure, pause, and restore;
- verify search projection convergence after each batch.

Production application requires new, explicit authorization after review of the manifest and the
REZICS-side executor. Approval of this plan is not approval to apply it.

## Rollout and rollback

1. Apply 100 reviewed actions from the 天蚕土豆 neighborhood.
2. Verify redirects, attributions, soft-delete visibility, revisions, search results, and audit.
3. Apply 1,000 actions with write concurrency at most four and a lower database-pressure limit.
4. Continue by manifest partition while monitoring error and staleness rates.
5. Pause on any invariant violation, more than 1% stale actions, or repeated service errors.

Soft-deletes are restored through Unit lifecycle. Incorrect merges require the REZICS merge
reversal/cutover procedure defined by the production executor; never repair them with manual SQL.

## Workload and capacity model

Current workload assumptions:

- roughly 100,000–150,000 exact-`zh` sources within roughly 400,000 public Books;
- one indexed source keyset scan across the run;
- one bounded PGroonga candidate lookup per source, issued in database batches rather than N+1
  client round trips;
- one bounded evidence query per batch using primary/foreign-key lookups;
- one short repeatable-read transaction per newly captured source batch;
- no database connection or transaction remains open during model inference;
- packet writes are immutable and apply backpressure naturally because only one undecided batch is
  fetched at a time.

At 500,000,000 sources, a batch size of 20 implies 25,000,000 batch transactions; at
3,000,000,000 it implies 150,000,000. A single workstation and repo-local packet directory are not
acceptable at those scales. Partition the `(created_at, id)` keyspace across independent workers,
store immutable packet parts in durable object storage, aggregate checkpoints externally, and
rate-limit candidate searches per database shard. Increase database batch size only after
representative `EXPLAIN (ANALYZE, BUFFERS)` and latency measurements; do not hold transactions open
to amortize AI latency. Packet hashes and source keysets remain compatible with that cutover.

The limiting resource at those scales is the one-candidate-search-per-source workload, followed by
model inference and packet storage. Observable thresholds are candidate-search p95 latency,
estimated-postings fallback rate, database CPU/read IOPS, transaction timeout rate, packet-store
growth, and decision backlog. Pause capture when these exceed the approved operating envelope.

For the current task, online batches keep database work bounded and eliminate the unnecessary
complete local catalog copy.

Decision validation keeps at most one packet part (100 sources maximum, 50 candidates per packet)
in memory. Recording checks only the affected part. `audit` is an optional streaming O(N) pass
with fixed-size counters and at most 100 sampled issues; manifest generation performs the same
quality aggregation while already streaming decisions, not as a second pass. At 500,000,000 or
3,000,000,000 sources, audit and manifest work partition by packet-part range and aggregate their
fixed-size summaries alongside the packet-storage sharding described above.

The model no longer repeats natural-language explanations, source Unit IDs, and cited titles in
the same field. Basis codes and citation indexes keep routine output bounded while preserving the
full immutable packet and exact citation excerpts for audit.

## Completion criteria

Preparation is complete when repository checks pass, the Skill validates, fixture recovery tests
pass, and a live read-only canary creates bounded packets without a catalog export. Production
execution is complete only after the separately authorized apply and post-run verification.
