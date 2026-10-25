#!/bin/sh
# swap-app.sh: replace the installed Don't Leave Updates To Fate bundle with the one in a downloaded
# disk image, after the running app has exited, then relaunch.
#
# Inputs arrive in the environment (paths contain an apostrophe, which arguments may not):
#   SWAP_DMG        the verified .dmg
#   SWAP_INSTALLED  the installed .app bundle
#   SWAP_LOG        the handover log
#   SWAP_PID        the app's process id, to wait for
#   SWAP_APP_OPEN   optional relaunch command (tests use /usr/bin/true)
#
# Whatever happens, an app bundle is left in place and opened: the new one if the swap worked, the old
# one otherwise.

OPEN="${SWAP_APP_OPEN:-/usr/bin/open}"
installed="$SWAP_INSTALLED"
dir="$(dirname "$installed")"
staged="$dir/.dlutf-staged.app"
old="$installed.old"

say() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$1" >> "$SWAP_LOG"; }

relaunch() { "$OPEN" "$installed" >/dev/null 2>&1; }

say "swap: starting for pid $SWAP_PID"

mount="$(mktemp -d "${TMPDIR:-/tmp}/dlutf-mount.XXXXXX")"
if ! /usr/bin/hdiutil attach -nobrowse -readonly -quiet -mountpoint "$mount" "$SWAP_DMG"; then
  say "swap: could not mount the downloaded image, keeping the current version"
  rmdir "$mount" 2>/dev/null
  relaunch
  exit 1
fi

source_app=""
for candidate in "$mount"/*.app; do
  [ -d "$candidate" ] && source_app="$candidate" && break
done

rm -rf "$staged"
if [ -z "$source_app" ] || ! /usr/bin/ditto "$source_app" "$staged"; then
  say "swap: could not copy the new version out of the image, keeping the current version"
  /usr/bin/hdiutil detach -quiet "$mount" 2>/dev/null
  rm -rf "$staged"
  relaunch
  exit 1
fi
/usr/bin/hdiutil detach -quiet "$mount" 2>/dev/null
rmdir "$mount" 2>/dev/null

# Wait for the app to exit before touching its bundle.
while kill -0 "$SWAP_PID" 2>/dev/null; do sleep 0.2; done
say "swap: app exited"

rm -rf "$old"
if mv "$installed" "$old" && mv "$staged" "$installed"; then
  /usr/bin/xattr -dr com.apple.quarantine "$installed" 2>/dev/null
  rm -rf "$old"
  say "swap: swapped in the new version"
  relaunch
  exit 0
fi

say "swap: could not swap the bundles, restoring the current version"
[ ! -d "$installed" ] && [ -d "$old" ] && mv "$old" "$installed"
rm -rf "$staged"
relaunch
exit 1
