# Responsive dial controls and native single-mode targets

Version 0.1.7 pairs the native Lennox single-mode behavior with a separate reversible Homey web queue patch. The native draggable dial remains available.

## Native behavior confirmed on the physical thermostat

With Heat selected, the plugin's request for 73°F succeeded while its request for 74°F was acknowledged with HTTP 200/code 1 but repeatedly read back as 73°F. The stored cooling target was 76°F and the reported separation was 3°F. Both Fahrenheit and Celsius values were present and agreed; the single-unit parser issue fixed in 0.1.6 was not the cause of this particular rejection.

The user then set 74°F through the native thermostat/Lennox controls. The existing Homey connection read heating 74°F, cooling 77°F, and mode Heat. After the user raised heat to 75°F and returned it to 72°F, the stored targets read 72°F/78°F, still in Heat. This established the hidden opposite-target movement directly rather than inferring it from the gap setting alone. The agent performed only read-only observations during this comparison.

The [upstream Python client](https://github.com/PeteRager/lennoxs30api/blob/master/lennoxs30api/s30api_async.py) implements the same opposite-target adjustment. The [official S40 setup guide, Table 6](https://www.lennox.com/dA/f346190ece/508222-03a.pdf#page=31) documents the configurable 3–9°F separation; the native comparison above established this thermostat's stored-pair behavior in Heat mode.

The app now allows the active single-mode target to move independently in the visible interface, while shifting the inactive stored target only when needed. It preserves that inactive target when the existing pair already meets the reported separation. It does not move it back when the active target is subsequently lowered or raised away from the constraint. Both changed targets are published together as a partial temperature-only update and both must confirm. No mode, fan, humidity, schedule, or unrelated zone value is included to make the request succeed.

Automatic mode retains two independent active targets and the reported gap between them. An inactive legacy Flow target cannot silently shift the active single-mode target. Unknown separation or an impossible hardware-bound combination blocks a write rather than assuming a default or clamping the requested active temperature.

## Button and drag queue

The scoped web patch keeps the small − / + controls on the dial tab. They remain responsive while a request is pending, subject to read-only, availability, direction, and limit guards. A short burst is combined into a signed adjustment after 600ms without another click. A net-zero burst is cancelled. A burst is limited to 20 steps; the app independently validates the count and calculates it from a fresh thermostat reading inside the shared queue.

There is only one active request from this control at a time. Further clicks accumulate as a new batch and wait for both the pause and the active request to settle. A failed batch is not automatically retried. The original batching layer displays a small status line; the subsequent dial-preview layer replaces that presentation as described below.

Dragging retains a one-second pause before submission. A drag cancels unsent button intent, and button clicks after a drag wait for that absolute request instead of overtaking it. Target, mode, unit, read-only, availability, or device changes cancel unsent work. Closing the control cancels local timers and unsent batches; an already transmitted request cannot be withdrawn.

The six existing boolean command capabilities remain, using the verified optional request `opts.steps`. Ordinary one-step calls and older web controls remain compatible. Other drivers retain their original UI behavior.

## Deployment compatibility

Install app 0.1.7 before applying the batching web layer. Older apps ignore the optional step count and would apply only one degree from a batched request. If rolling the app back below 0.1.7, first roll back the batching layer. Its immediate predecessor is the reviewed icon/selection/status/on-dial-controls bundle with SHA-256 `307892c8449d2445968b7b9c3c239b590e023a62a20fded4853c8c8af85ed522`.

The earlier interface layers remain separately backed up. A Homey update or container recreation can replace these optional version-specific web changes; re-review the new vendor asset before applying a patch again.

The batching layer's SHA-256 is `e1e089da43b87ed1af663ff59f1017aeddd38b70ae30287a33748cb12075a57c`. Root-owned backups and deployment metadata are in `/opt/docker/homey/local-patches/thermostat-batching-13.5.3`. The exact vendor image, web version, container identity, prior file checksum, and served HTTP checksum are guarded by the unchanged deployment helper. If the preview layer is active, roll it back first before using the batching-layer commands below.

Roll back only this layer while retaining the previous on-dial controls, status, icon and selection fixes:

```sh
ssh -T foreman.gnet.com 'sudo -n ssh -T iot-mgmt python3 /opt/docker/homey/local-patches/thermostat-batching-13.5.3/manage-homey-web-batching.py rollback'
```

Reapply:

```sh
ssh -T foreman.gnet.com 'sudo -n ssh -T iot-mgmt python3 /opt/docker/homey/local-patches/thermostat-batching-13.5.3/manage-homey-web-batching.py apply --patched-file /opt/docker/homey/local-patches/thermostat-batching-13.5.3/index-LWSkNFnB.js.patched --patched-sha256 e1e089da43b87ed1af663ff59f1017aeddd38b70ae30287a33748cb12075a57c'
```

## Verification

All 213 tests pass under Node 22 and Node 24, with the reviewed vendor bundle supplied. The real Homey validation, build, and install-archive checks pass. Tests cover both targets confirming, partial application failing, gaps 3–9°F and both unit grids, hardware bounds, unknown metadata, inactive legacy controls, unchanged Automatic behavior, multi-step option validation, responsive in-flight button queues, reversal, drag ordering, cancellation, failure recovery, and exact patch reversal.

The existing Homey independently reported app 0.1.7 running, enabled and not crashed, with the paired device available. Installation preserved the latest user-selected 72°F/78°F targets, Heat mode, Circulate fan setting, device identity/settings and Flow definitions. The web layer was applied, rolled back byte-for-byte to its predecessor, and reapplied; file and HTTP checksums matched without a Homey container restart. Physical commands remain user-operated; emulator and interface checks do not substitute for observing the next real adjustment.

## Immediate dial preview

The separately reversible preview layer keeps the same queue and command endpoints. Each button press moves the native dial to the requested temperature immediately. The queue runs in the background without visible Applying or Queued messages, and the controls remain usable during a pending request. The smaller 48-pixel footer retains the buttons on the dial tab and preserves dragging.

The requested dial preview is separate from the reported capability value and measured room temperature. A confirmed capability event reconciles it; if the command promise settles first, a bounded 1.5-second bridge avoids a brief return to the preceding value while the event arrives. Without that event the bridge expires to the reported reading. A rejected command clears its preview, restores the latest actual reading, and uses Homey's existing error notification. The exact Lennox native temperature hook delegates its optimistic display to this renderer so its old captured-value rollback cannot overwrite a newer thermostat reading.

Changing target, mode, units, availability, or read-only state cancels unsent previews and timers. Closing the view also cancels unsent work. The layer changes browser presentation only; app 0.1.7 and its physical-device confirmation policy remain in place. See [the preview generator and rollback details](HOMEY-WEB-THERMOSTAT-BUTTONS.md#immediate-dial-preview-layer).

The preview bundle's SHA-256 is `2ae2e73045b156d4df8d7f19283abaf96339127029251b6f1b162236b2963ed1`. Its root-owned backup and metadata are in `/opt/docker/homey/local-patches/thermostat-preview-13.5.3`. The [preview deployment helper](../scripts/manage-homey-web-preview.py) reuses the unchanged, checksum-pinned vendor and deployment guards. Rollback restores the exact batching layer, retaining all earlier icon, selection, status and dial-button patches:

```sh
ssh -T foreman.gnet.com 'sudo -n ssh -T iot-mgmt python3 /opt/docker/homey/local-patches/thermostat-preview-13.5.3/manage-homey-web-preview.py rollback'
```

Reapply the already staged, reviewed preview bundle:

```sh
ssh -T foreman.gnet.com 'sudo -n ssh -T iot-mgmt python3 /opt/docker/homey/local-patches/thermostat-preview-13.5.3/manage-homey-web-preview.py apply --patched-file /opt/docker/homey/local-patches/thermostat-preview-13.5.3/index-LWSkNFnB.js.patched --patched-sha256 2ae2e73045b156d4df8d7f19283abaf96339127029251b6f1b162236b2963ed1'
```

With this layer, all 224 tests pass under both Node 22 and Node 24 with the actual reviewed vendor bundle supplied and no skipped tests. The new renderer tests cover immediate movement, promise/event ordering, queued handoff, stale metadata with fresh socket events, partial failure rollback, cancellation, dragging, and exact artifact/rollback guard consistency. The preview was applied, rolled back to the exact batching hash and reapplied; file and HTTP checksums matched, and the running container identity, start time and restart count remained unchanged. The actual Homey page was hard-refreshed and inspected in dark mode: the dial and small buttons remained on the same tab, with no visible queue messages. No thermostat command was issued during this presentation change; physical preview acceptance remains a user-operated check.
