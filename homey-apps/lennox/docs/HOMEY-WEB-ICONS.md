# Optional Homey 13.5.3 web icon workaround

This is an explicitly approved, local workaround for Homey Self-Hosted Server's web interface. It is separate from the Lennox app, does not alter thermostat communication, and is excluded from the installed Homey app archive. The Lennox app remains version 0.1.2.

## Problem and scope

The reviewed Homey web bundle constructs public CDN URLs for installed app icons in the brand picker and subsequent headers. A private app's icon is served by Homey but is absent from that CDN. The normal driver icon loader already supports this local fallback.

The patch preserves the complete icon object and reuses that existing loader in the brand list, driver-list header, connection header, and selected-driver tile. Public App Store URL icons and Homey's virtual-device branding retain their existing branches. Authentication, network settings, device pairing logic, Flow actions, and vendor CSS are not modified.

The transformation accepts only `index-LWSkNFnB.js` from the reviewed Homey 13.5.3 build, with SHA256:

```text
f0f78b5c8de6ee86acaf75d14a551479aff9733e63005b68817bdb323789c717
```

The patched asset has SHA256:

```text
40f1549b15cbdc1868df7d867f2596d3b4f773511424f19bbfccc8238be416db
```

Nine individually guarded substitutions change icon metadata/rendering only. The transformation checks the original hash, requires each original fragment exactly once, parses the complete output as an ES module, and refuses to overwrite an input or existing output file. No complete vendor bundle is stored in this repository.

## Deployment and rollback

The operational helper is `scripts/manage-homey-web-icons.py`, for the authorized `iot-mgmt` host. It targets only `homey-shs` and the exact reviewed web asset. It records the container/image identity, retains the original file and checksums outside the container, and atomically replaces the static asset while preserving ownership and permissions. Unexpected content or compressed variants cause it to stop.

The host backup directory is:

```text
/opt/docker/homey/local-patches/web-icon-fallback-13.5.3
```

The original and patched files, management helper, and metadata are retained there. The directory is private to root. Rollback restores the original bytes and leaves the backup intact; an unknown or updated vendor asset is never overwritten. Neither application of the patch nor rollback requires a Homey restart.

From the Mac, check status with:

```sh
ssh -T foreman.gnet.com 'sudo -n ssh -T iot-mgmt python3 /opt/docker/homey/local-patches/web-icon-fallback-13.5.3/manage-homey-web-icons.py status'
```

Restore Homey's original interface with:

```sh
ssh -T foreman.gnet.com 'sudo -n ssh -T iot-mgmt python3 /opt/docker/homey/local-patches/web-icon-fallback-13.5.3/manage-homey-web-icons.py rollback'
```

Reapply the already reviewed patch to the same vendor build with:

```sh
ssh -T foreman.gnet.com 'sudo -n ssh -T iot-mgmt python3 /opt/docker/homey/local-patches/web-icon-fallback-13.5.3/manage-homey-web-icons.py apply --patched-file /opt/docker/homey/local-patches/web-icon-fallback-13.5.3/index-LWSkNFnB.js.patched --patched-sha256 40f1549b15cbdc1868df7d867f2596d3b4f773511424f19bbfccc8238be416db'
```

Reload the Homey browser tab after either change. The server's asset response uses `max-age=0`, but an already running page keeps its loaded JavaScript until reloaded.

## Lifetime and updates

This patch is in the current container's writable layer. It survives a normal restart of that container; recreation or a Homey image update replaces it with the vendor interface. It is deliberately not reapplied automatically and does not modify Docker Compose, mount a replacement web directory, or pin/replace the Homey image. The backup and management files remain on the host.

If a future Homey update restores the blank icon, inspect the new interface before considering another patch. Both preparation and deployment refuse an unreviewed bundle. Publishing a public Homey App Store app is a separate decision and is not performed by these helpers.

## Verification boundaries

Portable regression tests exercise installed app icons, URL-only App Store results, missing icon metadata, virtual-device branding, selected-driver icons, and refusal of missing/duplicate/already-patched source fragments. The complete reviewed vendor bundle is checked separately from a temporary local copy, including exact reversal to the original bytes.

The operational verification must also check served checksums before/after apply and rollback, unchanged container startup identity, browser rendering of the brand and header icons, existing public icons and device readings, and cancellation/reopening of the pairing wizard. A successful syntax check or HTTP response alone does not establish that the browser displays the icon.

## Verified deployment on October 24, 2026

The approved patch was applied on `iot-mgmt`, rolled back to the exact original SHA256, and reapplied. Each operation verified both the on-disk asset and the actual served HTTP response. Homey's container ID and start timestamp remained unchanged, with zero restarts. The original backup and metadata remained intact.

After a full reload in the user's existing browser, the Lennox glyph displayed in the brand list, the driver-list app header, and the connect-screen header. The thermostat glyph also displayed in the driver list and selected-driver tile. Existing public app icons and live AirGradient readings remained visible. The normal pairing page opened, and its test session was closed through Homey's confirmation modal without adding a device or contacting the thermostat.

Node 22 and Node 24 each passed all **106 tests**, including the exact reviewed vendor-bundle integration test from a temporary local copy. In CI without that vendor asset, 105 tests run and the one optional integration test is skipped; no vendor bundle is part of the repository or production dependencies. Homey debug validation, app build, and actual install-archive checks passed. Separate isolated execution of Homey's unchanged loader covered CDN success, local fallback after CDN failure, both sources failing, and absent icon metadata. The operational helper also passed fake-Docker guard/idempotency checks and the live rollback/reapply cycle.

The browser check used the user's existing dark theme and local HTTP connection. Other browsers, light-theme rendering, and a physical thermostat control change were not claimed as live validation.
