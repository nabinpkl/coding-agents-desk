# Sourced, not executed. One function: compile with swiftc unless the output is
# already newer than every input.
#
# The three grid-encoder legs of `just check` each ran `swiftc -O` on every
# invocation, together compiling several thousand lines whether or not a Swift
# file had moved. Most runs it has not: the working path in this repo is
# TypeScript, and `just swift-check` already exists for the runs where it is not.
# The guarantee is unchanged -- touch a source and it rebuilds -- and the cost is
# gone for the runs that were only ever proving the same binary again.
#
# The calling script counts as an input. Editing the source list in a build
# script has to rebuild, and its mtime is the only signal that happened.

swiftc_cached() {
  _sc_out="$1"
  shift
  mkdir -p "$(dirname "$_sc_out")"
  if [ -f "$_sc_out" ]; then
    _sc_stale=0
    # `$0` is the calling script: a staleness input, never a compile input.
    for _sc_src in "$0" "$@"; do
      if [ "$_sc_src" -nt "$_sc_out" ]; then
        _sc_stale=1
        break
      fi
    done
    if [ "$_sc_stale" -eq 0 ]; then
      echo "reused $_sc_out"
      return 0
    fi
  fi
  # Staged and moved so an interrupted compile never leaves a truncated binary
  # that the next run would happily consider fresh.
  _sc_staging="$(mktemp -d "$(dirname "$_sc_out")/.swiftc.XXXXXX")"
  if swiftc -O "$@" -o "$_sc_staging/out"; then
    mv "$_sc_staging/out" "$_sc_out"
    rmdir "$_sc_staging"
    echo "built $_sc_out"
  else
    _sc_status=$?
    rm -rf "$_sc_staging"
    return "$_sc_status"
  fi
}
