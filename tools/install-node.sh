#!/bin/sh
# Install Node into the invoking user's ~/.local, so that account can run this repo's own build and
# install scripts.
#
# It exists because of one concrete hole. The agent login session runs the desktop helper, and
# updating that helper means running `install-grid-encoder.sh` AS that user, which needs `node`.
# The console user's node lives under a home directory the agent cannot traverse (0750), and
# Homebrew ships none, so the agent account had no node at all and the only way to update its helper
# was to copy a binary into place by hand. A hand-copy is not a deployment story.
#
# Pinned and verified, because this unpacks an executable off the network: the version is explicit
# rather than "latest", and the archive is checked against the SHASUMS256 the release publishes
# before anything is extracted. A mismatch stops here rather than installing.
set -eu

version="${NODE_VERSION:-v26.7.0}"
case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  *) echo "install-node: only macOS is supported here, got $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64) architecture="arm64" ;;
  x86_64) architecture="x64" ;;
  *) echo "install-node: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

name="node-$version-$platform-$architecture"
prefix="$HOME/.local"
if [ -x "$prefix/bin/node" ] && [ "$("$prefix/bin/node" --version 2>/dev/null)" = "$version" ]; then
  echo "install-node: $version already at $prefix/bin/node"
  exit 0
fi

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
echo "install-node: fetching $name" >&2
curl -fsSL "https://nodejs.org/dist/$version/$name.tar.xz" -o "$staging/$name.tar.xz"
curl -fsSL "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$staging/SHASUMS256.txt"
# Only this archive's line, so an unrelated entry in the manifest cannot pass the check for it.
( cd "$staging" && grep " $name.tar.xz\$" SHASUMS256.txt | shasum -a 256 -c - )

mkdir -p "$prefix"
# --strip-components=1 puts bin/, lib/, include/ and share/ directly under the prefix, which is what
# makes ~/.local/bin/node the path everything else already expects.
tar -xJf "$staging/$name.tar.xz" -C "$prefix" --strip-components=1
installed="$("$prefix/bin/node" --version)"
[ "$installed" = "$version" ] || { echo "install-node: installed $installed, wanted $version" >&2; exit 1; }
echo "install-node: $installed at $prefix/bin/node"
case ":$PATH:" in
  *":$prefix/bin:"*) ;;
  *) echo "install-node: add $prefix/bin to PATH to use it as 'node'" >&2 ;;
esac
