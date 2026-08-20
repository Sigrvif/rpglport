# RPGPort — Self-Contained GUI Porting Tool for RPG Maker MV/MZ (Windows → Linux)

**Date:** 2026-08-19
**Status:** Approved design, pending implementation plan

## 1. Problem & Goal

RPG Maker MV/MZ Windows games ship the full Windows NW.js runtime (`Game.exe` is a
renamed `nw.exe`, plus `nw.dll`, `node.dll`, `*.pak`, `locales/`, ...). Porting to Linux
means replacing that runtime with the same-version (or compatible newer) Linux NW.js
build while preserving the game payload. This works reliably because the game engine
itself is plain JavaScript shipped inside the game folder.

RPGPort is a **self-contained, offline GUI tool** that automates this for common Linux
distros (Arch, Ubuntu, and anything with comparable glibc/libraries). Priorities:

1. Zero dependencies for the end user (single folder, no install, no network).
2. Correct handling of **unorthodox games** (mismatched/overridden runtimes, packed
   executables, odd layouts) — explicitly prioritized over tool size.
3. Transparency: every decision (detected version, chosen runtime, warnings) is shown
   to the user and overridable.

Existing assets this design builds on:

- `rpgport.py` — validated CLI proof-of-concept (detection, selection, execstack fix,
  port assembly). Its logic ports 1:1 to JavaScript.
- `Linux Port testing/EnigmaNodeUnpacker/` — pure-Node, zero-dependency Enigma Virtual
  Box unpacker (v4.10–10.80, x86/x64, path-traversal protection, ~1s/GB). Vendored.

## 2. Non-Goals

- No network access at use time (bundling happens at build time on a connected machine).
- No Windows/macOS host builds (the tool itself runs on Linux; ported games run on Linux).
- No modification of game logic, translations, or save conversion.
- No extraction of Enigma registry virtualization entries (matches upstream unpacker).
- No support for non-NW.js-based RPG Maker engines (XP/VX/VX Ace are Ruby/CEF-adjacent;
  out of scope).

## 3. Architecture

**The tool is itself an NW.js app.** NW.js bundles Chromium + Node, so the GUI is plain
HTML while all logic runs in full Node. The modern NW.js runtime that hosts the GUI also
serves as the newest entry in the porting-runtime pool — nothing is shipped twice, and a
successful GUI launch proves the host has every native library a ported game needs
(libnss3, libasound2, ...), making the tool its own portability canary.

### 3.1 Layers

| Layer | Contents | Constraint |
|---|---|---|
| GUI | `app/index.html`, `app/ui.js` + CSS | Thin: rendering, events, progress. No logic. |
| Core | `app/core/*.js` — plain Node modules | No DOM/NW references; headless-testable via `node`. |
| Vendor | `app/core/enigma/*` (from EnigmaNodeUnpacker), `bin/7zz` | Unmodified logic, attributed. |
| Bundle | `runtimes/` (pre-extracted NW.js builds) + host runtime | Verified at build/import; immutable at use time. |

### 3.2 Deliverable layout

```
RPGPort/                            # one archive, extracted once (~2 GB on disk)
├── nw, lib/, *.pak, locales/, ...  # modern NW.js runtime (GUI host + newest pool entry)
├── package.json                    # main: app/index.html
├── RPGPort.sh                      # launcher: cd "$(dirname "$0")" && exec ./nw "$@"
├── bin/7zz                         # static 7-Zip (zip/7z/rar; no distro deps)
├── app/
│   ├── index.html, ui.js, style.css
│   └── core/
│       ├── engine.js               # pipeline: analyze → select → port
│       ├── detect.js               # game analysis (all heuristics)
│       ├── select.js               # runtime pool + selection policy
│       ├── port.js                 # port builder (+ start.sh, package.json synth)
│       ├── pe.js                   # PE inspection (stamps, sections, arch)
│       ├── elf.js                  # PT_GNU_STACK PF_X clear
│       ├── nwmap.json              # NW↔Node↔Chromium maps (all known NW releases)
│       ├── extract.js              # 7zz wrapper + archive/nesting heuristics
│       ├── casescan.js             # case-sensitivity scanner + rename plan
│       └── enigma/                 # vendored EnigmaNodeUnpacker modules
└── runtimes/                       # fat bundle, pre-extracted (~1.5–2 GB on disk)
    ├── nwjs-v0.12.3-linux-x64/        # MV 1.0 era
    ├── nwjs-v0.19.5-linux-x64/        # MV 1.2/1.3 era
    ├── nwjs-v0.22.3-linux-x64/        # MV 1.4/1.5 era
    ├── nwjs-v0.29.0-linux-x64/        # MV 1.6 (dominant case)
    └── nwjs-v0.48.4-linux-x64/        # MZ (dominant case: engines 1.0–1.8+ ship it)
```

### 3.3 Runtime pool

The whole tool ships as **one compressed archive**, so the bundle stores runtimes
**pre-extracted** — keeping inner tarballs would add dead weight (the outer archive
already compresses everything once) and an extraction/cache layer for no benefit.

- Pool = the host runtime (in place, version stamped at build time) + every valid
  directory under `runtimes/` + imported runtimes.
- **Admission check** (build time for bundled, import time for user-added): each
  runtime is verified by `elf.js#runtimeStamps()` — an ELF string scan of
  `nw`/`lib/libnw.so` for `node.js/vX.Y.Z` and `Chrome/<majors>` matched against
  `nwmap.json` — plus an ELF-arch check against `process.arch`; the directory name
  must agree. Invalid entries are rejected at import / failed-build, never silently.
  Entries are immutable after admission (imports add directories; nothing inside an
  admitted runtime is modified).
- **Imports:** a user-dropped `nwjs-*.tar.gz` extracts into `runtimes/` when the
  bundle folder is writable; otherwise into `~/.cache/rpgport/runtimes/` (which then
  joins the pool like any other entry). Imported entries can be removed from the
  pool manager; bundled ones can't.

### 3.4 Builds

- **x64 build** (primary): everything above.
- **arm64 build**: modern host only (pre-0.70 NW.js never shipped linux-arm64); the
  pool is the host + imports, and x64-arch entries (bundled or imported) are excluded
  from the pool with an explanatory message rather than failing obscurely.
- **Build script** (`tools/build.sh`, runs on a connected machine): downloads the NW
  runtime tarballs, **extracts and verifies each** (elf stamps vs `nwmap.json`),
  discards the tarballs, fetches 7zz, vendors enigma modules, stamps `build.json`
  (host version, pool inventory, map snapshot date), runs selftest, and emits the
  single distributable archive. Users never need network.

## 4. Input & Queuing

- Drop zone / file picker accepts **game folders** and **archives** (`.zip`, `.7z`,
  `.rar`; also DLsite-typical nested layouts). Multiple drops = multiple queue cards.
- Archives extract to a temp dir (`~/.cache/rpgport/tmp/`); a setting controls whether
  the extracted copy is kept or cleaned after porting (default: clean).
- **Nesting resolution:** after extraction (or for dropped folders), locate game roots
  by finding `package.json`+`www/` (MV) or root `index.html`+`js/rmmz_*` (MZ). One
  input may yield several games; each becomes its own card.
- Split volumes (`.7z.001`, `.zip.001`, `.part1.rar`) and encrypted archives are
  detected and rejected with a "finish/decrypt the download first" message.
- Non-MV/MZ NW.js apps dropped by mistake: detected (no engine signature), reported as
  such, refused.

## 5. Detection (core/`detect.js`)

A **confidence ladder**; all evidence is collected and displayed per card:

1. **Binary stamps (authoritative):**
   - PE version resources (`ProductVersion`) of `Game.exe` / `nw.dll` — NW.js version.
   - `node.js/vX.Y.Z` string and Chromium major strings in `node.dll` / `nw_elf.dll`.
   - `.enigma1`/`.enigma2` sections present → EnigmaVB-packed (see §7).
   - PE machine type (x86/x64) recorded, informational only (JS is arch-agnostic).
2. **Engine signature (informational — devs patch it):**
   `Utils.RPGMAKER_VERSION` from `www/js/rpg_core.js` (MV) or `js/rmmz_core.js` (MZ).
3. **Layout signature:** `www/` + `package.json` → MV; root `index.html` + `js/rmmz_*`
   → MZ; `app.nw` (old compiled MV) → unzip and re-analyze contents.
4. **Cross-check** all stamps against `nwmap.json`; disagreements (e.g. `nw.dll` says
   0.48.4 but `node.dll` says 0.44.0-beta1) are shown on the card; browser-process
   stamps outrank node-module stamps when picking the detected version.

Detection output: `{ engine: 'MV'|'MZ', engineVersion, detectedNW, evidence[], flags[] }`.

## 6. Runtime Selection (core/`select.js`)

Pool = bundled runtime directories + host runtime + imported runtimes. Policy:

1. **Exact match** for `detectedNW` → use it ("exact match").
2. Else **nearest newer** → jump explained on the card with behavioral notes.
3. Else **newest in pool** → warning + notes.

Hard floors and caveats (surfaced, not silent):

- MZ requires NW.js ≥ 0.44 (rmmz core needs Chromium 80+ syntax). Below → refuse.
- MV core < 1.6.0 on Chromium ≥ 66: autoplay policy — BGM silent until first click.
- Any much-newer-than-shipped runtime: "test plugins" advice on the card.
- Any old-pool runtime (≤ 0.29 era) on a modern distro: card note that ancient
  Chromium may hit new-glibc/fontconfig quirks (execstack and fontconfig workarounds
  are applied automatically, but a test run is advised).
- arm64 build: pre-0.70 runtimes unavailable — nearest-newer jumps are larger;
  explained on the card.

**Manual override:** every card has a runtime dropdown listing the whole pool with a
one-line rationale per entry. Overrides bypass policy but not the MZ floor.

## 7. Odd-Case Matrix (handled by the pipeline, surfaced on cards)

| Case | Handling |
|---|---|
| Mixed runtime binaries | Shown as evidence; browser-process stamp wins |
| Missing `package.json` | Synthesized for the detected layout |
| `app.nw` compiled MV | Unzipped, re-analyzed |
| **EnigmaVB-packed exe** (huge `Game.exe`, no game dir beside it, `.enigma1` section) | Auto-unpacked in-process via vendored module v1.1.0 (file-backed: headers parsed eagerly, payload read on demand — flat memory, no 2 GiB ceiling; `--no-exe` equivalent: file tree only, no Windows stub rebuild); then normal pipeline. Card shows EnigmaVB version. Caveat: exes > 4 GiB refused (PE 32-bit offset limit). |
| 32-bit Windows game | Informational note only |
| Wrong-case asset references | **Auto-fixed in the output copy** by the case-sensitivity scanner (§8.5) |
| Case-only-distinct asset files | Both kept + conflict warning; fails the card on case-insensitive destinations (§8.5) |
| Archive with multiple games / nested folders | Game-root resolution; one card per game |
| Split/encrypted archives | Refused with explanation |
| Non-MV/MZ NW app | Refused with explanation |

## 8. Port Builder (core/`port.js`)

1. Copy chosen runtime into `<out>/<Game Name> (Linux)/`.
2. `chmod 755` on `nw` (+ `crashpad_handler` when present).
3. Copy game payload, skipping Windows runtime files — case-insensitive: `*.dll`,
   `Game.exe`, `nw.exe`, `game.bin`, `notification_helper.exe`, `icudtl.dat`,
   `*.pak`, `snapshot_blob.bin`, `natives_blob.bin`, `v8_context_snapshot.bin`,
   `locales/`, `swiftshader/`, `credits.html`, `debug.log` — and never overwriting
   Linux runtime files already present. The case-rename plan from §8.5 is applied
   during this copy (files are written under their corrected names).
4. **ELF fix:** for every `lib/*.so`, clear `PT_GNU_STACK.PF_X` if set (old NW.js
   `libnode.so` ships with executable-stack flag; modern hardened kernels refuse it).
   In pure JS via `fs` read/patch/write.
5. **Normalize `package.json`:** preserve `main`, `js-flags`, `chromium-args`, `window`;
   fill `name` with a folder-derived slug when empty (NW keys `~/.config/<name>/` off
   it — empty names collide save dirs across games).
6. Write `start.sh` (`cd "$(dirname "$0")"; exec ./nw "$@"`, mode 755).
7. Write `NOTES.txt`: detected/chosen runtime + rationale, all warnings, applied
   case-fix summary (§8.5), known-issue classes (autoplay caveat, H.264/AAC absent in
   NW builds if `.m4a`-only audio detected, runtime-path residual case risk).

Progress events stream to the card (file counts/bytes). Output location: user default
(settings) or chosen per card. If the target directory already exists, the card
prompts: refuse (default), overwrite (temp-build + atomic swap), or new name.
**Job model:** one port at a time (serialized worker, keeps I/O and progress
predictable); queued cards run in order. Remove on an in-flight card requests cancel —
the worker stops at the next file boundary, the partial temp dir is cleaned, and the
card is dropped.
Optional per-card action "Install menu entry" writes
`~/.local/share/applications/<slug>.desktop` pointing at `start.sh` with the game's
`icon/icon.png`.

### 8.5 Case-Sensitivity Scanner (core/`casescan.js`)

Linux filesystems are case-sensitive; games authored on Windows commonly reference
assets with casing that differs from the files on disk (`img/faces/Actor1.png` vs
`img/faces/actor1.PNG`). On Windows both resolve; on Linux the asset silently fails to
load. The scanner finds these and the port builder fixes them in the output copy.

**Reference harvest** (two independent collectors, results unioned):

1. **Known engine keys** — a table (MV and MZ) mapping data-JSON keys to their asset
   directory and extension candidates, e.g. `faceName`/`characterName` →
   `img/faces|characters/<name>.{png,jpg}`, `name` under `bgm|bgs|me|se` objects →
   `audio/<dir>/<name>.{ogg,m4a,rpgmvo,wav,mp3}`, `pictureName`, `parallaxName`,
   `battleback1/2Name`, `tilesetNames[]`, `title1/2Name`, vehicle names, animation
   sheets, MZ `effectName` → `effects/<name>/...`. Walks `data/*.json` (MZ also
   `effects/*.json`). Bare names without extension are the norm — hence extension
   candidate lists.
2. **Literal path scan** — regex over all `.js` and `.json` text in the game
   (including `js/plugins/` and plugin params) for string literals containing
   `img/`, `audio/`, `movies/`, `effects/`, `fonts/` path prefixes (backslashes
   normalized to `/` before matching). Catches plugin asset references the key
   table can't know about.

**Resolution:** every harvested reference is looked up case-insensitively against an
index of the game's actual files.

- Unique case-insensitive match, case differs → **finding** (fix: rename file to the
  referenced casing).
- Multiple references to one file with conflicting casings → rename to the majority
  casing; each minority casing is additionally materialized in the output as a
  hardlink to the renamed file (fallback: copy) so every reference resolves. Ties →
  no rename (disk casing kept) and all distinct referenced casings materialized the
  same way (a casing identical to the kept disk casing is never materialized).
  All non-canonical duplicates are listed in `NOTES.txt`.
- Two distinct files that differ only by case → both kept in the output, conflict
  warning emitted (no safe automatic fix).
- No match even case-insensitively → reported as a *missing asset* (informational;
  frequently dead references in shipped games — not introduced by porting).

**Destination filesystem:** at port start the output volume is probed for case
sensitivity. On case-insensitive destinations (exFAT/FAT/NTFS external drive):
minority-casing materialization is skipped with a warning, and case-only-distinct
source files make the card fail with an explanation (they cannot be represented
faithfully) — the user is directed to a case-sensitive destination.

**Guarantees:** the user's original game folder is never modified; renames and
duplicates are applied only while copying into the port output. The scanner runs at
the start of the port stage — after extraction/Enigma unpack and game-root
resolution, before the payload copy (its rename plan feeds step 3). If `data/*.json`
is malformed, the key-table collector skips the bad file and the literal scan still
harvests that game. Runtime-constructed paths (`'img/pictures/' + var`) can't be
harvested statically — residual risk is covered by the card's Test Run action and
noted in `NOTES.txt`.

**Output:** `{ fixes: [{ref, actual, fixed}], duplicates, conflicts, missing }` —
card shows "N case fixes · M warnings", where N = renames + materialized
duplicates and M = conflicts + missing assets + skipped materializations; full
lists go to the log drawer and `NOTES.txt`.

## 9. GUI

- **Header:** drop zone (folders + archives), settings gear, pool indicator.
- **Queue:** cards, one per game — name, engine badge (MV/MZ + version), evidence line
  (e.g. `nw.dll→0.48.4 · node.dll→0.44.0-beta1 · MZ 1.4.3`), runtime dropdown, status
  (analyzing → ready → porting % → done / done-with-warnings / error), actions:
  Port · Open Folder · Test Run · Remove · Log drawer. Done cards show a
  "N case fixes · M warnings" summary chip (details in log drawer + `NOTES.txt`).
- **Test Run:** `child_process.spawn` of the port's `nw`, stderr watched for fatal
  patterns; user-visible result tag (launched OK / crashed: pattern).
- **Settings:** default output dir; keep-extracted-archives toggle; runtime pool
  manager (list bundled/imported with "used by N games", import tarball button,
  remove imported runtimes); arch note on arm64 builds.
- Vanilla HTML/CSS/JS. No frameworks, no build step for the app itself.

## 10. Error Handling

- Every pipeline stage returns structured results (`{ok, error, evidence}`); the GUI
  never parses log text for state.
- Filesystem errors (space, permissions, read-only tool dir) are surfaced at the stage
  that hit them with the offending path.
- Port is transactional-ish: builds into `<out>/.tmp-<slug>/` then atomically renames;
  failures clean up the partial dir.
- Unpacker path-traversal protections stay enabled (vendored code is unmodified).
- Archive extraction relies on `7zz`'s built-in path sanitization (it rejects `..`
  and absolute-path members); extraction always targets a tool-controlled temp dir,
  never the output location directly, so game-root resolution sees only sanitized
  paths. The tool never hand-parses archive member paths.

## 11. Testing

- **Unit (node, no GUI):** nwmap lookups (node↔NW↔Chromium round trips); PE stamp
  parsing against fixture binaries (the five local games, copied headers); ELF
  PT_GNU_STACK patch on fixture .so; package.json synthesis cases; archive/game-root
  heuristics against synthetic trees; Enigma detection on a fixture with faked
  `.enigma1` header; selection policy table tests (exact/jump/floor/override);
  casescan against a synthetic fixture tree (wrong-case refs, majority + tie
  casings, minority materialization, case-only duplicate files, missing assets,
  bare-name extension candidates, plugin literal-path references including
  backslash-separated and non-ASCII/Japanese filenames, malformed data JSON,
  case-insensitive destination probe).
- **Integration:** port the local MV/MZ fixture games (currently five: 3 MV + 2 MZ
  under `Linux Port testing/`; Ace-era games are out of scope); boot each under `Xvfb`
  with an injected boot-probe (`require('fs')` marker asserting
  `Scene_Boot`/`Scene_Title`), then restore pristine index.html. This mirrors the
  manual verification already performed. The scanner additionally runs over all
  fixture games; its report must contain zero unresolved case conflicts. An
  Enigma-packed sample, if available, joins this harness; otherwise fixture-level.
- **Smoke:** `node app/core/engine.js --selftest` (map integrity, 7zz runs, pool
  readable) used by the build script to validate assembled bundles.

## 12. Distribution

- One compressed folder archive (`.tar.xz`) per arch, plus a checksum file — the
  outer archive compresses the pre-extracted runtimes once, so no inner compressed
  containers. `.tar.xz` preserves executable bits. No AppImage/packages (the folder
  IS the runtime; an AppImage would just re-wrap it).
- `tools/build.sh` (connected machine): fetches NW ladder + 7zz, extracts + verifies
  runtimes, vendors enigma unpacker, embeds fresh `nwmap.json`, writes `build.json`,
  runs selftest, packages.

## 13. Future Work (out of scope now)

- Renpy/Godot/other engine detection (refuse gracefully today).
- Case-fix backporting into the user's original game folder (output-copy-only today).
- Automatic save-dir isolation beyond name slugs.
- Translated GUI strings (English first).
