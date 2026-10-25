# Lennox validation

## Version 0.1.7 native targets and responsive queue

The complete suite passes **213/213 tests** on Node 22 and Node 24 with the reviewed vendor bundle. Official Homey validation, build, real archive, and rejected-upload checks pass. The user's native thermostat comparison demonstrated the inactive cooling target moving from 76°F to 77°F as Heat changed to 74°F, with Heat mode retained. The new planner matches that behavior and confirms both changed targets. The scoped web layer batches quick presses after 600ms while remaining responsive during requests; native dragging keeps its one-second debounce and ordering. See [native evidence, queued controls, deployment and rollback](docs/QUEUED-CONTROLS.md).

## Version 0.1.6 readback correction

The complete suite passes **192/192 tests** on Node 22 and Node 24 with the reviewed vendor asset supplied. Homey CLI validation, build, and actual installation-archive checks pass. Six new HTTP cases reproduced a false confirmation failure when the pinned parser retained an omitted temperature-unit counterpart; these now confirm the applied heating, cooling, or single target. Contradictory paired reports and invalid single-unit reports still fail. ACK diagnostics preserve existing protocol behavior and expose only bounded numeric metadata. See [temperature readback evidence](docs/TEMPERATURE-READBACK.md) for the reproduction and the distinction from the user's physical failure.

The 0.1.5 local web controls and status selector remain unchanged. Their [live verification and rollback evidence](docs/HOMEY-WEB-CONTROLS.md) is separate from physical command acceptance. The following sections retain the earlier validation record.

## Version 0.1.4 baseline

Validated on October 24, 2026. This is a private Homey test release. App Store publication and physical thermostat acceptance are separate steps.

## Completed locally in isolated containers

- **154 tests pass** under Node 22 with production dependencies only, and under Node 24 with the Homey development tools, when the temporary reviewed vendor asset is supplied for the optional renderer integration checks. CI runs 149 tests and skips five optional checks because no vendor bundle is committed.
- JavaScript syntax and JSON validation pass.
- Official Homey CLI **4.6.1** debug validation and app build pass.
- The actual installer Dockerfile builds successfully and repeats syntax checks, all tests, Homey validation, and build.
- The persistent install packaging path is exercised with a fake devkit endpoint. Its real archive contains **212 files, about 1.65 MiB unpacked**, and excludes development dependencies, optional vendor-patch scripts, tests, and documentation. An upload rejection remains an error rather than being masked by an already installed app.
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

- Insights history rendering, Flow execution, full Homey service restart, ongoing physical-device recovery, simultaneous-client behavior, or a real heating/cooling/fan change. The app installer itself does not pair devices or send thermostat commands.
- Physical control writes and rollback remain acceptance steps. Emulated writes and the read-only browser checks below do not prove physical actuation.

## S40 pairing correction and physical read-only verification

After the user stopped only the Homebridge Lennox child bridge, read-only diagnostics from `iot-mgmt` confirmed the thermostat connected and responded. It delivered 69 messages in 18 seconds without an empty response, reported S40 identity in equipment 0's nested serial feature, and had one active zone plus three disabled zones. The pinned TypeScript client did not decode that serial, while the original Python implementation does.

Version 0.1.1 adds the missing identity decoder, settles the usable device catalog independently of unrelated message traffic, and drains queued startup messages promptly. The old one-second wait between queued responses could consume the deadline before zone configuration arrived. No timeout was simply increased to hide these defects.

The corrected complete backend pairing path was then run against the actual thermostat with `publishMessage` replaced by a throwing guard. It returned the stable controller identity and zone 0 in **6.042 seconds**, including temperature, humidity, supported modes, fan mode, and independently bounded heat/cool targets. The candidate was read-only; the diagnostic connection closed afterward. No thermostat command or controller reset was sent. Live serials and full device configuration were not copied into the repository.

This validates physical read-only discovery by the same backend from the Homey host. Subsequent actual Homey UI discovery and the later user-paired device's dial verification are recorded below; actual control writes remain untested by this validation.

Version 0.1.1 was then installed on the selected Homey through the verified local tunnel. The installer independently confirmed the expected version reached `running`. Existing Homey settings were preserved, and the user-controlled Homebridge Lennox child bridge remained stopped for the trial.

The existing Homebridge Lennox child bridge remains configured. The user stopped that child bridge before the physical discovery checks; this app does not modify Homebridge or restart it.

## Homey pairing session and view verification

The actual Homey 13.5.3 server implementation permits only one active pairing session per driver. It rejects overlapping attempts with HTTP 409, expires sessions after 35 seconds without a heartbeat, and removes expired same-driver sessions when a fresh attempt starts. Failed new attempts delete their own sessions, so the IDs printed with those failures do not identify the original lock holder.

In the user's Homey web interface, the old Lennox wizard was closed, the page refreshed, and the abandoned session allowed to expire. One fresh attempt opened successfully and the actual connection form discovered **one physical S40 zone**. The test wizard was then closed through Homey's confirmation modal, without creating a Homey thermostat device or changing thermostat settings. A second fresh wizard reopened successfully and was also closed cleanly; the server logged successful session creation (HTTP 200) and deletion (HTTP 204) for both attempts. No Homey service restart or broad session cleanup was required.

Review of the deployed view loader also showed that repair pages are served from `drivers/thermostat/repair/`, independently from `pair/`. Version 0.1.2 adds the missing repair entry page. Tests load the real manifest-selected paths, cover repair failure/retry/reopen, require equivalent pair and repair forms, and inspect the actual upload archive for both pages. Existing pairing initialization remains unchanged: the deployed pairing SDK supplies `window.Homey` before starting views.

Version 0.1.2 was installed through the verified localhost tunnel and independently reported as running on the selected Homey. Actual repair of a paired physical device remains unverified because this pairing test stopped before adding a thermostat.

The missing brand glyph was traced to the deployed web bundle's brand picker, which constructs only `https://icons-cdn.athom.com/<iconObj.id>.svg` and ignores the private app's local `iconObj.url`. The exact CDN URL returned HTTP 403, while the Homey's app and driver icon URLs both returned HTTP 200 with the correct SVG. The driver tile uses a loader with a local fallback and renders successfully. A full browser refresh did not fix the brand glyph. This project does not modify Homey's own web bundle or claim that changing SVG geometry fixes that upstream limitation.

## Approved Homey web icon workaround

After explicit user approval, a separate, guarded workaround was applied to the reviewed Homey 13.5.3 web bundle. It reuses Homey's existing local-capable icon loader without changing the Lennox runtime app or thermostat commands. The live apply, exact rollback, and reapply all passed file and HTTP checksum verification without a Homey restart. In the actual browser, the previously blank Lennox brand/header icons and selected thermostat tile displayed correctly; public app icons and device readings remained visible. Pairing opened normally and its test session was closed cleanly.

At the time of the icon workaround, the Node 22 and Node 24 suites each passed **106 tests**, including integration against the exact temporary vendor bundle. The subsequent dial correction expands that coverage below. No vendor bundle is committed. Existing Homey validation/build/packaging checks also pass, and all optional helper/test/docs files remain outside the installed app archive. See [Homey web icon deployment and rollback](docs/HOMEY-WEB-ICONS.md) for the approved scope, backup location, exact rollback command, and update limitations.

## Native temperature dial correction

The Homey 13.5.3 thermostat renderer was inspected directly and exercised in isolation. It hard-codes native `target_temperature`, `measure_temperature`, and `thermostat_mode` names with matching dot suffixes. The old `heat_target`/`cool_target` custom capabilities created a thermostat component but did not satisfy that lookup, producing a null target, a displayed 0.0-degree value, and no valid write capability.

Version 0.1.3 adds native `.heat`/`.cool` target controls and matching measurement/mode companions. Each native writer maps to the existing guarded heat/cool command path. The original custom capabilities, Flow actions, Insight histories, stable device identity, and settings remain. Single/dual transitions retain capability data and request component visibility changes. Explicitly unsupported directions are neutralized; incomplete metadata preserves existing controls.

The server's native thermostat-grouping pass runs before component option overrides: a matching target/measurement pair is always included. Consequently, the expanded tile lists both native targets and their current-temperature companions, and previously added native dials may remain visible after equipment reconfiguration despite `uiComponent: null`. Tests distinguish the requested options from this actual grouping behavior. Unsupported writes still reject through the existing planner, and retained direction modes explicitly become Off for confirmed single-setpoint equipment. No native capability history or Flow reference is deleted to work around the vendor grouping.

The actual renderer tests reproduce the old failure and verify correct target/current-temperature/mode lookup, units, limits, write IDs, single-target behavior, and 50 mode/temperature/direction color cases. The wire emulator now tests complete heating and cooling writes, preserving the opposite target, other zone, humidity, mode, and unrelated fields. Retained independent controls reject single-setpoint or unsupported-direction commands with zero publish requests. Existing read-only, schedule, permission, bounds, deadband, failed-write, and readback protections remain covered. All 118 tests pass in both supported Node versions with the temporary reviewed bundle.

Homey's blank Status Indicator selector is separate: the deployed settings screen and official capability documentation explicitly exclude thermostat devices from custom indicator selection. The native tile uses the base thermostat group and cannot represent a dual-auto band fully through the normal app SDK. The app does not fabricate a scalar auto target or add broad Homey API permissions. Dial colors represent temperature demand; `hvac_state` continues reporting actual device activity. At 75°F with a 72°F heat target, neutral coloring is expected.

Version 0.1.3 was then installed on the selected Homey and independently reported `running`, enabled, and not crashed. The existing user-paired Durham zone remained available with the same device ID, name, existing capability IDs, write preference, heat/cool targets, HVAC mode, and fan mode. Canonical before/after hashes of the existing normal and advanced Flow definitions matched (both inventories contained zero user Flows). Capability IDs were retained rather than removed; historical Insight records were not independently queried.

In the actual Homey web interface after a full refresh, Heating target displayed **72°F**, Cooling target displayed **76°F**, and both displayed **75°F** current temperature. Switching the target-view selector in both directions worked without sending a thermostat command. The real mode remained Heat and Operating state remained Idle, so neutral coloring was correct. Active orange/blue demand colors and command writes were verified against the reviewed renderer and emulator, not by changing the physical thermostat. The existing approved icon workaround retained the same served checksum and the Homey container did not restart.

## Mode-aware controls, precision and configurable gap

Version 0.1.4 corrects the app's earlier unconditional separation policy. Heat-only, Cool-only, and Off temperature writes enforce equipment limits independently of the opposite stored target. Automatic mode enforces the current reported separation; entering Automatic validates the existing targets first. This matches the user's physical-controller comparison. The official S40 guide names the setting Auto Changeover – Temp Deadband and documents 3–9°F, but does not establish the earlier claim that every operating mode must enforce it. Emulated success is not proof of physical actuation on every firmware.

Only the derived `target_temperature.heat` and `.cool` aliases are reconciled by mode. Heat shows heating, Cool shows cooling, Automatic shows both, and Off shows neither. The original custom targets and their Insights/Flow references, measurement IDs, base single target, device identity and settings remain. Mode metadata must be authoritative before pruning; retry and reopening restore current controls. Stateless precision buttons follow the same selection, calculating each change from a fresh period inside the serialized session queue.

Homey's Fahrenheit serializer converts values and bounds but leaves `step` unchanged. Live verification also established that Homey 13.5.3's app SDK reports only metric units while its API serializer selects Fahrenheit from the Homey's country. Using SDK units therefore left the actual Fahrenheit step at 0.5. The app now uses an explicit Temperature control units device setting, defaulting to Fahrenheit for the current installation. Native display options use 1°F or 0.5°C according to that preference, which should match the Homey display. It does not change the Homey or thermostat unit configuration. Regressions keep the SDK metric while selecting imperial controls to reproduce this runtime mismatch.

Command validation accounts for exact Fahrenheit-to-Celsius conversion at legitimate rounded endpoints, while validating both outgoing representations. Readback retains unit intent: Fahrenheit-canonical and Celsius-canonical reports can confirm their corresponding requested display value, while adjacent targets and contradictory pairs reject. Legacy Celsius Flow arguments remain unchanged.

Parameter 104 is decoded separately from upstream defaults and mirrored into Advanced Settings only after an actual report. A user edit requires an existing writable Homey device, actual editable parameter metadata and equipment type, valid reported descriptor/range/increment, and a whole requested value in the permitted 3–9°F intersection. Configuration is controller-wide: the session obtains a fresh parameter report and complete periods for every active zone, then rejects proposed gaps incompatible with any active Automatic zone. It sends the confirmed `systemControl.parameterUpdate` envelope with literal `AdditionalParameters: "/systemControl"`, requires HTTP 200 plus numeric acknowledgement code 1, and confirms a new matching parameter-104 report. A period-only echo cannot confirm it.

The emulator exercises the real parser and dedicated transport path, including complete gap writes, narrower ranges, increment validation, missing/disabled/ambiguous metadata, partial reports, negative/malformed acknowledgements, absent readback, all-zone freshness, cross-zone Automatic constraints, queue recovery, read-only settings, retry, and programmatic settings reflection without hardware commands. It also verifies independent Heat/Cool writes with a configured four-degree gap, Automatic boundary rejection, rapid relative adjustments, unit changes and hardware endpoints. All 154 tests pass with the reviewed frontend fixture on both supported Node versions.

The approved [Homey thermostat selection workaround](docs/HOMEY-WEB-THERMOSTAT.md) handles the vendor component's retained selection after mode-specific controls change. It was applied, rolled back to the exact icon-patched bytes, and reapplied with served-checksum verification and no Homey restart. The actual patched renderer selects the surviving writer in both transition directions in isolation. These checks do not claim a physical mode change.

Version 0.1.4 was installed in place and independently reported running, enabled, not crashed, with the existing Durham device available. Before/after comparison preserved its identity, name, read-only preference, original custom capability IDs, 72°F heating target, 76°F stored cooling target, Heat mode, Circulate fan setting and Flow definitions. Only the inactive derived cooling target alias was removed. Both normal and advanced user Flow inventories remained empty with identical canonical hashes.

In the actual browser after a full reload, the tile and detailed dial showed heating without cooling entries, the drag dial showed 72°F with 75°F current temperature, and the separate button tab rendered Heating − and Heating + with the correct glyphs. The final API readback confirmed imperial control units and a native heating range of 40–90°F with **step 1**, rather than the initially observed 0.5°F. No precision button or physical mode control was pressed during these checks.

The existing developer app's stdout was retrieved through the verified read-only `GET /api/manager/devkit/std/:session` path and filtered only for the policy diagnostic. It reported **3°F / 1.5°C**, `separationReported: true`, `separationEditable: true`, and an allowed range of **3–9°F**. This confirms the actual reported value rather than the number setting's default. The crash-log submission endpoint was not used. The final device setting remained 3°F. No temperature, mode, fan, or parameter write was performed on the physical controller; those write paths were tested against the loopback emulator.

## Live acceptance and rollback

1. For this installation, run `bash homey-apps/lennox/scripts/install.sh --via-foreman` for future updates. The existing CLI authentication is retained in its Docker volume. Select the self-hosted Homey.
2. Pause only the Lennox child bridge in Homebridge before pairing a thermostat in Homey.
3. Pair zones read-only and compare all displayed readings, modes, and state with the thermostat. Verify Homey restart/reopen and address repair.
4. When ready for control testing, select Manual at the thermostat, turn off Away, and record original values. Enable writes for one zone, make a small reversible change, confirm it at the device, then restore the original value.
5. Check a failed connection, retry/recovery, one Flow action, and one state condition.
6. To roll back, disable the Lennox app in Homey and resume the existing Homebridge Lennox child bridge. No Homebridge config or cache migration is required.
