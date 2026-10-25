# Lennox 0.1.0 validation

Validated on October 24, 2026. This is a private Homey test release. App Store publication and physical thermostat acceptance are separate steps.

## Completed locally in isolated containers

- **71 tests pass** under Node 22 with production dependencies only, and under Node 24 with the Homey development tools.
- JavaScript syntax and JSON validation pass.
- Official Homey CLI **4.6.1** debug validation and app build pass.
- The actual installer Dockerfile builds successfully and repeats syntax checks, all tests, Homey validation, and build.
- Runtime dependency audit reports **zero findings** with `lennoxapi@0.1.2` and locked `undici@6.29.1`.
- The Homey CLI development dependency tree has audit findings. These tools run in the build/installer container and are not included in the installed app. No forced downgrade or broad automatic dependency rewrite was applied.
- The independent AirGradient plugin's lint, TypeScript compilation, and **28 tests pass**. Its npm package dry run confirms that no Homey app files are included.

## Behavioral coverage

The tests exercise the actual pinned Lennox parser and HTTP/HTTPS transport against a loopback wire-protocol emulator, plus injected-client session tests and mocked Homey SDK/page lifecycle tests.

Covered paths include:

- Pair, failure, retry, cancellation, reopen, fragmented metadata, multiple zones, stable identity, and same-device repair after an IP change.
- Homey setting validation, persistence failure, repair rollback, stale callback rejection, dynamic capabilities/limits, and device deletion while a repair is pending.
- Shared serialized connections, independent per-zone freshness, normal empty long polls, stale readings, outage/reconnect, and immediate shutdown during startup or a hanging poll.
- Celsius/Fahrenheit representation, invalid sensor statuses, model-reported temperature limits and deadband, single versus dual setpoints, and malformed setpoint-mode metadata.
- Partial mode/fan/temperature commands, preserving unrelated period fields and other zones, read-only enforcement, known device permissions, disabled equipment, Away/manual-schedule guards, and no optimistic success on a command ACK.
- HTTP errors, invalid JSON, bounded responses, timeouts, foreign origins, redirects, self-signed HTTPS, and firmware responses with conflicting HTTP framing headers. Global certificate validation remains enabled.
- No controller-reset command in the app's recovery or command path.

The emulator intentionally does not represent every Lennox model or firmware. Its initial fixtures derive from the inspected protocol fields; it is not a substitute for a device test.

## Not yet verified live

- Homey account authorization and persistent installation into the user's self-hosted Homey.
- Actual Homey app startup/teardown, rendered thermostat controls, Insights, or Flow execution on that server. Mocked SDK tests and debug validation do not prove those paths.
- A connection to the user's physical thermostat, readback accuracy, simultaneous-client behavior, or a real heating/cooling/fan change.

The existing Homebridge Lennox child bridge remains configured and was not paused or modified. Its code warns about competing local clients, so physical pairing should wait until that child bridge is paused deliberately.

## Live acceptance and rollback

1. Run `bash homey-apps/lennox/scripts/install.sh`, authorize the official Homey CLI in your own browser/terminal, and select the self-hosted Homey.
2. Pause only the Lennox child bridge in Homebridge before pairing a thermostat in Homey.
3. Pair zones read-only and compare all displayed readings, modes, and state with the thermostat. Verify Homey restart/reopen and address repair.
4. When ready for control testing, select Manual at the thermostat, turn off Away, and record original values. Enable writes for one zone, make a small reversible change, confirm it at the device, then restore the original value.
5. Check a failed connection, retry/recovery, one Flow action, and one state condition.
6. To roll back, disable the Lennox app in Homey and resume the existing Homebridge Lennox child bridge. No Homebridge config or cache migration is required.
