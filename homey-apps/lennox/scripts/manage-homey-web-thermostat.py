#!/usr/bin/env python3
"""Manage the separately approved Homey 13.5.3 thermostat selection workaround.

Uses the existing tested deployment guards. Rollback retains the icon patch.
No service restart or thermostat setting change is performed.
"""
import hashlib
import importlib.util
from pathlib import Path
import sys

GUARDS_SHA256 = "677f7c8e9d3c528273ab1b40aa3b1d9f095f30a95021510210c1d150bf03d10d"
ORIGINAL_SHA256 = "40f1549b15cbdc1868df7d867f2596d3b4f773511424f19bbfccc8238be416db"
PATCHED_SHA256 = "5fddde7f128abfe1d23dfca4ebae3baa815995959fd14166c988c43684d54215"


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
    guards.PATCH_DIR = Path("/opt/docker/homey/local-patches/thermostat-selection-13.5.3")
    guards.BACKUP = guards.PATCH_DIR / "index-LWSkNFnB.js.original"
    guards.METADATA = guards.PATCH_DIR / "metadata.json"
    return guards


if __name__ == "__main__":
    try:
        load_guards().main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
