#!/bin/sh
# Install the latest AI Coding Tool release.
#
#   curl -fsSL https://raw.githubusercontent.com/zyuapp/ai-coding-tool/main/install.sh | sh
#
# macOS gets the signed app in /Applications. Linux gets the AppImage in ~/Applications,
# which is the only Linux package that updates itself without asking for a password.
set -eu

REPO="zyuapp/ai-coding-tool"
DOWNLOAD="https://github.com/$REPO/releases/latest/download"

fail() { printf '\nInstall failed: %s\n' "$1" >&2; exit 1; }
say() { printf '%s\n' "$1"; }

# electron-builder publishes one update manifest per platform, naming the primary
# artifact and its checksum, so the installer never has to guess a filename.
manifest_for() {
  case "$1" in
    Darwin)
      if [ "$2" = "x86_64" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ]; then
        set -- "$1" arm64
      fi
      [ "$2" = "arm64" ] || fail "macOS builds are Apple silicon only, and this Mac is $2."
      echo latest-mac.yml
      ;;
    Linux)
      case "$2" in
        x86_64 | amd64) echo latest-linux.yml ;;
        aarch64 | arm64) echo latest-linux-arm64.yml ;;
        *) fail "Linux builds cover x86_64 and arm64, and this machine is $2." ;;
      esac
      ;;
    *) fail "$1 is not supported yet." ;;
  esac
}

field() { printf '%s\n' "$manifest" | sed -n "s/^$1: *//p" | head -n 1 | tr -d "\"'"; }

verify() {
  command -v openssl >/dev/null 2>&1 || { say "Skipping the checksum because openssl is missing."; return; }
  [ "$(openssl dgst -sha512 -binary "$1" | openssl base64 -A)" = "$2" ] \
    || fail "The download did not match its checksum. Try again."
}

launch_linux() {
  [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || return 0
  if command -v setsid >/dev/null 2>&1; then
    setsid "$1" >/dev/null 2>&1 &
  else
    "$1" >/dev/null 2>&1 &
  fi
}

# An AppImage cannot mount itself without the FUSE 2 library, which several distributions
# no longer install by default.
has_fuse2() {
  for directory in /lib /lib64 /usr/lib /usr/lib64 /usr/local/lib "/usr/lib/$(uname -m)-linux-gnu"; do
    if [ -e "$directory/libfuse.so.2" ]; then return 0; fi
  done
  PATH="$PATH:/sbin:/usr/sbin" ldconfig -p 2>/dev/null | grep -q "libfuse\.so\.2"
}

# One command per package manager, printed as well as run, so it can be repeated by hand.
fuse2_command() {
  case "$(. /etc/os-release 2>/dev/null; printf '%s %s' "${ID:-}" "${ID_LIKE:-}")" in
    *arch*) echo "pacman -S --needed --noconfirm fuse2" ;;
    *ubuntu* | *debian*) echo "apt-get install -y libfuse2t64" ;;
    *fedora* | *rhel*) echo "dnf install -y fuse-libs" ;;
    *suse*) echo "zypper install -y libfuse2" ;;
  esac
}

# Empty when this system has no known command, so callers fall back to explaining the step.
fuse2_root_command() {
  base="$(fuse2_command)"
  [ -n "$base" ] || return 0
  if [ "$(id -u)" = 0 ]; then printf '%s' "$base"; return 0; fi
  command -v sudo >/dev/null 2>&1 && printf 'sudo %s' "$base"
  return 0
}

# The sudo password prompt is the user's chance to refuse, and it reads the terminal directly,
# so this still works when the script itself arrived on stdin through a pipe.
install_fuse2() {
  privileged="$(fuse2_root_command)"
  [ -n "$privileged" ] || return 1
  say "AI Coding Tool needs the FUSE 2 library. Installing it with: $privileged"
  # Word splitting is intended: every branch above is a fixed command with fixed arguments.
  $privileged || return 1
  has_fuse2
}

command -v curl >/dev/null 2>&1 || fail "curl is required."

system="$(uname -s)"
manifest_name="$(manifest_for "$system" "$(uname -m)")"
manifest="$(curl -fsSL "$DOWNLOAD/$manifest_name")" || fail "Could not read the latest release ($manifest_name)."
asset="$(field path)"
checksum="$(field sha512)"
version="$(field version)"
[ -n "$asset" ] && [ -n "$checksum" ] || fail "The release manifest could not be read."

if [ "$system" = Darwin ]; then
  applications=/Applications
  [ -w "$applications" ] || applications="$HOME/Applications"
else
  applications="$HOME/Applications"
fi
mkdir -p "$applications"

# Stage inside the destination so the final move is a rename on the same filesystem.
staging="$applications/.aicodingtool-install.$$"
rm -rf "$staging"
mkdir "$staging"
trap 'rm -rf "$staging"' EXIT INT TERM

say "Downloading AI Coding Tool $version for $(uname -s) $(uname -m)."
curl -fL --retry 3 --progress-bar -o "$staging/$asset" "$DOWNLOAD/$asset" \
  || fail "The download did not finish."
verify "$staging/$asset" "$checksum"

if [ "$system" = Darwin ]; then
  if pgrep -f "/AI Coding Tool.app/Contents/MacOS/" >/dev/null 2>&1; then
    fail "AI Coding Tool is running. Quit it, then run this again."
  fi
  /usr/bin/ditto -x -k "$staging/$asset" "$staging/unpacked" || fail "The download could not be unpacked."
  bundle="$(cd "$staging/unpacked" && ls -d ./*.app 2>/dev/null | head -n 1 | sed 's|^\./||')"
  [ -n "$bundle" ] || fail "The download contained no app."
  target="$applications/$bundle"
  rm -rf "$target"
  mv "$staging/unpacked/$bundle" "$target"
  xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
  say "Installed $target"
  open -a "$target"
else
  target="$applications/AICodingTool.AppImage"
  chmod 755 "$staging/$asset"
  mv -f "$staging/$asset" "$target"
  say "Installed $target"
  if has_fuse2 || install_fuse2; then
    launch_linux "$target"
    say "It adds itself to your app menu the first time it runs."
  else
    manual="$(fuse2_root_command)"
    [ -n "$manual" ] || manual="install the FUSE 2 library"
    say "It needs FUSE 2 before it can start: $manual, then run $target once."
  fi
fi
