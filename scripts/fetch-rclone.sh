#!/usr/bin/env bash
# Downloads the rclone binary and places it as the Tauri sidecar for this host
# (macOS/Linux). Windows users: run scripts/fetch-rclone.ps1 instead.
set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../src-tauri" && pwd)/binaries"
mkdir -p "$dir"

case "$(uname -s)" in
  Darwin) os=osx ;;
  Linux) os=linux ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=amd64; cpu=x86_64 ;;
  arm64 | aarch64) arch=arm64; cpu=aarch64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

# Tauri looks the sidecar up by target triple.
if [ "$os" = "osx" ]; then
  triple="${cpu}-apple-darwin"
else
  triple="${cpu}-unknown-linux-gnu"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

url="https://downloads.rclone.org/rclone-current-${os}-${arch}.zip"
echo "Downloading $url"
curl -fsSL "$url" -o "$tmp/rclone.zip"
unzip -q "$tmp/rclone.zip" -d "$tmp"

src="$(find "$tmp" -name rclone -type f | head -n1)"
dest="$dir/rclone-${triple}"
cp "$src" "$dest"
chmod +x "$dest"

echo "rclone placed at $dest"
"$dest" version | head -n1
