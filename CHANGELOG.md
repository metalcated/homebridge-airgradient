# Changelog

## 3.1.0-beta.3 — 2026-10-23

- Add PayPal funding metadata for npm and Homebridge's verified-plugin donation dialog.
- Add GitHub Sponsor configuration with the project's PayPal link.
- Add GitHub, npm and optional PayPal support links to the settings panel and README.
- Homebridge's native donation dialog remains subject to Homebridge verification.

## 3.1.0-beta.2 — 2026-10-23

- Fix selector, option, helper text, table and confirmation-dialog colors in Homebridge dark mode.
- Stage an empty configuration on first setup so Homebridge displays the settings form. Configuration is saved only when the user chooses Save.
- Show a clear empty-monitor state and disable connection/diagnostic/history/export actions until a monitor is configured.
- Preserve discovery cancellation and update action availability after schema edits.
- Add first-time setup regression checks in both light and dark modes.

## 3.1.0-beta.1 — 2026-10-23

This beta adds broader local-device support, diagnostics and optional controls.
It requires Node 22.13+ within Node 22, or Node 24/26. Physical-device and Apple
Home acceptance testing is still pending.

### Added

- Automatic support for legacy `/measures/current` and newer `/api/v1/measures`
  APIs, including endpoint renegotiation after a firmware API change.
- Optional hostname/IP, HTTP port and request timeout settings, with device serial
  verification before accepting readings.
- Monitor discovery, connection testing and an in-place review modal before
  staging a discovered device in Homebridge settings.
- Diagnostics for identity, firmware, Wi-Fi strength, reading ages, failures and
  connection errors, plus exports excluding network addresses and device configuration.
- Optional SQLite history with configurable retention, a 10,000-sample cap per
  monitor and recent PM/CO2 change summaries. History is disabled by default.
- CO2 clear thresholds and above-threshold duration settings.
- Battery percentage reporting when supported, without inferring charging state.
- Opt-in display/LED brightness controls for devices that support and permit
  local changes, with partial writes and verified readback.
- Automated HTTP, multicast, Homebridge accessory, settings UI, SQLite and actual
  Homebridge startup/shutdown/cache-restoration tests.

### Fixed

- VOC and NOx indices now use correctly labelled unitless characteristics rather
  than physical concentration characteristics.
- Invalid or missing individual measurements stop appearing indefinitely fresh.
- Partial-capability devices no longer acquire unrelated broken sensor services.
- Invalid configuration preserves cached accessories; duplicate sensors retain
  the first configured entry.
- Shutdown cancels requests and clears polling timers.
- Cancelling discovery enrollment during a connection check preserves configuration.

### Maintenance and validation

- Reproducible dependency installation and a Node/Homebridge CI matrix.
- Updated dependencies; the release-time audit reported no known vulnerabilities.
- All 26 tests passed on Node 22.13.0, 24 and 26 with Homebridge 1.6.0, 1.11.4,
  2.4.0 and 2.4.1-beta.13: 12 combinations. The suite also passed against the
  installed npm tarball on Homebridge 2.4.1-beta.13.

### Compatibility notes

- Custom gas indices may require a third-party HomeKit app; Apple's Home app does
  not display every custom characteristic.
- Cached legacy concentration and disabled brightness characteristics are
  preserved as unavailable. Their effect on client-wide availability needs
  physical Apple Home validation before a stable release.
- Discovery requires compatible firmware advertising `_airgradient._tcp` and a
  network that passes multicast. Manual host configuration remains available.
- Device controls and history are disabled by default. Hardware operation,
  actual network discovery and Apple Home rendering remain unverified.

## 3.0.1 — 2026-10-23

- Published the maintained fork as `@metalcated/homebridge-airgradient`.
- Fixed npm peer-dependency and Homebridge compatibility ranges to accept the
  Homebridge 2.4.1 beta series, including 2.4.1-beta.13.
- Preserved the legacy registration identifier for cached-accessory translation.
- Updated repository links and installation guidance for the scoped package.

## 3.0.0 — 2026-08-26

Inherited upstream release. Refactored sensor handling and configuration,
including cached-accessory reuse, offline handling and optional sensor readings.
