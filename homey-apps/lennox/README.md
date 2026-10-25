# Lennox for Homey

A native Homey SDK v3 app for Lennox iComfort thermostats with the compatible local LAN API. Targets Homey Pro and Homey Self-Hosted Server **12.9.0 or newer**. Version **0.1.0** is a private test release, not an App Store publication or a claim of Lennox certification.

## What it provides

- Manual IP/hostname pairing with zone selection and stable serial/zone identities.
- Temperature, humidity when reported, operating state, supported HVAC modes, and fan modes.
- Separate heating and cooling targets for dual-setpoint systems; one target for single-setpoint systems. Celsius is used internally; Homey presents supported thermostat values using its configured units. Custom Flow temperature arguments are explicitly Celsius.
- Heating, cooling, fan actions and operating-state conditions in Flow. Native capabilities also provide Homey's normal cards and Insights where supported.
- Read-only mode enabled for each new device. Disable it in that device's advanced settings to permit commands.
- A shared connection for all zones on the same address, bounded requests, reconnect attempts, stale-zone detection, and confirmation of writes through fresh reported state.
- Repair for an address change, verifying the thermostat serial and zone before replacing the connection.

The underlying `lennoxapi@0.1.2` advertises S30/S40/E30/M30 LAN support. Our local tests use emulated S30/S40/M30-shaped messages; physical compatibility remains to be verified. No vendor cloud account or password is used.

## Install without local npm dependencies

From the repository checkout, run:

```sh
bash homey-apps/lennox/scripts/install.sh
```

Or run that script using its absolute path from any directory. It builds and tests a container, asks you to select your Homey, and persistently installs the app using the official Homey CLI. It does not use `--clean` or remove existing app data. Your Homey account may need to authorize the CLI. Open the displayed link and, if required, paste its code **into your terminal only**. Credentials are stored in a dedicated Docker volume outside this repository.

The local Homey web username/password is not the CLI's account authentication. No passwords, tokens, or pairing codes belong in app source or chat.

## Pair your thermostat

The existing Homebridge integration warns that another local client can interfere. Before pairing, pause **only the Lennox child bridge** in Homebridge. Do not stop unrelated plugins or delete Homebridge accessories. That operational choice is yours; this installer does not change Homebridge.

1. In Homey, add a device from **Lennox → iComfort local thermostat**.
2. Enter the thermostat's LAN IP address or hostname, without a URL, port, or path.
3. Select its zones. Each starts in **Read-only mode**.
4. Compare readings and operating state with the thermostat and Lennox app.
5. To test controls, disable Read-only mode in one Homey device's advanced settings, make one small reversible change, confirm it at the thermostat, and restore the original value.

A static DHCP lease is recommended. Use Homey's Repair action to update an address; pairing identity is based on the serial number and zone, so an IP change does not create a different thermostat.

## Control behavior and limits

Commands change only the requested field and its Fahrenheit/Celsius representation. They do not fill missing values with defaults, silently move the opposite target, reboot the controller, alter installer configuration, or switch a thermostat out of its existing schedule.

- **Manual mode is required for controls** when the active schedule is known. Select Manual at the thermostat before using Homey commands. Active schedules produce a clear error instead of a false success. This first release does not implement a schedule-override/resume workflow.
- **Away mode blocks commands**, because its schedule can be shared by zones. Turn Away off at the thermostat first.
- The reported temperature limits and heat/cool separation are enforced. A value that would require changing the opposite target is rejected.
- Missing setpoint configuration or a reported restriction on local writes prevents changes. A command acknowledgement alone is insufficient; the app waits for the observed value to match.
- Unsupported modes such as emergency heat are not mapped silently to another mode. Check the thermostat if Homey marks it unavailable for an unsupported mode.
- Local HTTPS uses the thermostat's self-signed certificate. The compatibility HTTP parser and certificate handling apply only to that thermostat connection; no global TLS settings are changed. LAN controls should stay on a trusted local network.
- There is no cloud fallback, automatic network scan, controller reset, or external remote-control endpoint.

## Roll back the trial

Disable the Lennox app in Homey to close its connections, then resume the existing Lennox child bridge in Homebridge. Existing Homebridge configuration and cached accessories are not modified by this project. Keeping both clients active is not part of the supported trial.

## Development and verification

All dependency installation and official CLI validation run inside containers. See [VALIDATION.md](VALIDATION.md) for tested paths and boundaries. The installer Dockerfile runs the tests, Homey debug validation, and build before attempting any installation. The root AirGradient package excludes all of `homey-apps/`.

This project uses Luke Alonso's [lennoxapi](https://github.com/lukealonso/lennoxapi) client, declared MIT. See [NOTICE](NOTICE) and [LICENSE](LICENSE). The Homey app and protocol adapter are independent community work.
