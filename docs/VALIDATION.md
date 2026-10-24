# Emulated validation and first-device checks

This beta adds both local API generations, capability-based services, correctly
labelled gas indices, connection overrides, diagnostics, optional history and
opt-in display controls. Emulation does not establish physical-device or Apple
Home compatibility.

## Reproduce

Use Node 22.13 or newer in the supported 22, 24 or 26 release lines:

```sh
npm ci --ignore-scripts
npm run lint
npm run build
npm test
npm audit --omit=dev
npm pack --dry-run --ignore-scripts
```

Dependency installation for this change was performed in isolated Docker
containers, not in the workstation checkout. The CI workflow repeats tests for
Homebridge 1.6.0, 1.11.4, 2.4.0 and 2.4.1-beta.13 across Node 22, 24 and 26.

The emulator opens actual loopback HTTP endpoints with mutable readings, delayed
responses and configurable HTTP failures. Multicast discovery publishes a real
`_airgradient._tcp` advertisement. Platform tests instantiate the actual
Homebridge API and HAP accessory classes. UI tests exercise the DOM with a mocked
Homebridge parent and separately fork the real plugin UI server using its IPC
protocol. These are complementary checks; the mocked parent is not a running
Homebridge dashboard or an Apple Home client.

## Covered scenarios

- Legacy and v1 API selection, normalized field names, cached endpoint selection,
  serial mismatch, malformed responses, partial payloads and unsupported endpoints.
- HTTP errors, request timeout, cancellation and no fallback on authentication errors.
- First registration, cached accessory reuse, duplicate entries, preserved room
  metadata, invalid configuration protection and intentional configured-device removal.
- Bad and missing individual readings, all-invalid responses, offline transition,
  recovery, compensated fallbacks, negative temperatures and capability-based services.
- Unitless VOC/NOx indices, legacy density characteristics kept unavailable, battery
  reporting only when available and no fabricated charging state.
- CO2 trigger/clear thresholds, duration, threshold noise and interrupted observations.
- Opt-in display controls, partial writes, local-control permission, delayed readback,
  rejected writes, retry, restoring previous brightness and revoking opt-in.
- SQLite history off by default, retention expiry, reopening and diagnostics redaction.
- Discovery review/cancel/approve, duplicate add, connection failure/retry, configuration
  edit, reopen, diagnostics, history and no browser prompts or browser storage.
- Real UI server startup/IPC, configured-sensor access checks, custom config-file path
  and diagnostics across UI-server restarts.

## First physical-device validation

1. Record the monitor model, firmware and Homebridge/Node versions. Make a Homebridge
   backup before switching from an existing plugin installation.
2. Install the beta package, keep one AirGradient plugin active, and retain serial
   numbers and the `AirGradientPlatform` alias. Save and restart Homebridge.
3. Test the connection using the settings panel. Confirm the reported model/serial
   and API generation match the physical device. Try discovery; use an IP override
   if the actual network does not pass multicast.
4. Compare PM, CO2, temperature and humidity with the device's local response, including
   compensated values if enabled. Confirm VOC and NOx remain indices, not concentrations.
5. Confirm Apple Home placement, names, units, CO2 alert behavior and the behavior of
   supported third-party HomeKit apps for custom gas-index characteristics. Custom
   characteristics are not guaranteed to appear in Apple's Home app.
6. Disconnect the monitor, wait for the configured failure threshold, then reconnect.
   Check unavailable/recovery states, preserved scenes/rooms, and diagnostic ages.
7. Restart Homebridge and reopen settings. Confirm accessory reuse and history survives.
8. Only if desired, enable display controls and restart. Change brightness through
   HomeKit, compare with the device, then restore the original brightness. Check that
   cloud-managed settings cannot be silently overridden. Disable controls and restart;
   retained control services should become unavailable rather than silently accepting writes.

## Compatibility and rollback

The package retains the original plugin registration identifier to allow Homebridge
translation of cached accessories into the scoped package. It preserves accessory UUIDs
and existing configuration fields. It never removes cached legacy density or brightness
characteristics as part of a migration. Legacy density values become unavailable because
an index is not a physical concentration. This may surface an unavailable state in clients
that aggregate all characteristics; physical Apple Home testing is required before a
stable release. A future explicit migration can address obsolete characteristics after
review and approval.

History is opt-in, capped at 10,000 samples per monitor, and stored alongside diagnostic
snapshots in `airgradient.sqlite` under Homebridge's storage directory. Retention prunes
old history samples; disabling history stops new samples but retains existing data.
The database can be backed up with Homebridge stopped. Rolling back the plugin does not
require deleting it. Restoring the prior Homebridge backup is the authoritative route
if a client needs its exact previous accessory cache. Do not run both plugin packages
at the same time.

No physical monitor, mobile Home app, real Wi-Fi loss, or display hardware was available
during development. The beta is not a claim of hardware acceptance.

## Interactive emulator

`npm run emulate` starts a legacy monitor using only Node's built-in modules;
`npm run emulate -- --v1` starts v1. It prints a sensor configuration using a
loopback address and an automatically selected port. Homebridge must run on the
same host as the emulator. Enter `offline`, `healthy`, `invalid`, `high-co2`,
`legacy`, `v1`, or `quit` to change scenarios. In auto mode the plugin renegotiates its API if a firmware change removes the
previous endpoint. Forced API mode never silently switches endpoints. The automated suite
uses isolated emulator instances and does not require this interactive process.


## Recorded emulation results

The 26-test suite passed on the following isolated runtime combinations. These
include actual Homebridge boot, polling, graceful shutdown and persisted-cache
restoration, in addition to the HTTP, HAP, UI, discovery and database checks above.

| Node | Homebridge 1.6.0 | Homebridge 1.11.4 | Homebridge 2.4.0 | Homebridge 2.4.1-beta.13 |
| --- | --- | --- | --- | --- |
| 22.13.0 | Pass | Pass | Pass | Pass |
| 24 | Pass | Pass | Pass | Pass |
| 26 | Pass | Pass | Pass | Pass |

The locked development dependency set also passed lint, compilation and all tests
on Node 22. The final dependency audit reported zero known vulnerabilities in both
production and development dependencies. This is the registry advisory result at
test time, not a guarantee against undisclosed defects.

Builds use the locked Homebridge 1.x development types, then execute the compiled
plugin against the selected Homebridge runtime. Recompiling against the beta's
Matter dependency declarations with this project's legacy module-resolution
settings is not supported; runtime compatibility is exercised separately. The
new settings panel received a browser visual check with simulated device data and
a simulated Homebridge parent. Actual Homebridge dashboard theming and Apple Home
rendering still require first-device validation.

The final npm tarball was installed into a fresh environment alongside Homebridge
2.4.1-beta.13. The same 26 tests passed against its installed files, including full
bridge lifecycle and UI IPC. Test sources were supplied separately for validation;
they are excluded from the published package. Compiled modules, configuration schema,
license, README and all custom UI assets were present in the tarball.

Tarball SHA-256:
`fd86a7c96b6320390cff202e2f2d645f6e00fc6875bf8ec7aabe1f97e5e4db70`.
