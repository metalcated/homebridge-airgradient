# Homey apps

The Lennox Homey SDK v3 app now lives in its own [metalcated/homey-lennox repository](https://github.com/metalcated/homey-lennox), including its history, tests, documentation, and installation workflow.

The remaining directories are placeholders for future apps and are excluded from the AirGradient npm package.

| Project | Status |
| --- | --- |
| [Lennox](https://github.com/metalcated/homey-lennox) | Moved to its dedicated repository |
| [rinnai](rinnai/README.md) | Reserved for a future Control-R app |
| [alarmcom](alarmcom/README.md) | Reserved for a future Alarm.com app |

Install Lennox from its dedicated checkout with `bash scripts/install.sh`. Do not run Homey commands from the AirGradient repository root. Development dependencies are installed in containers; no local npm installation is required.
