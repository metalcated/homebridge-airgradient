# Small temperature buttons on the native dial

This optional local Homey web patch adds small **−** and **+** controls beneath
the Lennox thermostat dial. The existing dial, drag behavior and heating/cooling
selector remain in the same control tab. It targets the reviewed Homey
Self-Hosted **13.5.3** web asset; it is separate from the Lennox app package.

The latest **immediate preview** presentation moves the dial as each button is
pressed and keeps the queue in the background. It removes the visible
Applying/Queued messages and returns to a compact 48-pixel button row. The
coalescing layer described below remains a separately reproducible input and
rollback point.

## Scope and behavior

The controls appear only for the exact driver
`homey:app:com.metalcated.lennox:thermostat`. The selected native target determines
the pair of existing app capabilities used:

| Selected dial | Allowed main modes | Decrease / increase capability |
| --- | --- | --- |
| `target_temperature.heat` | Heat, Automatic | `heat_decrease` / `heat_increase` |
| `target_temperature.cool` | Cool, Automatic | `cool_decrease` / `cool_increase` |
| `target_temperature` | Heat, Cool, Automatic | `target_decrease` / `target_increase` |

Both relative capabilities must exist. Other thermostat drivers retain their
original control layout. The patch does not alter the vendor's `PSe`
thermostat radial renderer or its drag handler. The native absolute temperature
callback retains its one-second debounce. The previously applied selection fix continues to select a
surviving target when modes change.

The optional coalescing layer collects a burst of presses until there has been
a **600-millisecond pause**. It sends **`true` to the corresponding relative
button capability**, with **`opts.steps`** containing the positive step count.
Opposite presses subtract from the queued count; a net count of zero cancels
the unsent change. One batch contains at most 20 steps. The app then reads the current
thermostat values inside its serialized command path, calculates the adjustment,
validates it and confirms the thermostat's response. The browser does not
calculate a new target from a possibly stale displayed number and does not
optimistically increment the dial in the original coalescing presentation.
The newer preview presentation intentionally previews local intent as described
below. The app's **Temperature controls** setting
determines whether the adjustment is 1°F or 0.5°C; it should match the units
displayed by Homey.

The controls use real HTML buttons with explicit accessible names, native
keyboard activation and focus behavior. Their visible circles are 34 pixels
wide inside 44-pixel click targets. A square layout wrapper keeps the buttons
close to the dial. The coalesced layer reserves a 72-pixel footer for the button
row and an explicit pending-status line.

The buttons remain available while a request is in flight. Additional deliberate
presses form a separate queued batch, which waits for both the pause and the
active request to settle. A failed batch is never automatically retried. Only
new explicitly queued intent may run afterward. **Applying** and **Queued** text
describes this intent without replacing the dial's confirmed temperature.

Both controls disable in read-only mode, while the device is unavailable, for a non-settable target, or without a finite
current target. Each direction also disables when its own capability is not
settable, its queued count reaches 20, or the estimated target reaches the
corresponding bound. The estimate includes pending local intent and is only a
conservative presentation check. Backend validation remains authoritative if the thermostat
changes after the browser last received a reading.

A new drag cancels unsent button intent and supersedes an older unsent drag.
Its absolute writer still waits one second after the last drag event. Button
presses made after that drag wait behind the absolute request, including its
debounce period, so a later absolute write cannot overwrite an earlier relative
adjustment. A target, mode, device, control-unit, availability or read-only
change cancels unsent work. Closing the control view clears its timers. An
already dispatched request is allowed to settle.

Homey's existing capability writer displays a failed-command toast. The new
request handler consumes that same rejected promise and releases the scheduler; it
does not add a duplicate notification or leave an unhandled rejection. A failed
request does not manufacture a new temperature value.

The reviewed web API normally gives a capability request a shorter timeout than
the app's confirmed thermostat command can require. For this driver's native
temperature and relative button writers only, the hook passes an explicit
**45-second request timeout** to the existing device manager operation. It
continues to wait for command completion; it does not acknowledge the command
early. The hook retains its existing native optimistic state, failed-request
rollback and notification behavior. Other drivers, other capabilities and hook
callers without the explicit timeout use the original capability-instance path.
No global Homey timeout or permission is changed.

The six app button capabilities remain the command endpoints. Their separate
button tab can be hidden by app capability options while the native dial uses
these endpoints directly. This patch does not modify devices, Flows, thermostat
settings, authentication or other Homey apps.

The coalesced layer requires the matching Lennox app implementation that accepts
`opts.steps` as a safe integer from 1 to 20, defaults an omitted count to one,
and calculates the combined adjustment after a fresh read. Install and validate
that app build before enabling this layer. An older listener that ignores
`opts.steps` cannot implement a grouped change correctly.

## Immediate dial preview layer

The preview layer uses the existing scheduler's pending absolute value, active
batch and queued step count to move the dial immediately. It bounds the preview
to the capability's limits and does not write that number into Homey's reported
capability store. Actual target events reconcile the preview without counting
the active batch twice. A rejected batch returns to the latest actual target,
including a target that changed before a paired thermostat write failed.

If a successful request resolves just before its actual target event reaches
the browser, a completed preview bridges that delivery gap for at most
**1,500 milliseconds**. A following queued batch can use that preview as its
visual starting point. Any actual target event reconciles it; expiry falls back
to the latest reported value. Context changes and unmount clear its timer.

For the three native Lennox temperature capabilities only, the preview layer
disables the generic hook's separate optimistic assignment and captured-value
rollback. The preview owns the visual intent, and the hook continues to receive
actual events and show errors. This prevents a native-hook error from replacing
a newer actual target with the value captured before the request. Other drivers,
relative capabilities and requests without the scoped 45-second option retain
their existing hook behavior.

There are no visible queue messages. The button group's accessibility busy
state remains available while work is pending. The background pause, ordering,
count limits, failure policy and physical confirmation path are unchanged.

## Reviewed input and generation

The generator is
[`scripts/patch-homey-13.5.3-thermostat-buttons.cjs`](../scripts/patch-homey-13.5.3-thermostat-buttons.cjs).
The original button-layer generator accepts only the exact Homey web bundle with the existing icon fallback and
native thermostat selection fixes already applied:

```text
5fddde7f128abfe1d23dfca4ebae3baa815995959fd14166c988c43684d54215
```

For example, with that reviewed bundle saved outside the repository:

```sh
node scripts/patch-homey-13.5.3-thermostat-buttons.cjs \
  /absolute/path/selection-patched.js \
  /absolute/path/buttons-patched.js
```

The generator refuses an unexpected input hash, missing or duplicate renderer
or capability-writer fragments, repeated application, an existing output path and an output path
equal to the input. It checks the complete generated bundle as JavaScript ESM
before creating the output. Its report includes the input and output SHA-256
checksums. It never installs or replaces the live Homey asset.

`transformSource()` is also exported as a pure fragment transformation for an
explicitly reviewed combined presentation patch. A combined generator must pin
the original whole-bundle checksum, apply each reviewed transformation once,
validate the final ESM and record its own final checksum. The standalone
`patchBundle()` continues to require the exact checksum above.

The separate coalescing layer preserves those original exports and requires the
exact reviewed controls r2 bundle, including the existing status choices and
compact dial layout:

```text
307892c8449d2445968b7b9c3c239b590e023a62a20fded4853c8c8af85ed522
```

```sh
node scripts/patch-homey-13.5.3-thermostat-buttons.cjs --coalesce \
  /absolute/path/controls-r2.js \
  /absolute/path/controls-coalesced.js
```

`patchCoalescedBundle()` pins that whole-bundle hash and syntax-checks the
result. `transformCoalescedSource()` replaces exactly one reviewed r2 renderer
and one reviewed r2 capability hook. It does not reapply the icon, selection or
status transformations. Only the six relative capabilities can forward a
validated `opts.steps` count; arbitrary options and native absolute writers do
not gain this option.

The immediate-preview layer preserves both earlier generators and accepts only
the exact coalesced input:

```text
e1e089da43b87ed1af663ff59f1017aeddd38b70ae30287a33748cb12075a57c
```

```sh
node scripts/patch-homey-13.5.3-thermostat-buttons.cjs --preview \
  /absolute/path/controls-coalesced.js \
  /absolute/path/controls-preview.js
```

`patchPreviewBundle()` pins that input, applies `transformPreviewSource()` to
exactly one reviewed renderer and capability hook, and checks the final ESM.
Rollback restores the exact coalescing layer above.

## Validation and deployment boundary

The isolated renderer tests execute the actual exported patched `VSe` function,
including capability selection, button handlers, pending behavior, disabled
states, rejection recovery, per-request timeout scope and the retained drag
callback. An optional test
against the temporary reviewed vendor bundle verifies the complete generated
JavaScript and that the radial renderer is unchanged. These checks use fixtures;
they do not change a physical thermostat.

Coalescer tests use a controlled clock to exercise bursts, direction reversal,
zero cancellation, count limits, presses during an active request, failed-batch
recovery, unmount and context changes. They also verify drag-before-button
ordering across the one-second absolute debounce and the 600-millisecond button
pause. Actual positioning and device acceptance require separate live checks.

Generating an artifact is separate from live deployment. A deployment should
use the existing guarded local-patch workflow: preserve an exclusive original
backup and metadata, check the currently served asset checksum immediately
before replacement, replace atomically, and verify both the container file and
decoded HTTP response. Rollback for this standalone layer restores the exact
selection-patched input above. Rollback of the coalescing layer restores the
exact controls r2 input. A combined patch needs its own recorded input
and output checksums and matching rollback boundary.

This version-specific browser patch is not a general Homey SDK extension and
does not change the native Homey mobile application's renderer. A Homey update
or any unknown vendor asset must fail the checksum guard and be reviewed again;
the patch must not be automatically rebased onto a different web bundle.
