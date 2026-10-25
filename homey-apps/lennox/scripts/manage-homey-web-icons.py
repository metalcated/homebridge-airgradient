#!/usr/bin/env python3
"""Guard and manage the approved Homey 13.5.3 local web icon workaround.

Run as root on iot-mgmt. This changes one vendor JavaScript asset in the
existing container; it never restarts Homey or modifies Compose/userdata.
"""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import urllib.error
import urllib.request
import zlib


CONTAINER = "homey-shs"
ASSET = "/app/node_modules/@athombv/homey-web-app/assets/index-LWSkNFnB.js"
URL = "http://127.0.0.1:4859/web/assets/index-LWSkNFnB.js"
ORIGINAL_SHA = "f0f78b5c8de6ee86acaf75d14a551479aff9733e63005b68817bdb323789c717"
PATCHED_SHA = "40f1549b15cbdc1868df7d867f2596d3b4f773511424f19bbfccc8238be416db"
IMAGE_ID = "sha256:b667a1bcf491913485a909f126755d0f9cc15a1737285c1e61f5b7efd3acfa76"
IMAGE_DIGEST = "ghcr.io/athombv/homey-shs@sha256:9024190dae9bc0e500046fb016f6c52d57e333469a5cb2748fe9a2ae5f5020d5"
WEB_VERSION = "1.18.3-self-hosted.52"
PATCH_DIR = Path("/opt/docker/homey/local-patches/web-icon-fallback-13.5.3")
BACKUP = PATCH_DIR / "index-LWSkNFnB.js.original"
METADATA = PATCH_DIR / "metadata.json"
MAX_ASSET_BYTES = 8 * 1024 * 1024

READ_SCRIPT = r"""
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const asset = process.argv[1], stat = fs.lstatSync(asset);
if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Asset is not a regular file');
const data = fs.readFileSync(asset);
const variants = fs.readdirSync(path.dirname(asset)).filter(name =>
  name === path.basename(asset) + '.gz' || name === path.basename(asset) + '.br');
const pkg = JSON.parse(fs.readFileSync('/app/node_modules/@athombv/homey-web-app/package.json', 'utf8'));
console.log(JSON.stringify({sha256: crypto.createHash('sha256').update(data).digest('hex'),
  size: stat.size, mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid,
  mtime: stat.mtime.toISOString(), webVersion: pkg.version, variants}));
"""

WRITE_SCRIPT = r"""
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [asset, expectedBefore, expectedAfter] = process.argv.slice(1);
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const replacement = fs.readFileSync(0);
if (digest(replacement) !== expectedAfter) throw Error('Replacement checksum mismatch');
const original = fs.readFileSync(asset), st = fs.lstatSync(asset);
if (!st.isFile() || st.isSymbolicLink()) throw Error('Asset is not a regular file');
if (digest(original) !== expectedBefore) throw Error('Asset changed before replacement');
for (const extension of ['.gz', '.br']) {
  if (fs.existsSync(asset + extension)) throw Error('Unexpected precompressed asset');
}
const temporary = asset + '.icon-patch-' + crypto.randomBytes(12).toString('hex');
const descriptor = fs.openSync(temporary, 'wx', st.mode & 0o777);
try {
  fs.writeFileSync(descriptor, replacement);
  fs.fchownSync(descriptor, st.uid, st.gid);
  fs.fchmodSync(descriptor, st.mode & 0o777);
  fs.fsyncSync(descriptor);
} finally { fs.closeSync(descriptor); }
// Check again immediately before committing the replacement. A temporary file
// remains for inspection if a guard fails; existing files are never removed.
if (digest(fs.readFileSync(asset)) !== expectedBefore) throw Error('Asset changed before atomic rename');
fs.renameSync(temporary, asset);
const directory = fs.openSync(path.dirname(asset), 'r');
try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
if (digest(fs.readFileSync(asset)) !== expectedAfter) throw Error('Replacement verification failed');
console.log(JSON.stringify({sha256: expectedAfter, replaced: true}));
"""


class GuardError(RuntimeError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(arguments, input_bytes=None):
    result = subprocess.run(arguments, input=input_bytes, capture_output=True, timeout=60)
    if result.returncode:
        message = result.stderr.decode("utf-8", errors="replace").strip()[-4096:]
        raise GuardError(message or "The required Docker operation failed")
    return result.stdout


def container_info():
    template = ('{"id":{{json .Id}},"imageId":{{json .Image}},'
                '"imageName":{{json .Config.Image}},"startedAt":{{json .State.StartedAt}},'
                '"running":{{json .State.Running}},"restartCount":{{json .RestartCount}}}')
    info = json.loads(run(["docker", "inspect", CONTAINER, "--format", template]))
    if not info["running"]:
        raise GuardError("The existing Homey container is not running; no changes were made")
    info["repoDigests"] = json.loads(run([
        "docker", "image", "inspect", info["imageId"], "--format", "{{json .RepoDigests}}",
    ])) or []
    return info


def asset_info():
    return json.loads(run(["docker", "exec", CONTAINER, "node", "-e", READ_SCRIPT, ASSET]))


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise GuardError("The local asset endpoint redirected; refusing an unexpected serving path")


def http_info():
    request = urllib.request.Request(URL, headers={
        "Accept-Encoding": "identity", "Cache-Control": "no-cache",
    })
    # This verification must reach the host's loopback server directly, even if
    # an administrator's shell has HTTP proxy environment variables set.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirects)
    with opener.open(request, timeout=15) as response:
        data = response.read(MAX_ASSET_BYTES + 1)
        if len(data) > MAX_ASSET_BYTES:
            raise GuardError("The served asset exceeds the expected size")
        encoding = response.headers.get("Content-Encoding", "identity").lower().strip()
        if encoding == "gzip":
            data = gzip.decompress(data)
        elif encoding == "deflate":
            data = zlib.decompress(data)
        elif encoding not in ("", "identity"):
            raise GuardError("Unexpected HTTP content encoding; no automatic compressed-asset patching")
        if len(data) > MAX_ASSET_BYTES:
            raise GuardError("The decoded asset exceeds the expected size")
        return {"sha256": digest(data), "cacheControl": response.headers.get("Cache-Control"),
                "etag": response.headers.get("ETag"), "encoding": encoding}


def ensure_patch_directory():
    PATCH_DIR.mkdir(parents=True, mode=0o700, exist_ok=True)
    st = PATCH_DIR.lstat()
    if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode) or st.st_uid != 0:
        raise GuardError("The persistent patch directory must be a root-owned regular directory")
    os.chmod(PATCH_DIR, 0o700)


def read_regular(path, limit=MAX_ASSET_BYTES):
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode):
        raise GuardError("Expected a regular, non-symlink patch or backup file")
    if st.st_size > limit:
        raise GuardError("Patch or backup file exceeds the expected size")
    return path.read_bytes()


def read_metadata():
    if not METADATA.exists():
        return None
    return json.loads(read_regular(METADATA, 64 * 1024))


def check_vendor(container, asset):
    if container["imageId"] != IMAGE_ID or IMAGE_DIGEST not in container["repoDigests"]:
        raise GuardError("Homey's vendor image changed; this workaround must be reviewed before use")
    if asset["webVersion"] != WEB_VERSION:
        raise GuardError("The vendor web package version changed; refusing to patch another build")
    if asset["variants"]:
        raise GuardError("Unexpected .gz or .br asset variants exist; refusing a partial patch")


def verify_backup(metadata, patched_sha):
    if metadata is None or not BACKUP.exists():
        raise GuardError("The original backup and metadata are required; nothing will be overwritten")
    if (patched_sha != PATCHED_SHA or metadata.get("asset") != ASSET or metadata.get("originalSha256") != ORIGINAL_SHA
            or metadata.get("patchedSha256") != patched_sha or metadata.get("imageId") != IMAGE_ID
            or IMAGE_DIGEST not in metadata.get("repoDigests", [])):
        raise GuardError("Backup metadata does not match this exact vendor build and approved patch")
    original = read_regular(BACKUP)
    if digest(original) != ORIGINAL_SHA:
        raise GuardError("Original backup checksum does not match the known vendor asset")
    return original


def write_exclusive(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def verify_served(expected):
    file_state = asset_info()
    served = http_info()
    if file_state["sha256"] != expected or served["sha256"] != expected:
        raise GuardError("File/HTTP checksum verification failed; retain the backup and inspect before retrying")
    return file_state, served


def replace(container_id, expected_before, expected_after, data):
    # Pin the existing container ID so a concurrent vendor update cannot redirect
    # this write into a new container which has reused the same name.
    run(["docker", "exec", "-i", container_id, "node", "-e", WRITE_SCRIPT,
         ASSET, expected_before, expected_after], input_bytes=data)
    return verify_served(expected_after)


def status():
    container = container_info()
    asset = asset_info()
    served = http_info()
    metadata = read_metadata()
    patched = metadata.get("patchedSha256") if metadata else None
    state = "original" if asset["sha256"] == ORIGINAL_SHA else "patched" if patched and asset["sha256"] == patched else "unknown"
    return {"action": "status", "state": state, "container": container,
            "asset": {"path": ASSET, **asset}, "http": served,
            "metadataPresent": metadata is not None,
            "backupSha256": digest(read_regular(BACKUP)) if BACKUP.exists() else None}


def apply(patched_path, patched_sha):
    if patched_sha != PATCHED_SHA:
        raise GuardError("Provide the exact reviewed patched bundle SHA-256 for this workaround")
    patched_path = Path(patched_path)
    if patched_path.parent.resolve() != PATCH_DIR.resolve():
        raise GuardError("The reviewed patched bundle must be in the persistent patch directory")
    patched = read_regular(patched_path)
    if digest(patched) != patched_sha:
        raise GuardError("Patched input does not match the reviewed SHA-256")
    container = container_info()
    asset = asset_info()
    check_vendor(container, asset)
    metadata = read_metadata()
    if asset["sha256"] == patched_sha:
        verify_backup(metadata, patched_sha)
        verify_served(patched_sha)
        return {"action": "apply", "changed": False, "sha256": patched_sha, "container": container}
    if asset["sha256"] != ORIGINAL_SHA:
        raise GuardError("The live asset is neither the known original nor this approved patch; refusing overwrite")
    if http_info()["sha256"] != ORIGINAL_SHA:
        raise GuardError("The HTTP endpoint does not serve the inspected original asset")
    run(["docker", "exec", "-i", CONTAINER, "node", "--check", "--input-type=module"], input_bytes=patched)
    ensure_patch_directory()
    if metadata is not None or BACKUP.exists():
        verify_backup(metadata, patched_sha)
    else:
        original = run(["docker", "exec", container["id"], "node", "-e",
                        "process.stdout.write(require('fs').readFileSync(process.argv[1]))", ASSET])
        if digest(original) != ORIGINAL_SHA:
            raise GuardError("The original changed during backup preparation")
        write_exclusive(BACKUP, original)
        metadata = {"asset": ASSET, "originalSha256": ORIGINAL_SHA, "patchedSha256": patched_sha,
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                    "webVersion": WEB_VERSION, "imageId": container["imageId"],
                    "repoDigests": container["repoDigests"], "containerId": container["id"],
                    "startedAt": container["startedAt"], "originalMode": asset["mode"],
                    "originalUid": asset["uid"], "originalGid": asset["gid"], "originalMtime": asset["mtime"]}
        write_exclusive(METADATA, (json.dumps(metadata, indent=2) + "\n").encode())
    replace(container["id"], ORIGINAL_SHA, patched_sha, patched)
    after = container_info()
    if after["id"] != container["id"] or after["startedAt"] != container["startedAt"]:
        raise GuardError("The container changed during patching; inspect before further action")
    return {"action": "apply", "changed": True, "sha256": patched_sha, "container": after}


def rollback():
    container = container_info()
    asset = asset_info()
    check_vendor(container, asset)
    metadata = read_metadata()
    patched_sha = metadata.get("patchedSha256") if metadata else None
    original = verify_backup(metadata, patched_sha)
    if not patched_sha or not re.fullmatch(r"[0-9a-f]{64}", patched_sha):
        raise GuardError("Backup metadata has no valid approved patch checksum")
    if asset["sha256"] == ORIGINAL_SHA:
        verify_served(ORIGINAL_SHA)
        return {"action": "rollback", "changed": False, "sha256": ORIGINAL_SHA, "container": container}
    if asset["sha256"] != patched_sha:
        raise GuardError("The live asset changed beyond this patch; refusing to overwrite vendor or user changes")
    replace(container["id"], patched_sha, ORIGINAL_SHA, original)
    after = container_info()
    if after["id"] != container["id"] or after["startedAt"] != container["startedAt"]:
        raise GuardError("The container changed during rollback; inspect before further action")
    return {"action": "rollback", "changed": True, "sha256": ORIGINAL_SHA, "container": after}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    commands.add_parser("status")
    apply_parser = commands.add_parser("apply")
    apply_parser.add_argument("--patched-file", required=True)
    apply_parser.add_argument("--patched-sha256", required=True)
    commands.add_parser("rollback")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise GuardError("Run this guarded helper as root on iot-mgmt")
    if args.action == "status":
        result = status()
    elif args.action == "apply":
        result = apply(args.patched_file, args.patched_sha256)
    else:
        result = rollback()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (GuardError, OSError, ValueError, subprocess.SubprocessError, urllib.error.URLError) as error:
        print(json.dumps({"error": str(error), "changed": "inspect status; original backup is retained"}), file=sys.stderr)
        sys.exit(1)
