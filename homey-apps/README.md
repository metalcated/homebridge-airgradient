# Homey apps

The Lennox Homey SDK v3 app now lives in its own [metalcated/homey-lennox repository](https://github.com/metalcated/homey-lennox), including its history, tests, documentation, and installation workflow.

The directories below retain planning notes or links to dedicated apps and are excluded from the AirGradient npm package.

| Project | Status |
| --- | --- |
| [Lennox](https://github.com/metalcated/homey-lennox) | Moved to its dedicated repository |
| [rinnai](rinnai/README.md) | Reserved for a future Control-R app |
| [Alarm.com Connect](https://github.com/metalcated/homey-alarmcom) | Dedicated app; isolated validation complete, live acceptance deferred |

Install Lennox from its dedicated checkout with `bash scripts/install.sh`. Do not run Homey commands from the AirGradient repository root. Development dependencies are installed in containers; no local npm installation is required.
