#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
app_version="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$app_dir/package.json" | head -1)"
image_name="metalcated/homey-lennox-local:${app_version}"
container_name="homey-lennox-installer-$(date +%Y%m%d-%H%M%S)"

command -v docker >/dev/null || { printf '%s\n' 'Docker is required. Start Docker and run this script again.' >&2; exit 1; }
docker info >/dev/null
docker build --tag "$image_name" "$app_dir"

printf '%s\n' \
  'Select your self-hosted Homey when prompted.' \
  'If Homey asks you to sign in, open its link in your browser.' \
  'Paste any sign-in code only into this terminal, never into chat.' \
  'Installation adds the Lennox app; it does not pair or control a thermostat.' \
  'Your Homey login stays in the homey-lennox-cli-auth Docker volume.'

docker run --interactive --tty --name "$container_name" \
  --env HOMEY_HOME=/auth \
  --mount type=volume,source=homey-lennox-cli-auth,target=/auth \
  "$image_name"
