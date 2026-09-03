# Architecture

```text
AI requests `next`
        │
        ├── undecided local packet exists ───────────────┐
        │                                                │
        └── none exists                                  │
             │                                           │
             ▼                                           │
      short read-only production transaction             │
             │                                           │
             ├── exact-zh source keyset page             │
             ├── bounded REZICS candidate searches       │
             └── evidence for returned Unit IDs only     │
             │                                           │
             ▼                                           │
      atomic packets/part-*.jsonl ◄──────────────────────┘
             │ transaction already closed
             ▼
      AI decision → validated append-only decision
             │
             ▼
      complete manifest ──╳── no production writer here
```

## Online instead of a local catalog copy

The full-run `work` command preserves a single capture/write path and fans out only model
inference. One coordinator pipelines at most eight persisted packet parts, performs guarded
20-source semantic classification, splits every fallback into four-packet work items, runs ephemeral
Luna processes concurrently behind one 128-request semaphore, validates returned proposals per
source, and records each completed part through one writer. Workers cannot choose run IDs, packet
hashes, timestamps, or actor
identity. Each worker runs with isolated Codex user configuration, ChatGPT-only authentication,
standard (non-Fast) service, no project instructions, and disabled shell, browsing, app/plugin,
and subagent tools, so it cannot inherit the operator's plugins, MCP servers, model, or Fast
setting.

Workers attach each exact citation directly to the typed basis or uncertainty it supports. The
coordinator deterministically deduplicates citations and assigns the zero-based indexes used by
the persisted decision schema. Workers never manage a separate citation array, so an unlinked
citation cannot cross the proposal boundary. The v6 full-decision prompt renders the same basis claim contract
used by deterministic validation, including allowed fields and required source, target, or
non-source-candidate roles. Validation failures are retried with a bounded typed category and
issue code; the feedback never changes a disposition or substitutes deterministic catalog
heuristics. A terminal worker failure records only bounded failure and feedback codes, part
number, and request count; raw prompts, responses, Unit IDs, and citation excerpts are not logged,
persisted, or printed. For a keep proposal, the coordinator may restore the unique equal-length
stored source title selected by `booklike_title` and propagate the exact substitution to title
citations in that proposal; other title citations require a unique one-character near match. It
then runs the unchanged validator. The near match may be one insertion, deletion, or substitution.
Stored synopsis text may support a title-variant claim only
when the text itself states the alternate title. A target title can prove the variant when it
contains the cited source title.
Duplicate validation also accepts a matching synopsis excerpt of at least 64 normalized
characters, or matching synopsis and attribution, when titles differ. Revision values may be linked to a stored identity excerpt that
contains the replacement value, and non-Book uncertainty may retain contradictory source Book
evidence instead of discarding it to satisfy the output shape.
Citation comparison ignores formatting whitespace. An out-of-packet merge target transcription is
replaced only when the proposal's non-source basis citations identify exactly one packet candidate,
after which the ordinary binding and claim validation still applies.
A `same_synopsis` citation of at least 64 normalized characters may be restored to a unique
same-field stored value only when exactly one character differs.
If one redundant basis is invalid, the coordinator searches bounded non-empty basis subsets and
retains a subset only when the complete validator accepts the resulting unchanged disposition.
If a semantic part still exhausts its attempts, its successful decisions remain appended and the
part is deferred while independent parts continue; the original failure is emitted at corpus end.

The runner never exports all Books. It uses the live REZICS database throughout the entire task,
not only during a rehearsal. A fixed creation cutoff keeps the source population bounded, while
each packet captures the current source/candidate state and `updatedAt` values. Later mutation
preflight rejects stale evidence.

Persisted packets are the precise input shown to the model. They are necessary for validation,
audit, and deterministic resume, but they are not a database mirror: only selected exact-`zh`
sources and bounded search candidates appear. Packet evidence is parsed and hashed before it
crosses the database/model boundary.

## Query shape

Source traversal uses `(created_at, id)` keyset pagination and the public-Book partial index. The
exact-language proof uses the `unit_localization` primary key and language index. Candidate IDs
come from the existing bounded `search_text_candidates` function with `unit_kind = 'book'`, a
language boundary, a posting budget, and a result limit. A single SQL statement invokes that
function laterally for all sources in the page, avoiding client N+1 round trips. Evidence loading
then uses one bounded ID set and indexed relationships.

Candidate Unit-eligibility and Book-subtype proofs each use a parameterized lateral ID lookup
with `LIMIT 1`. The limits preserve unique-key semantics while preventing flattening into merge
joins that walk whole Unit or Book indexes. The read-only `probe` checks scan traversal, including
filtered-out rows, against the bounded candidate count and emits sanitized timing and plan nodes.
This follows PostgreSQL's [lateral evaluation semantics](https://www.postgresql.org/docs/current/queries-table-expressions.html#QUERIES-LATERAL)
and is verified with [EXPLAIN ANALYZE](https://www.postgresql.org/docs/current/using-explain.html).

Every page runs in a repeatable-read, read-only transaction with a statement timeout. The
transaction ends before packet persistence and model inference.

## Crash and concurrency behavior

Each newly fetched database page becomes a new sequential packet-part file written through a
temporary file and atomic rename. The checkpoint is written afterward. On resume, packet parts
are validated in strict source order and the cursor/count is reconstructed from them. Therefore a
crash after the part rename but before checkpoint replacement advances safely without appending
the page again.

A run-wide capture lock prevents two `next` calls from fetching the same cursor concurrently.
Decision files remain append-only and retain their existing per-part lock.

A separate orchestration lock prevents two full-run coordinators from sharing one run. Completed
decision parts advance an atomic decision checkpoint, so normal pending lookup reads only the
current part rather than rescanning growing history. Packet capture trusts its atomic checkpoint
on the hot path and performs a full reconstruction at startup, after a detected part/checkpoint
crash gap, and at explicit verification boundaries. A hard-killed process can leave a lock; verify
its recorded PID is no longer alive before removing that exact lock. Never remove a live lock.

## Production read transport

The SSH stdio transport supports deployments where PostgreSQL is reachable from an authorized
SSH host but not directly from the operator workstation, including hosts where OpenSSH TCP
forwarding is unavailable. The runner opens an ephemeral listener bound only to local
`127.0.0.1`, runs the host's existing `nc` against the private database endpoint, and relays raw
PostgreSQL bytes over SSH stdin/stdout.

SSH uses the operator key selected by the secret document, strict host-key checking, batch mode,
no requested TTY, and cleared forwarding directives. Optional source-interface binding handles
operator workstations with an alternate default route. No server package, route, firewall rule,
SSH setting, database listener, or role is changed.

Least-privilege credentials must have no write grants on reconciliation relations. A configured
runtime-profile fallback retains its existing grants, so the runner additionally sets the session
default to read-only during PostgreSQL startup. Every transaction independently declares itself
repeatable-read and read-only before its first query. A live proof fails closed if either guard is
absent.

## Why both a plan and a Skill

`PLAN.md` defines scope, gates, rollout, and authority. The Skill defines the resumable AI
procedure. Deterministic code owns database access, parsing, hashing, keysets, packet persistence,
coverage, idempotency, and action compilation; the model owns only bounded semantic judgments.

## Scaling

The local runner applies backpressure with an eight-part active window; capture can overlap model
inference but never grows into a catalog snapshot. At hundreds of millions of sources, partition the creation keyspace, run multiple
rate-limited workers, and replace repo-local packet parts with durable object storage. Do not turn
the online design back into a complete local export to scale it.

New runs default to 64 one-source packets per page; the current production run uses the probed
256-source page. Initialization accepts page sizes from 1 to 256; old runs retain their persisted
size. Guarded classification uses at most 64 of the shared 128 request slots, full decisions use groups of four,
and no more than eight parts are active. Capture remains one short transaction at a time and is
never multiplied by inference concurrency. Process memory, rate limits, capture latency, and tail
requests still determine sustained throughput; configured parallelism is not a proportional
speedup guarantee.
