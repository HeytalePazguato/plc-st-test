# Ingestor contract

An ingestor turns a vendor project on disk into the vendor-neutral `Project` model from `@plc-st/project-model`. The interface is `Ingestor` in `@plc-st/plugin-api` (see [plugin-api.md](plugin-api.md)). Core calls `detect` to find candidate projects under a repository root, then calls `load` on the candidate the user selects (or the only one found).

## detect

`detect(root: string, fs: SafeFsLike): Promise<DetectCandidate[]>`

- `root` is the repository root. `fs` is the root-confined file system; the ingestor must use it for every read and must not use `node:fs` directly.
- It returns zero or more candidates. An empty array means "this ingestor does not recognise anything here", which is not an error.
- Each candidate has `ingestorId` (the ingestor's `id`), `projectFile` (the file that defines the project, relative to `root`), a `label` for display, and a `confidence` value.
- `detect` should be cheap: list directories and check for marker files, and do not parse every vendor file.

### Confidence scale

`confidence` is a number from 0 to 1. The type only enforces `number`; the range is a convention that ingestors must follow:

- **1.0** means a definitive project file. The file is the vendor's own project container (for example a TwinCAT `.tsproj` or a B&R project file) and its presence is conclusive.
- **0.5** means a heuristic match. For example, a folder that contains `.TcPOU` files but no project container, or a directory layout that merely looks like a vendor project.
- Values in between are allowed for finer distinctions, but ingestors should use these two anchors and not invent others.

Core receives all candidates from every installed ingestor; choosing among them is the host's job, and an ingestor should not rely on any particular tie-break rule.

## load

`load(candidate: DetectCandidate, opts: IngestOptions): Promise<Project>`

`load` reads the project and returns a `Project` (see `Project`, `SourceUnit`, and `LibraryRef` in `@plc-st/project-model`). It is the only place where vendor file formats are parsed.

- `opts.root` and `opts.fs` have the same meaning as in `detect`.
- `opts.testsFolder` defaults to `'Tests'`, and `opts.testPattern` defaults to `'TEST_*'`. See the Tests-folder convention below.
- `opts.defines` holds conditional-compilation symbols supplied by the user. Pass them to the dialect's `preprocess` hook; do not evaluate them yourself.
- The returned `Project` records `vendor`, `dialect`, `name`, `root`, and `projectFile`. Problems that do not stop loading go into `warnings` as `{ code, message, location? }`. Problems that stop loading throw.

## Tests-folder convention

Test units are recognised by where they live, not only by their name:

- A POU is a test unit (`SourceUnit.isTest === true`) when it sits under the folder named by `testsFolder` (default `Tests`) or its name matches `testPattern` (default `TEST_*`). Ingestors set `isTest` accordingly.
- Non-test units are program or library code. Suite discovery considers only units with `isTest === true`.
- The name match is case-sensitive or case-insensitive according to the dialect's `caseSensitive` setting.

## SourceMap requirement

Every `SourceUnit` has `text` (generated ST) and `map: SourceMap`. The contract is:

- **Every line of `text` must map to a line of an original file.** `SourceMap.map(genLine, genCol)` must return a real file for every generated line that a diagnostic or result can point at. A line that falls outside every segment resolves to the sentinel file `<generated>`, which is only acceptable for synthesised glue code that never appears in a diagnostic. Ingestors should avoid generating such lines.
- Segments are built with `SourceMap.add` (or `SourceMap.identity` for a unit that is a verbatim copy of one file). Overlapping segments throw.
- A dialect's `preprocess` hook MUST keep the line count unchanged, otherwise the map drifts.
- Positions are 1-based; the column offset applies only to the first line of a segment.

## File access is SafeFs-only

Ingestors read files only through `SafeFsLike` (implemented by `SafeFs` in `@plc-st/project-model`):

- `resolve` confines every path to the project root, including `..` traversal, absolute paths, and symlinks that point outside. It throws `ConfinementError` on escape.
- `readText` enforces a maximum file size (16 MiB by default; `FileTooLargeError` above that), strips a UTF-8 BOM, and falls back to latin1 when a file is not valid UTF-8.
- `exists` and `list` follow the same confinement rules.

Do not use `node:fs`, `process.cwd()`, or absolute paths from vendor files to read anything. Vendor files can reference paths (for example library references); resolve them with `fs.resolve(p, from)` where `from` is the directory of the referencing file.

## Action units with owner

A classic-style ACTION (B&R programs, TwinCAT POU actions) is its own `SourceUnit` with:

- `role: 'action'`
- `owner: string`, the name of the POU that owns the action (for example `FB_Conveyor`)
- `name: string`, the action name (for example `Reset`)

Other roles (`pou`, `types`, `globals`) must not set `owner` or `name`. Core uses `owner` to attach the action to its POU in the symbol table, so an action unit without an `owner` cannot be resolved.

## Related

- [plugin-api.md](plugin-api.md) for the `Ingestor`, `DetectCandidate`, and `IngestOptions` type definitions.
- [results-schema.md](results-schema.md) for the output format that runs produce.
