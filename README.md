# RPGLPort

An **offline, self-contained** NW.js GUI that ports **Windows RPG Maker MV/MZ games to
Linux**. Drop a game in, get a Linux-native port out — no compilation, no wine, no
network access needed at port time. Everything the tool needs (runtimes, extractor,
unpacker) ships inside the bundle.

## Quick start

1. Extract the release archive (`RPGLPort-linux-x64-*.tar.xz`).
2. Run it:

   ```sh
   ./RPGLPort.sh
   ```

3. Drag a game (or archive) onto the window and follow the cards.

## Requirements

Works on any reasonably current x86-64 Linux distro (Arch, Debian, Ubuntu, Fedora…):
the bundled NW.js runtimes need glibc ≥ 2.25 (2017-era; everything since Debian 10 /
Ubuntu 18.04 qualifies) and the standard GTK/X11 stack that desktop systems already
have. Ports of games pinned to old NW.js (< 0.29) bundle their own GTK2-era library
set (libgconf-2, libgtk-x11-2.0, libgdk-x11-2.0, libnotify, libdbus-glib) in the
port folder, so those need nothing extra either. On a **minimal or server install**
(Debian/Ubuntu without a desktop), install the runtime libraries first:

```sh
# Debian / Ubuntu
sudo apt install libgtk-3-0 libnss3 libasound2 libgbm1 libxss1
```

(`libxss1` is only needed by ports on the old ≤0.29 runtimes; on older releases the
ALSA package is `libasound2t64` / `libasound2`.) Then run the tool and its ports under
X11, XWayland, or headless via Xvfb. A display-server session is not required for
porting — only for running the games.

## Supported inputs

- **Game folders** (drag-drop or picker): a Windows MV/MZ game directory.
- **Archives**: `.zip`, `.7z`, `.rar` — extracted in-process via the bundled `7zz`.
- **EnigmaVB-packed exes**: detected automatically (huge `Game.exe` with an Enigma
  virtualization section) and unpacked via the vendored unpacker.
- **Multi-game archives**: every game found inside gets its own card.
- Split/encrypted archives and non-MV/MZ NW apps are refused with an explanation.

## Runtime pool

Porting a game means marrying its payload to the right NW.js runtime. RPGLPort keeps a
**pool**:

- the **bundled ladder** `0.12.3 / 0.19.5 / 0.22.3 / 0.29.0 / 0.39.3 / 0.48.4` (covering the
  MV era and early MZ),
- the **host** runtime the tool itself runs on (newest stable),
- **user imports** via Settings (drop any `nwjs-vX.Y.Z-linux-*` dir in).

Selection policy per game: **exact match** for the detected NW.js version →
**nearest newer** → **newest** (with a downgrade warning). Two floors apply:
MZ is refused below **0.44.0** (needs Chromium 80+ syntax), and no runtime below
the **usability floor 0.48.4** is ever auto-selected — verified on modern Arch,
every older NW.js release fails to open a window (the browser idles forever
before spawning its renderer, or worse; 0.39.3 loads pages but its WebGL context
never initializes), so ports fall forward to the nearest usable runtime and
`NOTES.txt` records the substitution. Every card has a manual override dropdown
listing the whole pool; overrides bypass policy but not the MZ floor (use them
to experiment with legacy runtimes — the ports still carry the era-specific
launchers, fontconfig workaround and legacy libs).

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
- A normalized `package.json`, a `start.sh` launcher (pins `GDK_BACKEND=x11` — games
  are X11 apps and die under Wayland sessions that export `GDK_BACKEND=wayland`),
  and `NOTES.txt` listing **every** note, warning, case fix and missing asset.

## Limitations

- EnigmaVB exes > 4 GiB are refused (PE 32-bit offsets can't address them); below that, any size unpacks with flat memory use (vendored unpacker v1.1.0 is file-backed — Node's 2 GiB `readFileSync`/`writeFileSync` caps don't apply).
- Registry virtualization data is not extracted.
- NW.js ships no H.264/AAC decoders — games whose videos/audio are `.m4a`-only will
  be silent. (MV/MZ default audio is fine.)
- Case-scanning works off parsed asset references; paths constructed at runtime by
  plugins can't be pre-scanned.
- Old runtimes may hit new-glibc/fontconfig quirks on modern distros — run the port's
  Test Run (the fontconfig quirk is worked around automatically, see above). Automatic
  selection never ships them (usability floor, above); Test Run also detects the
  failure mode honestly — a process that stays alive without ever opening a window
  (no renderer spawned) is reported as an error, not a success. Every Test Run also
  injects a temporary diagnostic probe into the port (restored afterwards) and logs
  the real WebGL renderer plus frame-time spread — software rendering (llvmpipe /
  SwiftShader, i.e. GPU init failed) is called out as the cause of input lag.
  **Diag play** goes further: it launches the port with the same probe and lets you
  play until the problem appears, recording every ≥1s stall — gameplay-only lag
  never shows up in Test Run's 8-second title-screen window.

## Development

```sh
tools/fetch-dev-deps.sh        # static 7zz, host NW.js, ladder runtimes (cached)
npm test                       # or: node --test test/
RPGLPORT_IT=1 node test/integration/boot-test.js   # port + headless-boot all fixture games
./tools/build.sh x64           # build the distributable bundle (fresh downloads)
```

`tools/verify-runtime.cjs <dir>` checks any extracted runtime dir for pool admission.

## Credits

RPGLPort made by Shisaye
anime-sharing.com

- EnigmaVB unpacker by **Shisaye**, vendored under `app/core/enigma` (MIT license).
- **7-Zip** by Igor Pavlov (bundled as the static `7zz` binary).
- **NW.js** (Chromium + Node.js) by the NW.js contributors.
- RPG Maker is a trademark of Gotcha Gotcha Games. This tool is an independent
  fan project and is not affiliated with or endorsed by them.
