#!/usr/bin/env python3
"""Manage the separately approved Homey 13.5.3 Lennox thermostat controls workaround.

Uses the existing tested deployment guards. Rollback retains the icon and selection patches.
No service restart or thermostat setting change is performed.
"""
import hashlib
import importlib.util
from pathlib import Path
import sys

GUARDS_SHA256 = "677f7c8e9d3c528273ab1b40aa3b1d9f095f30a95021510210c1d150bf03d10d"
ORIGINAL_SHA256 = "5fddde7f128abfe1d23dfca4ebae3baa815995959fd14166c988c43684d54215"
PATCHED_SHA256 = "307892c8449d2445968b7b9c3c239b590e023a62a20fded4853c8c8af85ed522"


def load_guards():
    source = Path(__file__).with_name("manage-homey-web-icons.py")
    if hashlib.sha256(source.read_bytes()).hexdigest() != GUARDS_SHA256:
        raise RuntimeError("The reviewed deployment guards changed; review before use")
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("homey_web_patch_guards", source)
    guards = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guards)
    guards.__doc__ = __doc__
    guards.ORIGINAL_SHA = ORIGINAL_SHA256
    guards.PATCHED_SHA = PATCHED_SHA256
    guards.PATCH_DIR = Path("/opt/docker/homey/local-patches/thermostat-controls-13.5.3-r2")
    guards.BACKUP = guards.PATCH_DIR / "index-LWSkNFnB.js.original"
    guards.METADATA = guards.PATCH_DIR / "metadata.json"
    return guards


if __name__ == "__main__":
    try:
        load_guards().main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
