# PingRoom document redaction

Review supplied spans in a local plain-text document through PingRoom. One named
reviewer chooses **Mask**, **Keep**, or **Unknown** for each exact quote. After
all spans have valid Mask/Keep answers, code exports a separate copy using exact
source offsets. The original file stays unchanged.

This starter reviews only the spans you supply. It does not detect sensitive
content, prove a document is safe to publish, or remove other occurrences of the
same text. Review the entire document and exported copy before sharing either.

## Try it offline

Requires Node.js 22 or newer on macOS or Linux with private persistent storage.
Choose **Use this template**, clone your repository, then run:

```sh
npm ci
npm test
npm run demo
```

The demo masks a contact address and keeps a meeting point. A second run shows
Unknown withholding the export. Both use the real SDK with a local mock
transport: no credentials or network requests. Temporary demo state is removed.
Installation requires npm access.

## Prepare the document

```sh
cp examples/document.txt document.txt
cp examples/review.json review.json
cp config.example.json config.json
npm run plan
```

The manifest contains a document ID, title, SHA-256 of the exact UTF-8 file bytes,
and 1–12 spans sorted by their starting offsets:

```json
{
  "id": "contact",
  "start": 31,
  "end": 49,
  "quote": "robin@example.test"
}
```

Offsets are **zero-based UTF-16 code units**, with an inclusive `start` and
exclusive `end`, matching JavaScript `source.slice(start, end)`. They are not byte
positions, grapheme counts, or positions in a normalized copy. The exact `quote`
must match that slice. Adjacent spans are allowed; overlaps, nesting, duplicates,
reversed ranges, and offsets splitting a surrogate pair are rejected before any
API call. Combining sequences may span several code units; select the complete
intended text yourself.

To calculate the source hash without changing the file:

```sh
node --input-type=module -e "import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; console.log(createHash('sha256').update(readFileSync('document.txt')).digest('hex'))"
```

`plan` validates the document and manifest and prints the candidate quotes
locally. It makes no requests and changes no review state. Keep its output private.
Edit inputs before starting; changing the source, manifest, reviewer, room, or
connection after starting cannot reuse old decisions.

## Connect the reviewer

```sh
npm run connect
npm run inspect
```

Install [PingRoom](https://pingroom.io/i), approve the pairing link, and choose a
**standard private room** containing the reviewer. Grant `pingroom:rooms:read`,
`pingroom:questions:ask`, and access to that room. Normal permissions and quotas
apply. The reviewer may be the connecting account or another room member.

`inspect` lists member UUIDs and lookup names. Verify the intended person in the
app, then put their exact UUID and a local label in `config.json`. Names alone do
not establish identity. Questions include the raw candidate quote and document
title, so choose a room appropriate for that information. Give the reviewer
access to the original document through your existing private workflow for
context; this starter does not upload it.

Pairing saves `.pingroom/credentials.json` privately and reuses its saved link
while pending. Existing credentials are never overwritten. If pairing creation
is uncertain or expires, inspect Connected Agents and resolve or revoke the old
robot before archiving `.pingroom/pairing.json` for new setup. Keep
uncertain intent while investigating.

Alternatively, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and
`PINGROOM_ROOM`. A complete pair overrides saved credentials; partial or blank
pairs fail. Defining either shell variable selects the whole shell pair without
borrowing a value from `.env`. Paths resolve from the project directory.

## Review and export

```sh
npm start          # Ask the next span, or read the active Question once.
# Answer in PingRoom, then rerun:
npm start
npm run status     # Read saved evidence locally.
npm run report     # Write private report.json; export text only when complete.
```

Each invocation creates or reads at most one Question. Spans are asked in
manifest order, one at a time, with a 15-minute lifetime. There is no scheduler;
serialize invocations from your existing workflow.

Mask replaces that exact source interval with `[REDACTED]`. Keep retains the
original slice. All other source text, Unicode, line endings, and any UTF-8 BOM
are preserved without normalization. An Unknown, unasked, pending, expired,
cancelled, invalid, or uncertain result withholds the output. Other spans may
still be reviewed, but terminal requests are not reissued within the session.

A complete report contains the output SHA-256 and byte length. The `report`
command writes `.redaction/redacted.txt` as **plain text only**, without original
quotes or audit metadata appended. It also writes private `.redaction/report.json`
with decisions, Question IDs, responder identity, and timestamps. Status/step
results describe the prospective output; only a successful `report` export adds
`artifactFile`. If writing the JSON report fails after the text was written,
rerun `report` to recreate the identical text and audit report offline.

The source, manifest, local state, and PingRoom Questions still contain original
quotes. Masking an export does not erase that evidence. Share only the reviewed
text file when appropriate, never the entire private directory. Export replays
the saved reviews without checking current room access.

Exit codes for `start`/`recover`: `0` complete decisions; `2` incomplete review or
newly observed expired/cancelled/invalid answer; `3` ready/pending/interrupted;
`4` uncertain creation; `1` errors. Unknown may leave `ready` while other spans
remain; the final incomplete review exits `2`. Local commands exit `0` when
readable; inspect their JSON status and `output` before consuming an artifact.

## Resume and recover

Before each Question POST, the journal saves and syncs the exact request, TTL,
correlation, and idempotency key. Lost responses, malformed replies, crashes, or
failed saves can leave `create_unknown`. Later runs never resend that POST or
ask another span until recovery:

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

`find-id` inspects at most 200 recent Questions and prints matching `candidates`.
An empty result does not prove creation failed. Find the original ID in the
originating robot's history or saved response when needed. `recover` reads that
exact Question and checks the saved request, room, target, original asking
registration, and timestamps before attaching it. It sends no new Question.
Keep uncertain records; deleting state or using another checkout can duplicate
requests.

Answers require the named server-authenticated responder and an exact option.
Answer and resolution times must agree within the Question lifetime. Expiry may
be observed after its deadline. Implausible future times fail, allowing 60 seconds
for local clock skew. Reads require the original registration; reconnecting does
not recover inaccessible Questions.

After resolving active or uncertain requests, archive the entire `.redaction/`
directory before starting revised inputs with a new document ID. Preserve the
old source, manifest, and evidence privately. There is no automatic migration.

## Adapt and verify

`src/engine.js` exports `step` and `localReport` for workflow runners.
`src/model.js` validates input, checks attribution, and slices the source.
`redact` is a pure transformation helper; production callers should use the
engine's validated evidence rather than pass arbitrary decisions directly.
Deterministic rules stay in application code; no AI service is required. Text
never becomes executable commands, fetched URLs, or remotely chosen file paths.
There are no deployment or external-action steps.

Source text allows 16,384 UTF-16 units and at most 64 KiB of UTF-8. Invalid UTF-8,
unpaired surrogates, NUL, and control characters other than tab/CR/LF are rejected.
Quotes allow 160 UTF-16 units. IDs begin with a lowercase letter and use lowercase
letters, digits, `_`, or `-`; document IDs allow 40 characters, span IDs 24, with
prototype names disallowed for span IDs. Titles and reviewer labels allow 60
printable ASCII characters without outer spaces. Manifest/config files are
capped at 16 KiB, private state/reports at 1 MiB, and HTTP bodies at 512 KiB.

Writes use a private temporary file, file sync, rename, and directory sync.
One process owns the directory lock. After a crash, inspect `.redaction/.lock/owner.json`
or `.pingroom/.lock/owner.json`, confirm its process stopped, then remove only
the stale lock. Restore corrupt state from a valid backup. Local persistence and
server idempotency do not guarantee distributed exactly-once execution.

Credentials, local inputs, state, and exports are ignored by Git. Generated
private files use `0600` and directories `0700` on POSIX; secure source files and
backups separately. The [official SDK](https://github.com/pingroom/sdk) is pinned
to `0.7.0` with a lockfile and 14-day minimum release age. Requests use the official
API origin, refuse redirects, and enforce a five-second deadline through body
consumption. CI runs tests and demos on Node 22 and 24; live delivery is not tested.

Unlike [human review](https://github.com/pingroom/starter-human-review), this
workflow produces a new text artifact from exact source spans. Unlike
[three-way merge](https://github.com/pingroom/starter-three-way-merge), it does not
choose among conflicting document revisions.

MIT licensed; see [LICENSE](LICENSE).
