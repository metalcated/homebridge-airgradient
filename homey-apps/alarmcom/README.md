# Alarm.com

The native Homey app now lives in its dedicated [metalcated/homey-alarmcom repository](https://github.com/metalcated/homey-alarmcom), with cloud sign-in/MFA, security panel controls, sensors, Flows, tests, and container-based packaging.

Version 0.1.0 has isolated validation and simulated end-to-end coverage. The user deferred installation and all live account/device acceptance until the next testing session. Do not treat a passing build as live acceptance or run Homey commands from the AirGradient repository root.

The inspected Homebridge installation uses `homebridge-node-alarm-dot-com@1.13.1-beta.4` with `node-alarm-dot-com@2.5.0`, both declared MIT. The client is at https://github.com/node-alarm-dot-com/node-alarm-dot-com. Authentication, MFA/session recovery, sensor state, and confirmation of alarm commands must be validated before enabling controls. Existing Homebridge configuration and credentials remain on the server.
