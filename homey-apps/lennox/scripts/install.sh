#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
app_version="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$app_dir/package.json" | head -1)"
image_name="metalcated/homey-lennox-local:${app_version}"
container_name="homey-lennox-installer-$(date +%Y%m%d-%H%M%S)"
install_url=''
tunnel_pid=''
cleanup() { if [[ -n "$tunnel_pid" ]]; then kill "$tunnel_pid" 2>/dev/null || true; wait "$tunnel_pid" 2>/dev/null || true; fi; }
trap cleanup EXIT

case "${1:-}" in
  '') ;;
  --via-foreman)
    command -v ssh >/dev/null || { printf '%s\n' 'SSH is required for the tunnel option.' >&2; exit 1; }
    ssh_jump="${HOMEY_SSH_JUMP:-foreman.gnet.com}"
    ssh_target="${HOMEY_SSH_TARGET:-iot-mgmt}"
    tunnel_port="${HOMEY_TUNNEL_PORT:-14859}"
    [[ "$ssh_target" =~ ^[a-zA-Z0-9_.-]+$ && "$tunnel_port" =~ ^[0-9]+$ ]] || { printf '%s\n' 'Invalid tunnel host or port.' >&2; exit 1; }
    ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes \
      -L "127.0.0.1:${tunnel_port}:${ssh_target}:4859" "$ssh_jump" &
    tunnel_pid=$!
    sleep 1
    kill -0 "$tunnel_pid" || { printf '%s\n' 'The Homey tunnel could not start.' >&2; exit 1; }
    install_url="http://host.docker.internal:${tunnel_port}"
    ;;
  *) printf '%s\n' 'Usage: install.sh [--via-foreman]' >&2; exit 1 ;;
esac

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
  --env "HOMEY_INSTALL_URL=${install_url}" \
  "$image_name"
