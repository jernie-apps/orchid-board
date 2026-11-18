#!/bin/bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }

[[ $(uname -s) == Darwin && $UID != 0 ]] || fail 'Run this as the logged-in macOS user, without sudo.'
state="$HOME/.orchid/board"
root_ca="$state/caddy-data/caddy/pki/authorities/local/root.crt"
export_crt="$state/orchid-board-root.crt"
keychain=/Library/Keychains/System.keychain

if [[ $# == 1 && $1 == --dry-run ]]; then
  printf '[dry-run] Read Caddy root certificate: %s\n' "$root_ca"
  printf '[dry-run] Export public root certificate: %s\n' "$export_crt"
  printf '[dry-run] Ask before using sudo security add-trusted-cert for SSL in %s\n' "$keychain"
  exit 0
fi
[[ $# == 0 ]] || fail "Usage: $0 [--dry-run]"
[[ -f $root_ca ]] || fail "Caddy root certificate not found at $root_ca. Start the Caddy agent and check its error log."

stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
cp -- "$root_ca" "$stage/root.crt"
openssl x509 -in "$stage/root.crt" -noout -subject -sha256 -fingerprint
install -m 600 -- "$stage/root.crt" "$export_crt"
printf 'AirDrop only this public certificate to your iPhone: %s\n' "$export_crt"
printf 'This will use sudo to trust that CA for SSL in %s.\n' "$keychain"
if [[ ! -t 0 ]]; then
  printf 'No interactive terminal; certificate exported, keychain unchanged.\n'
  exit 0
fi
printf 'Type yes to update the System keychain, or press Return to skip: '
if read -r answer && [[ $answer == yes ]]; then
  sudo /usr/bin/security add-trusted-cert -d -r trustRoot -p ssl -k "$keychain" "$stage/root.crt"
  printf 'Caddy root CA trusted for SSL on this Mac.\n'
else
  printf 'Keychain unchanged.\n'
fi
