# RPGPort

An **offline, self-contained** NW.js GUI that ports **Windows RPG Maker MV/MZ games to
Linux**. Drop a game in, get a Linux-native port out — no compilation, no wine, no
network access needed at port time. Everything the tool needs (runtimes, extractor,
unpacker) ships inside the bundle.

## Quick start

1. Extract the release archive (`RPGPort-linux-x64-*.tar.xz`).
2. Run it:

   ```sh
   ./RPGPort.sh
   ```

3. Drag a game (or archive) onto the window and follow the cards.

## Supported inputs

- **Game folders** (drag-drop or picker): a Windows MV/MZ game directory.
- **Archives**: `.zip`, `.7z`, `.rar` — extracted in-process via the bundled `7zz`.
- **EnigmaVB-packed exes**: detected automatically (huge `Game.exe` with an Enigma
  virtualization section) and unpacked via the vendored unpacker.
- **Multi-game archives**: every game found inside gets its own card.
- Split/encrypted archives and non-MV/MZ NW apps are refused with an explanation.

## Runtime pool

Porting a game means marrying its payload to the right NW.js runtime. RPGPort keeps a
**pool**:

- the **bundled ladder** `0.12.3 / 0.19.5 / 0.22.3 / 0.29.0 / 0.48.4` (covering the
  MV era and early MZ),
- the **host** runtime the tool itself runs on (newest stable),
- **user imports** via Settings (drop any `nwjs-vX.Y.Z-linux-*` dir in).

Selection policy per game: **exact match** for the detected NW.js version →
**nearest newer** → **newest** (with a downgrade warning). MZ is refused below
**0.44.0** (needs Chromium 80+ syntax). Every card has a manual override dropdown
listing the whole pool; overrides bypass policy but not the MZ floor.

## Odd cases handled

- Mixed runtime binaries (e.g. browser says 0.48.4, node says 0.44.0) — surfaced as
  evidence on the card; the browser-process stamp wins.
- Missing or malformed `package.json` — synthesized for the detected layout.
- `app.nw` compiled MV — extracted and re-analyzed.
- EnigmaVB — auto-unpacked before the normal pipeline.
- Case-sensitivity — asset references with wrong casing are auto-fixed in the output
  (rename plan); case-only-distinct files are kept as duplicates with a warning.
  On case-insensitive destinations the fixes degrade to no-ops (warned), and
  unresolvable case conflicts fail the card up front.

## What a port contains

- A **full Linux NW.js runtime** (nothing stripped) with the executable-stack flag
  cleared. Ports on pre-0.30 runtimes additionally bundle a minimal `fonts.conf` and
  a `nw` wrapper pinning `FONTCONFIG_FILE` — old NW.js cannot parse modern fontconfig
  and would otherwise die at startup.
- The game payload minus Windows runtime files (`.exe`, `.dll`, `.pak`, blobs).
- A normalized `package.json`, a `start.sh` launcher, and `NOTES.txt` listing **every**
  note, warning, case fix and missing asset.

## Limitations

- EnigmaVB exes > 4 GiB are refused (PE 32-bit offsets can't address them); exes larger than ~75% of free RAM are refused with a size report (the unpacker memory-loads the PE; Node's own 2 GiB `readFileSync` cap is bypassed via chunked reads, so 2–4 GiB exes work when RAM allows).
- Registry virtualization data is not extracted.
- NW.js ships no H.264/AAC decoders — games whose videos/audio are `.m4a`-only will
  be silent. (MV/MZ default audio is fine.)
- Case-scanning works off parsed asset references; paths constructed at runtime by
  plugins can't be pre-scanned.
- Old runtimes may hit new-glibc/fontconfig quirks on modern distros — run the port's
  Test Run (the fontconfig quirk is worked around automatically, see above).

## Development

```sh
tools/fetch-dev-deps.sh        # static 7zz, host NW.js, ladder runtimes (cached)
npm test                       # or: node --test test/
RPGPORT_IT=1 node test/integration/boot-test.js   # port + headless-boot all fixture games
./tools/build.sh x64           # build the distributable bundle (fresh downloads)
```

`tools/verify-runtime.cjs <dir>` checks any extracted runtime dir for pool admission.

## Credits

- EnigmaVB unpacker by **Shisaye**, vendored under `app/core/enigma` (MIT license).
- **7-Zip** by Igor Pavlov (bundled as the static `7zz` binary).
- **NW.js** (Chromium + Node.js) by the NW.js contributors.
- RPG Maker is a trademark of Gotcha Gotcha Games. This tool is an independent
  fan project and is not affiliated with or endorsed by them.
