# Small temperature buttons on the native dial

This optional local Homey web patch adds small **−** and **+** controls beneath
the Lennox thermostat dial. The existing dial, drag behavior and heating/cooling
selector remain in the same control tab. It targets the reviewed Homey
Self-Hosted **13.5.3** web asset; it is separate from the Lennox app package.

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
callback retains its existing debounce. The previously applied selection fix continues to select a
surviving target when modes change.

Each press sends **`true` to the corresponding relative button capability**
through Homey's existing `pR` capability writer. The app then reads the current
thermostat values inside its serialized command path, calculates the adjustment,
validates it and confirms the thermostat's response. The browser does not
calculate a new target from a possibly stale displayed number and does not
optimistically increment the dial. The app's **Temperature controls** setting
determines whether the adjustment is 1°F or 0.5°C; it should match the units
displayed by Homey.

The controls use real HTML buttons with explicit accessible names, native
keyboard activation and focus behavior. Their visible circles are 34 pixels
wide inside 44-pixel click targets. A scoped layout wrapper reserves a 48-pixel
footer so the dial cannot push the buttons outside the control pane.

Both controls disable while an adjustment is pending, in read-only mode, while
the device is unavailable, for a non-settable target, or without a finite
current target. Each direction also disables when its own capability is not
settable or the displayed target is already at the corresponding bound. A
synchronous reference lock rejects a second click even before React renders the
pending state. Backend validation remains authoritative if the thermostat
changes after the browser last received a reading.

Homey's existing capability writer displays a failed-command toast. The new
click handler consumes that same rejected promise and unlocks the controls; it
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

## Reviewed input and generation

The generator is
[`scripts/patch-homey-13.5.3-thermostat-buttons.cjs`](../scripts/patch-homey-13.5.3-thermostat-buttons.cjs).
It accepts only the exact Homey web bundle with the existing icon fallback and
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

## Validation and deployment boundary

The isolated renderer tests execute the actual exported patched `VSe` function,
including capability selection, button handlers, pending behavior, disabled
states, rejection recovery, per-request timeout scope and the retained drag
callback. An optional test
against the temporary reviewed vendor bundle verifies the complete generated
JavaScript and that the radial renderer is unchanged. These checks use fixtures;
they do not change a physical thermostat.

Generating an artifact is separate from live deployment. A deployment should
use the existing guarded local-patch workflow: preserve an exclusive original
backup and metadata, check the currently served asset checksum immediately
before replacement, replace atomically, and verify both the container file and
decoded HTTP response. Rollback for this standalone layer restores the exact
selection-patched input above. A combined patch needs its own recorded input
and output checksums and matching rollback boundary.

This version-specific browser patch is not a general Homey SDK extension and
does not change the native Homey mobile application's renderer. A Homey update
or any unknown vendor asset must fail the checksum guard and be reviewed again;
the patch must not be automatically rebased onto a different web bundle.
