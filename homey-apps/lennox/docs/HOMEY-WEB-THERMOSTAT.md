# Optional Homey 13.5.3 thermostat selection workaround

This is a separate operational change to Homey's vendor web interface. The Lennox app installer does not apply it. Explicit user approval is required before deployment under the project's instruction: "Do not make operational changes in the code without consulting me first."

## Exact problem and scope

Homey's thermostat component stores its selected capability once. If a mode change removes that target, the mounted component can continue looking up the removed ID and display a blank or zero target. The device store batches updates, so an intermediate state without a thermostat component does not guarantee a remount. Closing and reopening the device control is the supported recovery with the original frontend.

The proposed patch derives a valid selection from the currently available thermostat targets on each render. It preserves a valid user selection and otherwise chooses the first available target. It leaves the drag handler, temperature values, button behavior, authentication, permissions, thermostat commands, and CSS unchanged.

The transformer accepts only the reviewed Homey 13.5.3 bundle **after** the previously approved icon workaround. It performs one guarded source substitution and validates the complete JavaScript output. Existing icon behavior is preserved. No vendor bundle is committed.

| State | SHA256 |
| --- | --- |
| Existing icon workaround | `40f1549b15cbdc1868df7d867f2596d3b4f773511424f19bbfccc8238be416db` |
| Icon plus thermostat selection fix | `5fddde7f128abfe1d23dfca4ebae3baa815995959fd14166c988c43684d54215` |

## Deployment and rollback

The wrapper `scripts/manage-homey-web-thermostat.py` reuses the exact reviewed, checksum-pinned guards in `scripts/manage-homey-web-icons.py`. Both files must be placed in the same patch directory. The wrapper has its own backup and metadata directory:

```text
/opt/docker/homey/local-patches/thermostat-selection-13.5.3
```

After approval, prepare the patched output from the existing icon-patched asset, retain that input as the rollback backup, and use:

```sh
python3 /opt/docker/homey/local-patches/thermostat-selection-13.5.3/manage-homey-web-thermostat.py apply --patched-file /opt/docker/homey/local-patches/thermostat-selection-13.5.3/index-LWSkNFnB.js.patched --patched-sha256 5fddde7f128abfe1d23dfca4ebae3baa815995959fd14166c988c43684d54215
```

The helper verifies the current image and bundle, atomically replaces only the reviewed static asset, and checks the served checksum. It never restarts Homey. Reload the browser after applying the change.

Rollback only this selection workaround with:

```sh
python3 /opt/docker/homey/local-patches/thermostat-selection-13.5.3/manage-homey-web-thermostat.py rollback
```

That restores the exact icon-patched bytes. To remove both workarounds, roll back the thermostat workaround **first**, then the icon workaround. Each helper refuses to overwrite changes made after its own patch. A normal container restart preserves the workaround; container recreation or a vendor update replaces it. Nothing reapplies automatically.

## Verification

Portable tests reproduce retained invalid selections, verify Heat/Cool transitions and preservation of valid choices, and reject missing, duplicate, already-patched, or unreviewed input. An optional test executes the actual patched renderer against removed selections in both directions and verifies the surviving temperature writer. The exact bundle parses and reverses to the prior icon-patched bytes.

These tests do not constitute a live deployment or physical thermostat mode change. Live verification must separately establish served checksums, unchanged container identity, browser rendering, and rollback. No physical mode change is required to check static asset deployment.

## Approved deployment on October 24, 2026

After explicit user approval, the workaround was applied, rolled back to the exact icon-patched bytes, and reapplied on `iot-mgmt`. The management guards verified the served checksum after each operation. The Homey container identity and start time remained unchanged, with zero restarts. Both backups and management metadata remain in their separate directories. This sequence did not send any thermostat command.

After the Lennox app update and a full browser reload, the native heating dial displayed the actual target and current measurement, the inactive cooling control was absent in Heat mode, and the native precision-button tab rendered correctly. Switching physical operating modes remained an emulator/renderer test; no live mode command was sent.
