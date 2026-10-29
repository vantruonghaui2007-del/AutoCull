# eventstory-raw — RAW decode helper (LibRaw 0.22.3)

The desktop app decodes RAW files that have no usable embedded preview with a small helper
process built on **LibRaw 0.22.3**, used under **CDDL-1.0** (LibRaw is dual-licensed LGPL-2.1 /
CDDL-1.0; this project chooses CDDL-1.0).

- Upstream source: `https://www.libraw.org/data/LibRaw-0.22.3.tar.gz`
  SHA-256 `789f3c33466210a1a0907f747a97c715d21bbf4af712f257fcbbd90111b227e4` (downloaded 28/10/2026).
  The exact tarball is shipped with the application in `resources/licenses/LibRaw/`.
- **No modifications** to LibRaw source files. No demosaic packs, RawSpeed, DNG SDK, zlib or
  libjpeg are compiled in (so lossy-JPEG DNGs and some exotic formats are not decoded by LibRaw).
- Helper source: `raw-helper/eventstory-raw.cpp` (part of EventStory Cull).

What the helper does: opens the RAW read-only, refuses images above 60 MP, limits its own memory
(Windows job object 1.5 GiB; Linux `RLIMIT_AS`; macOS: not enforced by the OS — the parent's 60 s
timeout still applies), decodes with camera white balance, no auto-brightness, no sharpening,
sRGB 8-bit, rotated by the RAW orientation, and streams the pixels to stdout. It writes nothing
to disk.

## Build

Windows (Visual Studio Build Tools with C++):

```
powershell -ExecutionPolicy Bypass -File native/build-raw-helper.ps1
```

macOS / Linux (Xcode command line tools or a C++ toolchain) — **not yet run on a Mac**:

```
sh native/build-raw-helper.sh
```

Output: `native/bin/<platform>-<arch>/eventstory-raw[.exe]`, picked up by electron-builder.
