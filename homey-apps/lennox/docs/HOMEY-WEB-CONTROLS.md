# Lennox dial controls and status indicator

Version 0.1.5 fixes avoidable command delays in the Lennox app. A separate, reversible patch to the reviewed Homey Self-Hosted 13.5.3 web application adds small buttons to its native dial and enables the Lennox Status Indicator selector. The app installer does not patch vendor assets.

## Behavior

- The native draggable dial remains. Small − / + buttons sit below it on the same tab, using 1°F or 0.5°C adjustments according to the device's Temperature controls preference. The separate button tab is hidden; its six stateless command capabilities and listeners remain available.
- The exact Lennox driver can select Temperature, Humidity, Operating state, or None for its tile indicator. Choices use stable capability IDs that survive mode changes. Saved choices affect the tile; other thermostat drivers keep Homey's existing restriction. Homey's danger-alarm override remains in force.
- Only opted-in native temperature and relative button requests for this driver receive a 45-second web API timeout. Other capabilities and apps retain the vendor's original writer path. Existing optimistic rollback, notifications, and event subscriptions remain.

The app used to sleep one second after each nonmatching protocol response during refresh, even with more responses queued. Both normal and changeover-gap commands now use the existing 25ms drain interval for queued data, while empty responses retain normal pacing. A single 40-second app deadline includes queue wait, connection, refresh, publication, and confirmed readback. Expired queued or refreshing commands cannot publish later. An in-flight request keeps the shared queue until it settles, preventing overlapping clients. Commands are never automatically republished.

If publication already reached the thermostat before a deadline, it can still take effect. The error reports that the final state was not confirmed and directs the user to check the current reading before retrying. Privacy-safe timing logs contain only operation, phase, outcome, and durations.

## Pinned deployment and rollback

The combined generator is `scripts/patch-homey-13.5.3-controls.cjs`. It composes the button/writer and status fragments, verifies every source fragment exactly once, checks the entire input checksum, and validates the generated JavaScript syntax. It requires the existing icon and dial-selection workarounds.

| Layer | SHA-256 |
| --- | --- |
| Existing icon and selection layer | `5fddde7f128abfe1d23dfca4ebae3baa815995959fd14166c988c43684d54215` |
| Final controls layer | `307892c8449d2445968b7b9c3c239b590e023a62a20fded4853c8c8af85ed522` |

The persistent root-owned deployment directory on `iot-mgmt` is:

```text
/opt/docker/homey/local-patches/thermostat-controls-13.5.3-r2
```

It holds the exact previous bundle, replacement, metadata, and `manage-homey-web-controls.py`. The helper imports the unchanged, checksum-pinned icon deployment guards. It verifies the vendor image, web version, container identity, current asset, backup, and served HTTP checksum. Atomic replacement retains ownership and permissions. Unexpected bundles or compressed asset variants fail closed. It does not restart Homey or modify Compose, authentication, network settings, or thermostat configuration.

Rollback only this layer, preserving the icon and selection workarounds:

```sh
ssh -T foreman.gnet.com 'sudo -n ssh -T iot-mgmt python3 /opt/docker/homey/local-patches/thermostat-controls-13.5.3-r2/manage-homey-web-controls.py rollback'
```

Reapply the reviewed layer:

```sh
ssh -T foreman.gnet.com 'sudo -n ssh -T iot-mgmt python3 /opt/docker/homey/local-patches/thermostat-controls-13.5.3-r2/manage-homey-web-controls.py apply --patched-file /opt/docker/homey/local-patches/thermostat-controls-13.5.3-r2/index-LWSkNFnB.js.patched --patched-sha256 307892c8449d2445968b7b9c3c239b590e023a62a20fded4853c8c8af85ed522'
```

A Homey update or container recreation can replace these optional interface changes. Re-review the new vendor asset instead of applying this version-specific patch blindly. Earlier layout evidence remains backed up in `thermostat-controls-13.5.3`; it was rolled back before the final layout was applied. No backup was removed.

## Verification

The complete suite passes 176/176 on Node 22 and Node 24, including the reviewed vendor bundle. Tests execute the patched native renderer, capability writer, settings choices, and tile renderer; verify exact reversal; preserve the radial drag implementation; and cover driver scope, selection changes, bounds, read-only behavior, pending duplicate suppression, error rollback, one notification, and retry.

Real loopback HTTP tests exercise the pinned Lennox parser with 140 unrelated notifications before each refresh and readback. Heat and controller-gap commands complete in about 0.8 seconds in this emulator, with production polling/drain intervals and exactly one publication. Further HTTP tests cover queue expiry, cold connection expiry, hung refresh, cumulative publication deadlines, late acknowledgement, missing timely readback, and explicit recovery. These are emulator results, not measurements of the physical thermostat's command latency.

Live verification on 2026-10-24 confirmed the existing paired device is available with app 0.1.5 running and enabled. The final browser view shows the native 72°F heating dial, 75°F current reading, and small − / + buttons immediately below it; the separate button tab is absent. The Status Indicator picker offers all four choices. Humidity and Operating state were saved, displayed on the tile, and persisted after reopening settings. The display was then returned to Temperature. Device identity, read-only preference, temperature units, 3°F gap setting, 72°F/76°F stored targets, Heat mode, Circulate fan setting, and Flow definitions were retained across the app update.

The final web patch was applied, rolled back to the exact icon-and-selection layer, and reapplied. File and served HTTP checksums matched; the Homey container identity, start time, and zero restart count were unchanged. This verifies the local interface and rollback path. Physical command latency and button/drag acceptance remain hardware checks; no physical setpoint, mode, fan, or gap command was sent by this validation workflow.
