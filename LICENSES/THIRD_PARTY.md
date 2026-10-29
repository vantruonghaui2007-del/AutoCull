# Third-party notices

EventStory Cull bundles the following components. Full license texts ship inside the
installed application next to each package under `resources/app.asar.unpacked/node_modules/`
or inside `app.asar`.

| Component | License | Notes |
|---|---|---|
| Electron 45.0.0 (Chromium, Node.js 24) | MIT + Chromium third-party licenses | `LICENSES.chromium.html` in the app folder |
| ExifTool by Phil Harvey (via exiftool-vendored, exiftool-vendored.exe / .pl) | Perl Artistic License / GPL | Used read-only for metadata and embedded preview extraction |
| exiftool-vendored | MIT | |
| sharp | Apache-2.0 | |
| libvips and dependencies (@img/sharp-*) | LGPL-3.0-or-later and others | Dynamically linked, shipped unpacked |
| React, React DOM | MIT | |
| Zod | MIT | |
| @mediapipe/tasks-vision 1.2.0 | Apache-2.0 | JS/WASM runtime for opt-in local analysis. Copyright The MediaPipe Authors. See `Apache-2.0.txt`. |

## MediaPipe model (external prototype asset)

The `face_landmarker.task` model is **not included** in the app or installer. The user selects a local file;
its size and SHA-256 are checked before use. Model component cards identify Apache-2.0, but artifact-specific
licence/provenance for the combined bundle has not been verified. Do not redistribute that model with a
release until this review is complete. Runtime licensing must not be assumed to resolve model licensing.

## LibRaw 0.22.3 (CDDL-1.0)

The RAW decoding helper `bin/eventstory-raw` (`eventstory-raw.exe` on Windows) is statically linked with LibRaw 0.22.3,
Copyright (C) 2008-2025 LibRaw LLC (info@libraw.org), used under the COMMON DEVELOPMENT AND DISTRIBUTION LICENSE (CDDL) Version 1.0
(LibRaw is dual-licensed LGPL-2.1 / CDDL-1.0; CDDL-1.0 is chosen). LibRaw source files are unmodified; no demosaic packs, RawSpeed or
DNG SDK are included. The exact source code (`LibRaw-0.22.3.tar.gz`, SHA-256 789f3c33466210a1a0907f747a97c715d21bbf4af712f257fcbbd90111b227e4),
the COPYRIGHT and LICENSE.CDDL files and build instructions (BUILD.md) are provided in `licenses/LibRaw/` next to this file.
