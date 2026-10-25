# Single-unit temperature readback

Version 0.1.6 fixes a reproduced false failure when a protocol response omits one representation of a target. The pinned parser updates Fahrenheit and Celsius fields independently and retains missing fields. After a complete pair has been cached, a later Fahrenheit-only target update could leave the old Celsius value in place. The command confirmation then compared values from different reports and rejected an applied change. Celsius-only updates had the reverse problem.

The transport now invalidates the omitted counterpart when an incoming period explicitly supplies only one field for the heating, cooling, or single target. It does not invent a converted raw field. Existing model conversion displays the reported value, and confirmation validates that value. If the reported field is invalid or unavailable, its omitted cached counterpart cannot stand in as a fresh reading. Reports supplying both fields retain both, and contradictory pairs still fail confirmation. Reports changing only fan or mode retain the last target report.

The change preserves partial command payloads, read-only enforcement, shared connection serialization, queue deadlines, mode-specific controls, the automatic gap policy, and exactly one publication per command. No thermostat schedule, opposite target, or gap is adjusted to make a command succeed.

A new local `Lennox temperature readback` log records only the fixed target name, units, expected and parsed numeric temperatures, the last target report's presence flags and revision, outcome, and bounded publication status/code metadata. It excludes addresses, serial numbers, zone names, and raw request/response bodies. This makes a repeated failure distinguishable from a stale paired-field comparison. The acknowledgement metadata does not replace confirmed readback as the success condition.

## Evidence and limits

The user's 0.1.5 app logs showed a confirmed adjustment in 2.476 seconds, an unconfirmed adjustment in 10.590 seconds, then another confirmed adjustment in 1.209 seconds. The failed publication was acknowledged in 52ms; subsequent complete operating periods did not match the expected target. The previous diagnostic did not record the actual wire fields, so it cannot establish that omission caused that particular physical failure.

The HTTP emulator reproduced the false failure for Fahrenheit-only and Celsius-only updates across heating, cooling, and single targets. Assertions verified that the emulator applied the request and omitted the counterpart on the wire before the old confirmation failed. With the correction, those six cases confirm successfully and expose the correct observed target. Six contradictory dual-field cases continue to reject. Additional tests cover target provenance through fan-only updates, queued one-degree Fahrenheit adjustments, invalid/unavailable reports, and bounded diagnostic content.

Physical acceptance remains separate from emulator results. The deployed readback diagnostic can show the next real attempt's requested, reported, and parsed values without adding a competing thermostat client.

The full suite passes 192/192 on Node 22 and Node 24, including the reviewed Homey web bundle checks. Homey validation, build, and real archive checks pass. Version 0.1.6 was installed on the existing Homey and independently reported running, enabled, not crashed, with the paired device available. Device identity, controls/settings, native UI components, 72°F/76°F stored targets, Heat mode, Circulate fan setting, and Flow definitions were unchanged. No physical command was sent during this update verification.
