#!/bin/sh
# Builds LibRaw 0.22.3 (static, no packs/RawSpeed/DNG SDK/zlib/jpeg) and the eventstory-raw helper
# on macOS or Linux. NOT YET RUN ON macOS — verify on a real Mac before publishing a Mac build.
set -eu
root=$(cd "$(dirname "$0")" && pwd)
tar="$root/third_party/LibRaw-0.22.3.tar.gz"
expected=789f3c33466210a1a0907f747a97c715d21bbf4af712f257fcbbd90111b227e4
[ -f "$tar" ] || curl -sSL -o "$tar" https://www.libraw.org/data/LibRaw-0.22.3.tar.gz
actual=$(shasum -a 256 "$tar" 2>/dev/null | cut -d' ' -f1 || sha256sum "$tar" | cut -d' ' -f1)
[ "$actual" = "$expected" ] || { echo "LibRaw checksum mismatch: $actual" >&2; exit 1; }
src="$root/third_party/LibRaw-0.22.3"
[ -d "$src" ] || tar -xzf "$tar" -C "$root/third_party"
platform=$(node -p 'process.platform')
arch=${ARCH:-$(node -p 'process.arch')}
out="$root/bin/$platform-$arch"
mkdir -p "$out"
cd "$src"
case "$arch" in arm64) flag="-arch arm64" ;; x64) flag="-arch x86_64" ;; *) flag="" ;; esac
[ "$platform" = darwin ] || flag=""
objdir="$root/build/$platform-$arch"
mkdir -p "$objdir"
for f in $(find src -name '*.cpp' ! -path 'src/integration/*' ! -name '*_ph.cpp'); do
  o="$objdir/$(echo "$f" | tr '/' '_').o"
  c++ $flag -O2 -I. -DLIBRAW_NOTHREADS=0 -DNO_LCMS -DNO_JASPER -DNO_JPEG -w -c "$f" -o "$o"
done
c++ $flag -O2 -I. "$root/raw-helper/eventstory-raw.cpp" "$objdir"/*.o -o "$out/eventstory-raw"
"$out/eventstory-raw" --version
