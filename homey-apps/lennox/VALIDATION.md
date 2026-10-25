# Lennox 0.1.2 validation

Validated on October 24, 2026. This is a private Homey test release. App Store publication and physical thermostat acceptance are separate steps.

## Completed locally in isolated containers

- **95 tests pass** under Node 22 with production dependencies only, and under Node 24 with the Homey development tools.
- JavaScript syntax and JSON validation pass.
- Official Homey CLI **4.6.1** debug validation and app build pass.
- The actual installer Dockerfile builds successfully and repeats syntax checks, all tests, Homey validation, and build.
- The persistent install packaging path is exercised with a fake devkit endpoint. Its real archive contains **210 files, about 1.63 MiB unpacked**, and excludes development dependencies. An upload rejection remains an error rather than being masked by an already installed app.
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
- Nested S30/M30 controller serial features and S40 equipment-0 identity, fragmented feature metadata, peripheral serial rejection, and ambiguous identity rejection.
- Continuous nonempty responses, late zones during a continuous stream, and a 70-message configuration backlog before zone discovery. Pairing settles the device catalog instead of requiring the entire stream to become idle.

The emulator intentionally does not represent every Lennox model or firmware. Its initial fixtures derive from the inspected protocol fields; it is not a substitute for a device test.

## Live installation verified

The user authorized the Homey CLI. The original installer incorrectly used `--skip-build`, which packed the complete development tree (77.57 MB, 12,335 files). That packaging defect is corrected and protected by the actual upload-archive check.

The corrected small archive still received HTTP 400 over the cloud relay. The local Homey route was unreachable directly from the Mac's Docker network, but reachable through the established `foreman` hop. Installation through a temporary localhost-only SSH tunnel succeeded on Homey Self-Hosted **13.5.3**. The API independently reported `com.metalcated.lennox` version `0.1.0`, `state: running`, `enabled: true`, `crashed: false`, and `origin: devkit_install`. This confirms persistent installation and app startup. The cloud rejection alone does not identify a specific proxy limit or server defect.

## Not yet verified live

- Rendered Homey thermostat controls, Insights, Flow execution, or lifecycle teardown/restart on that server. Mocked SDK tests do not prove those paths.
- Homey UI completion of physical-device pairing, ongoing physical-device recovery, simultaneous-client behavior, or a real heating/cooling/fan change. No thermostat was added to Homey by the installer.

## S40 pairing correction and physical read-only verification

After the user stopped only the Homebridge Lennox child bridge, read-only diagnostics from `iot-mgmt` confirmed the thermostat connected and responded. It delivered 69 messages in 18 seconds without an empty response, reported S40 identity in equipment 0's nested serial feature, and had one active zone plus three disabled zones. The pinned TypeScript client did not decode that serial, while the original Python implementation does.

Version 0.1.1 adds the missing identity decoder, settles the usable device catalog independently of unrelated message traffic, and drains queued startup messages promptly. The old one-second wait between queued responses could consume the deadline before zone configuration arrived. No timeout was simply increased to hide these defects.

The corrected complete backend pairing path was then run against the actual thermostat with `publishMessage` replaced by a throwing guard. It returned the stable controller identity and zone 0 in **6.042 seconds**, including temperature, humidity, supported modes, fan mode, and independently bounded heat/cool targets. The candidate was read-only; the diagnostic connection closed afterward. No thermostat command or controller reset was sent. Live serials and full device configuration were not copied into the repository.

This validates physical read-only discovery by the same backend from the Homey host. Subsequent actual Homey UI discovery is recorded below; adding the device and actual control writes remain untested.

Version 0.1.1 was then installed on the selected Homey through the verified local tunnel. The installer independently confirmed the expected version reached `running`. Existing Homey settings were preserved, and the user-controlled Homebridge Lennox child bridge remained stopped for the trial.

The existing Homebridge Lennox child bridge remains configured. The user stopped that child bridge before the physical discovery checks; this app does not modify Homebridge or restart it.

## Homey pairing session and view verification

The actual Homey 13.5.3 server implementation permits only one active pairing session per driver. It rejects overlapping attempts with HTTP 409, expires sessions after 35 seconds without a heartbeat, and removes expired same-driver sessions when a fresh attempt starts. Failed new attempts delete their own sessions, so the IDs printed with those failures do not identify the original lock holder.

In the user's Homey web interface, the old Lennox wizard was closed, the page refreshed, and the abandoned session allowed to expire. One fresh attempt opened successfully and the actual connection form discovered **one physical S40 zone**. The test wizard was then closed through Homey's confirmation modal, without creating a Homey thermostat device or changing thermostat settings. A second fresh wizard reopened successfully and was also closed cleanly; the server logged successful session creation (HTTP 200) and deletion (HTTP 204) for both attempts. No Homey service restart or broad session cleanup was required.

Review of the deployed view loader also showed that repair pages are served from `drivers/thermostat/repair/`, independently from `pair/`. Version 0.1.2 adds the missing repair entry page. Tests load the real manifest-selected paths, cover repair failure/retry/reopen, require equivalent pair and repair forms, and inspect the actual upload archive for both pages. Existing pairing initialization remains unchanged: the deployed pairing SDK supplies `window.Homey` before starting views.

Version 0.1.2 was installed through the verified localhost tunnel and independently reported as running on the selected Homey. Actual repair of a paired physical device remains unverified because the test stopped before adding a thermostat.

The missing brand glyph was traced to the deployed web bundle's brand picker, which constructs only `https://icons-cdn.athom.com/<iconObj.id>.svg` and ignores the private app's local `iconObj.url`. The exact CDN URL returned HTTP 403, while the Homey's app and driver icon URLs both returned HTTP 200 with the correct SVG. The driver tile uses a loader with a local fallback and renders successfully. A full browser refresh did not fix the brand glyph. This project does not modify Homey's own web bundle or claim that changing SVG geometry fixes that upstream limitation.

## Live acceptance and rollback

1. For this installation, run `bash homey-apps/lennox/scripts/install.sh --via-foreman` for future updates. The existing CLI authentication is retained in its Docker volume. Select the self-hosted Homey.
2. Pause only the Lennox child bridge in Homebridge before pairing a thermostat in Homey.
3. Pair zones read-only and compare all displayed readings, modes, and state with the thermostat. Verify Homey restart/reopen and address repair.
4. When ready for control testing, select Manual at the thermostat, turn off Away, and record original values. Enable writes for one zone, make a small reversible change, confirm it at the device, then restore the original value.
5. Check a failed connection, retry/recovery, one Flow action, and one state condition.
6. To roll back, disable the Lennox app in Homey and resume the existing Homebridge Lennox child bridge. No Homebridge config or cache migration is required.
