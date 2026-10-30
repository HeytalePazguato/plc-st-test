# Results schema v1

Every run produces a results document of type `RunResultsV1`. The machine-readable JSON Schema is shipped in the package as `@plc-st/plugin-api/schema/results-v1.schema.json` with `$id` `https://plc-st.dev/schemas/results-v1.json`. The TypeScript type and the hand-written validator `validateResultsV1` (both in `@plc-st/plugin-api`) must agree with it; a test in the package checks that every property in the type appears in the schema. Reporters receive the document in `onRunEnd` (see [plugin-api.md](plugin-api.md)).

## Stability promise

Within schema v1, changes are **additive and optional only**: a new field may be added only if it is optional, and existing fields keep their names, types, and meaning. Consumers can rely on that. A breaking change (renaming or removing a field, making an optional field required, changing a type or an enum) requires `schemaVersion: 2`. Consumers should ignore unknown properties.

Note that the JSON Schema for v1 sets `additionalProperties: false` at every level, so the validator rejects unknown keys today. Adding an optional field therefore means updating the schema and the validator together in the same release.

## Top-level fields

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `schemaVersion` | `1` (literal) | yes | Always `1` for this schema. |
| `tool` | object | yes | The runner that produced the document. |
| `project` | object | yes | The project that was run. |
| `startedAt` | string, ISO 8601 date-time | yes | When the run started. |
| `durationMs` | number, ≥ 0 | yes | Total run duration in milliseconds. |
| `summary` | object | yes | Counts across all tests. |
| `suites` | array of suite | yes | Results grouped by suite. |
| `warnings` | array of warning | yes | Run-level warnings (may be empty). |
| `coverage` | object | no | Branch-coverage summary, present only when coverage was collected. |

### `tool`

- `name: string`
- `version: string`

### `project`

- `vendor: string`, for example `standard`, `twincat`, or `br`.
- `dialect: string`
- `name: string`
- `projectFile: string`

### `summary`

Five non-negative integers: `total`, `passed`, `failed`, `errored`, `skipped`.

### `warnings`

Each item has:

- `code: string`
- `message: string`
- `location?: Location` (optional)

## Suite

- `name: string`
- `location: Location`
- `durationMs: number`, ≥ 0
- `tests: Test[]`

## Test

- `name: string`
- `fullName: string`, `Suite.Test` or `Suite.Test[row_i]` for data-driven rows.
- `status: 'passed' | 'failed' | 'errored' | 'skipped'`
- `durationMs: number`, ≥ 0
- `location: Location`
- `failure?: Failure` (optional, present for failed or errored tests)

### Failure

- `kind: 'assertion' | 'runtime' | 'timeout' | 'limit'`
- `message: string`
- `expected?: string`
- `actual?: string`
- `location: Location`

## Location

An original-file position. All fields are non-negative integers for `line` and `col` (1-based in practice, as produced by `SourceMap`):

- `file: string`
- `line: integer`
- `col: integer`

## Coverage (optional)

- `branchesTotal: integer`
- `branchesHit: integer`
- `pous: Pou[]`

Each `Pou` has `name: string`, `file: string`, `branchesTotal: integer`, `branchesHit: integer`, and `missed: { line: integer; kind: string }[]`.

## Example

```json
{
  "schemaVersion": 1,
  "tool": { "name": "plc-st-test", "version": "0.0.0" },
  "project": { "vendor": "standard", "dialect": "standard", "name": "Demo", "projectFile": "demo.plcproj" },
  "startedAt": "2026-10-29T10:00:00.000Z",
  "durationMs": 12,
  "summary": { "total": 1, "passed": 0, "failed": 1, "errored": 0, "skipped": 0 },
  "suites": [
    {
      "name": "TEST_Counter",
      "location": { "file": "Tests/TEST_Counter.st", "line": 1, "col": 1 },
      "durationMs": 12,
      "tests": [
        {
          "name": "Increment",
          "fullName": "TEST_Counter.Increment",
          "status": "failed",
          "durationMs": 12,
          "location": { "file": "Tests/TEST_Counter.st", "line": 4, "col": 5 },
          "failure": {
            "kind": "assertion",
            "message": "expected cnt = 2",
            "expected": "2",
            "actual": "1",
            "location": { "file": "Tests/TEST_Counter.st", "line": 9, "col": 5 }
          }
        }
      ]
    }
  ],
  "warnings": []
}
```
