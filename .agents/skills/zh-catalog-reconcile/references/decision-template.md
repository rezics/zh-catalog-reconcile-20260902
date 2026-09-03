# Decision template

Use one object per source Unit. `record` accepts a JSON array, one JSON object, or NDJSON.

## Common fields

```json
{
  "schemaVersion": 1,
  "runId": "prod-20260902",
  "part": 12,
  "packetId": "<64 lowercase hex>",
  "inputHash": "<64 lowercase hex>",
  "sourceUnitId": "<UUID>",
  "decidedAt": "2026-09-02T16:10:00.000Z",
  "actor": {
    "kind": "codex",
    "model": "<exact public model identity>",
    "promptRevision": "decision-policy-v3"
  }
}
```

Merge exactly one disposition shape into those identity fields. A routine `keep` is:

```json
{
  "confidence": "high",
  "reason": "distinct_work",
  "citations": [
    { "unitId": "<source UUID>", "field": "localization_title", "excerpt": "<title>" },
    {
      "unitId": "<source UUID>",
      "field": "localization_description",
      "excerpt": "<short exact synopsis excerpt>"
    }
  ],
  "disposition": "keep",
  "basis": [
    { "code": "booklike_title", "citationIndexes": [0] },
    { "code": "synopsis_describes_work", "citationIndexes": [1] }
  ]
}
```

```json
{
  "confidence": "high",
  "reason": "duplicate_identity",
  "citations": [
    { "unitId": "<source UUID>", "field": "localization_title", "excerpt": "<source title>" },
    { "unitId": "<target UUID>", "field": "localization_title", "excerpt": "<target title>" },
    { "unitId": "<source UUID>", "field": "attribution", "excerpt": "<source author>" },
    { "unitId": "<target UUID>", "field": "attribution", "excerpt": "<target author>" }
  ],
  "disposition": "merge",
  "targetUnitId": "<candidate Book UUID>",
  "basis": [
    { "code": "same_title", "citationIndexes": [0, 1] },
    { "code": "same_attribution", "citationIndexes": [2, 3] }
  ]
}
```

```json
{
  "confidence": "high",
  "reason": "query_fragment",
  "citations": [
    { "unitId": "<source UUID>", "field": "localization_title", "excerpt": "<query-like title>" }
  ],
  "disposition": "soft_delete",
  "basis": [{ "code": "query_like_title", "citationIndexes": [0] }]
}
```

```json
{
  "confidence": "medium",
  "reason": "wrong_attribution",
  "citations": [
    { "unitId": "<source UUID>", "field": "attribution", "excerpt": "<wrong credit>" },
    { "unitId": "<candidate UUID>", "field": "attribution", "excerpt": "<supported credit>" }
  ],
  "disposition": "revise",
  "basis": [
    { "code": "attribution_correction_supported", "citationIndexes": [0, 1] }
  ],
  "patches": [
    {
      "kind": "credit_replacement",
      "role": "author",
      "removeAttributionId": "<stored attribution UUID or null>",
      "creditedUnitId": "<credited Unit UUID visible in packet>",
      "evidenceUnitIds": ["<Book or credited Unit UUID>"]
    }
  ]
}
```

```json
{
  "confidence": "low",
  "reason": "insufficient_evidence",
  "citations": [
    { "unitId": "<source UUID>", "field": "localization_title", "excerpt": "<source title>" },
    { "unitId": "<candidate UUID>", "field": "localization_title", "excerpt": "<candidate title>" },
    { "unitId": "<source UUID>", "field": "attribution", "excerpt": "<source author>" },
    { "unitId": "<candidate UUID>", "field": "attribution", "excerpt": "<candidate author>" }
  ],
  "disposition": "review",
  "uncertainties": [
    {
      "kind": "candidate_identity_ambiguous",
      "citationIndexes": [0, 1, 2, 3],
      "relatedUnitIds": ["<candidate UUID>"]
    }
  ]
}
```

Allowed reasons and basis codes are defined in `schemas/source-decision.schema.json`. Copy packet
identity fields; never retype them from memory. Citation excerpts must occur in their named stored
fields. Every citation index is zero-based and must refer to a citation that supports that exact
claim or uncertainty. Do not add `explanation` or top-level `evidenceUnitIds`. Add `note` only when
using an explicit `other` reason or uncertainty. A revision value must be directly supported by
stored packet evidence. The validator checks structure, grounding, and evidence membership;
semantic truth remains the reviewer and canary evaluation's responsibility.
