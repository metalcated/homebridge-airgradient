# Homebridge AirGradient

This plugin allows you to display the air quality values from your AirGradient devices in HomeKit.

### Installation

Install `@metalcated/homebridge-airgradient` in Homebridge. This is a maintained fork of [Smith8154/homebridge-airgradient](https://github.com/Smith8154/homebridge-airgradient).

Version 3.0.1 accepts Homebridge 2.4.1 beta releases, including 2.4.1-beta.13.
The 3.1 beta adds the improvements below and requires Node 22.13+, 24, or 26.
Keep your existing `AirGradientPlatform` configuration and sensor serial numbers.
When switching from the original package, back up Homebridge first and replace the original plugin before restarting; running both packages together registers the same platform twice.

### Features

 - Polls your AirGradient devices directly to add your air quality information into HomeKit
 - Add multiple AirGradient devices (specify devices by serial number)
 - Reporting values for PM 2.5, PM 10, TVOC, NOx, CO2, temperature, and humidity

### Contributing

Please feel free to contribute to this project in any way you see fit. If there are any features you would like, please open an issue and I will see what I can do, or feel free to open a pull request. If you want to help clean up or optimize the code, feel free to open a PR. I do not know TypeScript at all, I just know that this works.


### 3.1 beta

- Legacy `/measures/current` and newer `/api/v1/measures` support with automatic
  endpoint detection and serial verification. Missing sensors do not fabricate services.
- Optional hostname/IP and port, request timeouts, independent stale-reading detection,
  recovery, and shutdown cancellation.
- Correctly labelled, unitless VOC/NOx index characteristics. Custom characteristics
  may need a third-party HomeKit client; Apple Home does not display every custom value.
  Cached legacy concentration characteristics are preserved but marked unavailable.
- A Homebridge settings panel for discovery, connection tests, last-reading diagnostics,
  exports and history. Existing schema settings remain available below the panel.
- Optional SQLite history with configurable retention (0 disables new samples), a
  10,000-sample cap per monitor, and no browser storage. Diagnostics omit network addresses
  and full device configuration. Exports still contain serial numbers and readings.
- CO₂ alert clear threshold and above-threshold duration to reduce alert flapping.
- Battery percentage when a device reports it. Charging state is not inferred from voltage.
- Opt-in display/LED brightness controls when the device reports the capability and
  permits local configuration. Writes send only the selected setting and verify readback.
  Cloud, calibration, firmware and network settings are never changed by this plugin.

Controls and history are disabled by default. Discovery only finds monitors advertising
`_airgradient._tcp`; older firmware may require manual serial/host configuration. Discovery
never automatically adds or removes accessories. Keep supported firmware APIs in mind:
[legacy API](https://github.com/airgradienthq/arduino/blob/master/docs/local-server.md) and
[v1 API](https://github.com/Open-Air-Foundation/firmware-core/blob/main/docs/local_http_api.md).

See [emulator coverage and first-device validation](docs/VALIDATION.md) before treating
this beta as validated on physical hardware.
