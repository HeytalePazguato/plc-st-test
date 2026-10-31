# plc-st-test GitHub Action

Runs the [plc-st-test](https://github.com/HeytalePazguato/plc-st-test) unit tests for IEC 61131-3 Structured Text in a workflow. The action sits at the repository root (`action.yml`), as the Marketplace requires, and runs the CLI version that matches the tag you reference.

```yaml
jobs:
  plc-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: HeytalePazguato/plc-st-test@v0
        with:
          path: .
```

Failed tests show up as annotations on the pull request (the `github` reporter), the job summary lists the totals, and the report directory is uploaded as an artifact. The step fails with the CLI's exit code: 1 when a test failed or errored, 2 on a config, ingest, parse or plugin error.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `path` | `.` | Project directory to test. |
| `config` | `''` | Config file, relative to the workspace. |
| `project` | `''` | Project file to use, relative to `path`. |
| `reporters` | `github,junit,terminal` | Comma-separated reporters. `json` is always added, since the outputs come from `results.json`. |
| `out-dir` | `plc-st-test-results` | Report directory, relative to the workspace. |
| `coverage` | `'false'` | Collect branch coverage. |
| `node-version` | `'26'` | Node.js version for the CLI (24 or newer). |
| `upload-artifact` | `'true'` | Upload the report directory. |
| `artifact-name` | `''` | Artifact name; empty derives `plc-st-test-results-<os>-<job>`. Set one per use when the action runs more than once in a job or matrix leg. |

## Outputs

| Output | Meaning |
| --- | --- |
| `passed` | Passed tests. |
| `failed` | Failed plus errored tests. |
| `total` | All tests. |
| `exit-code` | The CLI's exit code. |

`passed`, `failed` and `total` are empty when the CLI wrote no `results.json` (exit 2); the outputs step never fails for that reason, and the action still fails with the CLI's exit code.

## Test-only: `PLC_ST_TEST_LOCAL_CLI`

When the environment variable `PLC_ST_TEST_LOCAL_CLI` is set to the path of a built `cli.js`, the action runs `node $PLC_ST_TEST_LOCAL_CLI` instead of `npx plc-st-test@<version>`. The repository's own end-to-end workflow uses it to test the action before the CLI is published. Do not set it in normal workflows.
