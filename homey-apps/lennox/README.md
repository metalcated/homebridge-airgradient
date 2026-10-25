# Lennox for Homey

A native Homey SDK v3 app for Lennox iComfort thermostats with the compatible local LAN API. Targets Homey Pro and Homey Self-Hosted Server **12.9.0 or newer**. Version **0.1.4** is a private test release, not an App Store publication or a claim of Lennox certification.

## What it provides

- Manual IP/hostname pairing with zone selection and stable serial/zone identities.
- Temperature, humidity when reported, operating state, supported HVAC modes, and fan modes.
- Native draggable temperature dials that follow the selected mode: heating in Heat, cooling in Cool, and both in Automatic. Separate precision buttons provide one-degree Fahrenheit or half-degree Celsius adjustments. Single-setpoint systems use their normal single target. Custom Flow temperature arguments are explicitly Celsius.
- Heating, cooling, fan actions and operating-state conditions in Flow. Native capabilities also provide Homey's normal cards and Insights where supported.
- Read-only mode enabled for each new device. Disable it in that device's advanced settings to permit commands.
- A shared connection for all zones on the same address, bounded requests, reconnect attempts, stale-zone detection, and confirmation of writes through fresh reported state.
- Repair for an address change, verifying the thermostat serial and zone before replacing the connection.
- An advanced controller-wide automatic-changeover gap setting, using the reported editable parameter and confirmed readback.

The underlying `lennoxapi@0.1.2` advertises S30/S40/E30/M30 LAN support. Our local tests use emulated S30/S40/M30-shaped messages; physical compatibility of other models remains to be verified. No vendor cloud account or password is used.

Version 0.1.1 also verifies read-only backend discovery on the user's S40. It supports the controller identity nested in equipment features, continuous notification traffic, and the initial configuration backlog. The actual Homey pairing screen has also discovered the physical S40 zone. Adding the device and testing real control changes remain separate acceptance steps. Version 0.1.2 supplies Homey's dedicated repair view and checks that both pairing and repair pages are included in the installation archive.

## Install without local npm dependencies

From the repository checkout, run:

```sh
bash homey-apps/lennox/scripts/install.sh
```

Or run that script using its absolute path from any directory. It builds and tests a container, asks you to select your Homey, and persistently installs the app using the official Homey CLI. It does not use `--clean` or remove existing app data. Your Homey account may need to authorize the CLI. Open the displayed link and, if required, paste its code **into your terminal only**. Credentials are stored in a dedicated Docker volume outside this repository.

For the installation on `iot-mgmt` reached through `foreman`, use this Mac command:

```sh
bash homey-apps/lennox/scripts/install.sh --via-foreman
```

It opens a temporary localhost-only SSH tunnel, verifies that the endpoint belongs to your selected Homey, and uploads over that route. The tunnel closes when installation finishes; the installed app does not depend on it. `HOMEY_SSH_JUMP`, `HOMEY_SSH_TARGET`, and `HOMEY_TUNNEL_PORT` can override the default jump host, destination, and local port. This Mac workflow uses Docker Desktop's `host.docker.internal` address. No SSH or Homey service configuration is changed.

The installer preprocesses production dependencies before packing and checks the installed app reaches `running`. CLI 4.6.1's `--skip-build` archives the source tree, so it is deliberately not used. Its upload error handler can exit zero; this installer calls the same SDK upload endpoint directly and propagates errors instead. A real packaging regression check consumes the upload archive and rejects leaked development tools or an incorrectly sized bundle.

The local Homey web username/password is not the CLI's account authentication. No passwords, tokens, or pairing codes belong in app source or chat.

## Pair your thermostat

The existing Homebridge integration warns that another local client can interfere. Before pairing, pause **only the Lennox child bridge** in Homebridge. Do not stop unrelated plugins or delete Homebridge accessories. That operational choice is yours; this installer does not change Homebridge.

1. In Homey, add a device from **Lennox → iComfort local thermostat**.
2. Enter the thermostat's LAN IP address or hostname, without a URL, port, or path.
3. Select its zones. Each starts in **Read-only mode**.
4. Compare readings and operating state with the thermostat and Lennox app.
5. To test controls, disable Read-only mode in one Homey device's advanced settings, make one small reversible change, confirm it at the thermostat, and restore the original value.

If Homey says **Another pair session is already active**, close the old Lennox pairing dialog and any other tab still running that wizard. If a dialog was abandoned during an update or connection error, wait at least 35 seconds after its last heartbeat, then open one fresh attempt. Homey 13.5.3 expires abandoned sessions per driver; an open wizard keeps its session alive. Cancel using Homey's close button and confirmation modal when leaving a scan. Do not restart unrelated services or remove devices to clear this message.

On Homey 13.5.3, a privately installed app can show a blank brand circle even when its local SVG is present: the web brand picker requests only Athom's public icon CDN and does not use the app's local icon URL. The thermostat tile does use the local fallback. Refreshing may clear a cached request, but cannot put a private icon on that CDN. This is a Homey web interface limitation; changing thermostat settings or reinstalling the app does not address it. An optional, explicitly approved local workaround is documented in [Homey web icons](docs/HOMEY-WEB-ICONS.md). It changes the reviewed Homey web bundle separately from this app and is not applied by the app installer.

A static DHCP lease is recommended. Use Homey's Repair action to update an address; pairing identity is based on the serial number and zone, so an IP change does not create a different thermostat.

## Temperature dials and status indicators

Version 0.1.3 corrected the native thermostat names required by Homey. Version 0.1.4 makes those derived controls follow the selected mode: **Heat** exposes only Heating target, **Cool** only Cooling target, **Automatic** both, and **Off** neither. Changing mode does not erase the thermostat's stored opposite target. Existing custom capability IDs remain for Flow actions and Insights history. Reopen the device control after an app update.

The original drag dial remains. In Advanced Settings, set **Temperature controls** to match the units displayed by Homey: Fahrenheit uses whole-degree steps; Celsius uses half-degree steps. This private release defaults to Fahrenheit for the current installation. The preference controls adjustment steps and confirmation, not Homey's displayed units or the thermostat's unit setting. The deployed Homey 13.5.3 app SDK reports metric units even when its country-based interface displays Fahrenheit, so the app uses this explicit preference.

Open the additional button tab in the device controls for **Heating − / +**, **Cooling − / +**, or the single-target equivalents. Buttons follow the selected mode and calculate each adjustment from a fresh thermostat response inside the shared command queue, so rapid presses do not all reuse one cached value. They use the same read-only, permission, schedule, Away, separation, and confirmation checks as dragging.

The dials use the reported limits and current temperature. Heating colors appear when the enabled heating target is above the measured temperature; cooling colors appear when enabled cooling is below the measured temperature. Both remain neutral within an automatic heat/cool band. The separate **Operating state** reading reports the thermostat's actual activity; Homey computes dial colors from temperature demand.

Homey intentionally disables the **Status Indicator** selector for thermostat-class devices, although its current web interface still renders a blank selector. This is a [documented Homey restriction](https://apps.developer.homey.app/the-basics/devices/capabilities#device-indicators-and-custom-capabilities). The tile uses Homey's automatic thermostat indicator. Homey's default tile cannot fully represent both independent targets in automatic mode; the detailed controls and Operating state reading remain the useful views. This app does not invent one scalar target for an automatic heat/cool band or request broad control of other Homey devices to override that restriction.

Homey lists a current-temperature companion beside each displayed native target on the expanded device tile. These are the same room measurement, not separate heating and cooling sensors. Its native grouping takes precedence over component visibility options, so the app reconciles only the derived native target aliases when the mode changes. Those aliases do not own Insights history or the app's existing Flow actions. The original custom targets, base single target, measurements, settings, and device identity remain. Incomplete mode metadata does not prune controls.

The original Homey 13.5.3 web component can retain a removed dial selection while its controls remain open. Close and reopen the device if that happens. The separately approved [dial-selection workaround](docs/HOMEY-WEB-THERMOSTAT.md) fixes that mounted-view issue without changing the drag control; it is not applied by the app installer.

## Automatic heat/cool gap

In the device's Advanced Settings, **Auto-changeover gap (°F)** reflects the actual reported controller value. Lennox supports **3–9°F in one-degree increments**; any narrower reported range is also respected. This is a controller-wide setting shared by all zones, not an independent preference for each Homey zone.

To change it, first disable Read-only mode and save that change. Then choose the desired gap and save again. The controller must report the parameter as editable. The app refreshes its configuration and active zones, checks that zones already in Automatic would satisfy the new gap, sends only the explicit parameter update, and requires a new report of that parameter before accepting success. It does not move temperature targets. Acknowledgement alone is insufficient.

Installation, polling, reopening settings, and reflecting an externally changed gap do not write the parameter. The settings value is synchronized through Homey's programmatic settings API, which does not call the user-change handler. Changing the address and gap in one save is rejected; perform address repair separately.

## Control behavior and limits

Temperature, mode, and fan commands change only their requested fields and temperature representations. They do not fill missing values with defaults, silently move the opposite target, reboot the controller, or switch a thermostat out of its existing schedule. The advanced gap control is a separate explicit controller-parameter operation.

- **Manual mode is required for controls** when the active schedule is known. Select Manual at the thermostat before using Homey commands. Active schedules produce a clear error instead of a false success. This first release does not implement a schedule-override/resume workflow.
- **Away mode blocks commands**, because its schedule can be shared by zones. Turn Away off at the thermostat first.
- Heat-only and Cool-only adjustments use equipment limits independently of the stored opposite target, matching the user's reported thermostat behavior. Automatic mode additionally enforces the configured heat/cool separation, and switching into Automatic checks the existing pair before sending that mode change. The app preserves the opposite target. Both native Celsius and Fahrenheit wire values are validated. The configured auto-changeover deadband is decoded when reported by the controller; a larger configured gap is not replaced with the upstream client's default.
- Missing setpoint configuration or a reported restriction on local writes prevents changes. A command acknowledgement alone is insufficient; the app waits for the observed value to match.
- Unsupported modes such as emergency heat are not mapped silently to another mode. Check the thermostat if Homey marks it unavailable for an unsupported mode.
- Local HTTPS uses the thermostat's self-signed certificate. The compatibility HTTP parser and certificate handling apply only to that thermostat connection; no global TLS settings are changed. LAN controls should stay on a trusted local network.
- There is no cloud fallback, automatic network scan, controller reset, or external remote-control endpoint.

## Roll back the trial

Disable the Lennox app in Homey to close its connections, then resume the existing Lennox child bridge in Homebridge. Existing Homebridge configuration and cached accessories are not modified by this project. Keeping both clients active is not part of the supported trial.

## Development and verification

All dependency installation and official CLI validation run inside containers. See [VALIDATION.md](VALIDATION.md) for tested paths and boundaries. The installer Dockerfile runs the tests, Homey debug validation, and build before attempting any installation. The root AirGradient package excludes all of `homey-apps/`.

This project uses Luke Alonso's [lennoxapi](https://github.com/lukealonso/lennoxapi) client, declared MIT. See [NOTICE](NOTICE) and [LICENSE](LICENSE). The Homey app and protocol adapter are independent community work.
