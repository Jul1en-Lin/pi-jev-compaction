# pi-jev-compaction

A [Pi](https://github.com/badlogic/pi-mono) extension that uses
[`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction) to
prune stale tool calls immediately before Pi creates its native compaction
summary.

This package is a Pi adapter, not a replacement for Pi's compaction system.
Jev makes the keep/drop/truncate decisions; Pi still creates the summary,
compaction entry, file-operation details, and retained recent context.

## How it works

For both manual `/compact` and automatic compaction:

```text
Pi prepares a compaction
        |
        v
session_before_compact
        |
        v
Jev reviews eligible tool call/result pairs
        |
        +-- success --> replace only the two native message arrays
        |                 |
        |                 v
        |            Pi's native compact()
        |
        +-- timeout/error/invalid response --> leave preparation unchanged
                                              |
                                              v
                                         Pi's native compact()
```

The adapter preserves Pi's native messages instead of serializing Jev's
simplified transcript back into Pi. It only changes:

- `messagesToSummarize`
- `turnPrefixMessages`

All other compaction metadata remains owned by Pi, including
`firstKeptEntryId`, `tokensBefore`, `previousSummary`, `fileOps`, `settings`,
and `isSplitTurn`.

### What Jev can change

Only a paired, text-only tool call and tool result within the same native
compaction input are eligible. The adapter leaves these untouched:

- user and assistant prose;
- thinking blocks and image content;
- image-bearing tool results;
- incomplete or duplicate call/result pairs;
- pairs crossing the two native input boundaries;
- Pi's separately retained recent region;
- tool results without a valid matching call.

A `drop_call` decision removes the call and its paired result. A
`drop_result` decision keeps the call and truncates the result using the
upstream default of 300 head characters plus a note. Pi then summarizes the
filtered native messages normally.

## Compatibility

- Pi `0.85.1`
- Node.js `>=24`
- `fast-jev-compaction` `0.4.0`

The extension intentionally has a strict Pi `0.85.1` guard. The adapter relies
on the mutable `session_before_compact` preparation object used by that Pi
release; this is not currently a formal extension API for replacing the
native preparation arrays. On another Pi version, the extension does not
modify the preparation and Pi falls back to ordinary native compaction.

This package does not modify Pi's source code or call Pi's exported
`compact()` function itself.

## Installation

Install from the GitHub repository:

```sh
pi install git:github.com/Jul1en-Lin/pi-jev-compaction@main
```

Or install the current checkout for local development:

```sh
pi install /Users/lien/prj/pi-fast-jev-compaction
```

Restart Pi after installation. Check the installed packages with:

```sh
pi list
```

To remove the GitHub installation:

```sh
pi remove git:github.com/Jul1en-Lin/pi-jev-compaction
```

## Configuration

The extension uses the official TypeSafe Jev endpoint through the upstream
package. Configure the key in the environment of the terminal that starts
Pi:

```sh
export TYPESAFE_API_KEY='your-typesafe-key'
```

The key is read at runtime, sent only in the authenticated Jev request, and
never written to the package, Pi settings, session files, or extension logs.
Do not commit it or paste it into a shared shell history.

The complete Jev decision state can contain conversation text and tool input,
which may include source code, file paths, commands, or other sensitive data.
Use this extension only when sending that information to TypeSafe is
acceptable.

### Timeout

`PI_FAST_JEV_TIMEOUT_MS` controls the whole Jev attempt and defaults to
15,000 milliseconds:

```sh
export PI_FAST_JEV_TIMEOUT_MS=15000
```

If the key is missing, Pi is an unsupported version, Jev times out, the
request fails, or the response is invalid, the adapter prints a short warning
and leaves the original preparation untouched. Pi then performs its ordinary
native compaction. It does not invoke `/compact` recursively.

A user cancellation is passed through to the Jev request and does not replace
or modify the native preparation.

## Notices in Pi

Normal path:

```text
[jev] 21 call(s) reviewed: dropped 18, shortened 0 · 955ms; Pi will create the native summary.
```

No useful changes:

```text
[jev] 12 call(s) reviewed: nothing dropped · 301ms; Pi will create the native summary.
```

Fallback examples:

```text
[jev] skipped: TYPESAFE_API_KEY is not set; using Pi's native compaction.
[jev] timed out after 15000ms · 15.0s; using Pi's native compaction.
[jev] failed · 802ms; using Pi's native compaction.
```

These notices are transient TUI notifications. The extension does not write
request content or API errors to disk.

## Development

Install dependencies without running lifecycle scripts:

```sh
npm install --ignore-scripts --no-audit --no-fund
```

Run the checks:

```sh
npm run typecheck
npm test
```

The tests use injected Jev askers and timers. They do not call TypeSafe or a
main model. The test suite covers message mapping, tool-call/result pairing,
image and thinking preservation, split preparation inputs, timeout and
cancellation, native fallback, and Pi hook behavior.

Build the package:

```sh
npm run build
```

Create a local npm tarball without publishing it:

```sh
npm pack --ignore-scripts
```

## Project layout

```text
extensions/fast-jev-compaction.ts  Pi lifecycle hook
src/adapter.ts                     Jev transport and native-message adapter
test/                              Offline tests
package.json                       Pi package manifest and pinned dependency
```

## Acknowledgements and attribution

This adapter is built on and gratefully acknowledges
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) by
[Tamara Tran](https://github.com/tamaratran). The upstream project provides
the Jev decision logic that this Pi adapter integrates with native Pi
compaction.

If you believe this repository contains material that infringes your rights,
or if attribution needs to be corrected, please contact the maintainer by
opening an issue at
[github.com/Jul1en-Lin/pi-jev-compaction/issues](https://github.com/Jul1en-Lin/pi-jev-compaction/issues).
We will review the request and remove or revise the affected material where
appropriate.

## License

This adapter is licensed under the MIT License. Please also review the
upstream project's license and attribution:
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction).
