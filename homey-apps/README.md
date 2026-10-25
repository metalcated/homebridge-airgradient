# Homey apps

Independent Homey SDK v3 apps live here. Each app has its own manifest, dependencies, tests, version, and installation workflow. They are excluded from the AirGradient npm package.

| Folder | Status |
| --- | --- |
| [lennox](lennox/README.md) | Local iComfort integration; see validation and installation notes |
| [rinnai](rinnai/README.md) | Reserved for a future Control-R app |
| [alarmcom](alarmcom/README.md) | Reserved for a future Alarm.com app |

Install each app from its own directory. Do not run Homey commands from the AirGradient repository root. Development dependencies are installed in containers; no local npm installation is required.
