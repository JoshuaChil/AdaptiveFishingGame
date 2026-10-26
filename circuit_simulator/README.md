# ProtoPlanner

A browser-based layout planner and logic-level circuit simulator for the
**ElectroCookie solderable protoboard**, built to plan the wiring of the
fishing-game receiver (XIAO ESP32C3 + MOSFET-driven electromagnet + 28BYJ-48
stepper on a ULN2003 module + pivot servo) before soldering.

Think of it as a small, hardware-specific TinkerCAD: parts have the real pin
counts and spacings, holes connect the way the board's copper strips do, and a
design-rule checker plus a run mode let you confirm the circuit *before* you
heat the iron.

No build step, no dependencies: vanilla ES modules + SVG.

## Running

```sh
cd circuit_simulator
npm run serve        # python3 -m http.server 8080
# or: npx serve .
```

Then open <http://localhost:8080>. (ES modules must be served over HTTP; a
`file://` URL will not load.)

```sh
npm test             # node --test tests/   (engine, DRC, sim, preset checks)
```

Modern Chrome or Safari is required (`structuredClone`, `<dialog>`, pointer
events). Your project autosaves to `localStorage`, so a reload keeps your work.

## Feature tour

| Feature | How |
|---|---|
| **Place parts** | Click a card in the left palette, then click the board; or drag the card onto the canvas. The ghost is green when the placement is valid and red when it is off-board, in the channel, or on an occupied hole. |
| **Move / rotate** | Drag a part with the Select tool (`V`). `R` rotates the selected part 90° in place (about its pin centroid) and re-snaps it to the nearest valid holes; if no valid spot exists the rotation is still applied and the Checks tab flags it. |
| **Wires** | `W`, click the first hole / pin / terminal, click the second. `Esc` cancels. Pick the color in the toolbar. Drag a wire's middle handle to bend it around other wires. |
| **Solder bridges** | `B`, then click two *adjacent* holes to join them with a solder bridge. |
| **Hover nets** | Hover any hole, pin, module terminal or wire and every node on the same net lights up; the status bar reads e.g. `c5 · net GND`. Holes that already have a wire end on them (or a wire passing over them) stay clickable for new wires. |
| **Checks** | The Checks tab lists design-rule issues grouped by severity (errors / warnings / infos). Clicking an issue selects and highlights the offending part or net. |
| **Run mode** | Press **Run**. In the Run tab, toggle `D0`–`D10` on the XIAO, drag the servo slider, or start a script (stepper CW/CCW, magnet pulse, servo sweep). Nets are coloured by level (GND blue, VCC red, HIGH orange); the MOSFET lights when conducting, the magnet glows when energised, the ULN2003 LEDs follow its outputs and the stepper rotor turns. |
| **Export** | JSON (re-importable project), SVG and PNG (the drawing with its styles), Markdown (board, BOM, numbered wiring list, bridges, nets, DRC summary — handy to print and tick off while soldering). |
| **Import** | Toolbar **Import…** → pick a ProtoPlanner JSON file. It is validated before replacing the current project. |
| **Presets** | The Preset dropdown loads a blank board or the **Fishing game receiver** layout (which is also loaded on first run). |
| **Board kinds** | Mini (17 columns, no rails), Half (30 + 4 rails, default), Dual half, Full (63 columns). Switching boards keeps parts and flags those that no longer fit. |
| **Undo / redo** | Up to 100 steps. Drags commit on release. |

### Keyboard shortcuts

| Key | Action |
|---|---|
| `V` | Select tool |
| `W` | Wire tool |
| `B` | Bridge tool |
| `Space` (hold) + drag | Pan |
| mouse wheel / trackpad | Zoom around the cursor |
| `R` | Rotate selected part |
| `Delete` / `Backspace` | Delete selection (a part's wires go with it) |
| `Esc` | Cancel placement / wiring, back to Select |
| `Cmd/Ctrl+Z` | Undo |
| `Shift+Cmd/Ctrl+Z` | Redo |
| `?` | Controls help |

## The physical model

### Board

ElectroCookie boards use a 0.1" (2.54 mm) grid. The **half-size** board is
30 columns wide with two blocks of 5-hole copper strips:

```
rails  tp (+)  ·  ·  ·  ·  ·     y = -3   (25 holes, columns 3–27)
       tm (−)  ·  ·  ·  ·  ·     y = -2
rows   a b c d e                 y = 0..4   one strip per column
       ---- channel 0.3" ----    y = 5, 6   (no holes)
       f g h i j                 y = 7..11  second strip per column
rails  bm (−)                    y = 14
       bp (+)                    y = 15
```

* Each column's `a–e` holes are one strip; `f–j` another. The channel between
  `e` and `f` is **0.3"** (two missing rows), which is what lets a DIP/XIAO
  straddle it.
* The four power rails run the full length (continuous) by default. The
  `railSplit` board option cuts each rail at its middle column for boards that
  ship split.
* Top rails and bottom rails are **not** connected to each other; the preset
  bridges them with two short jumpers (W3/W4).
* Mini = 17 columns, no rails. Full = 63 columns. Dual = a second `k–t` block
  below the first.

### Parts (pin counts and spacing match the real hardware)

| Part | Mount | Pins / terminals |
|---|---|---|
| **XIAO ESP32C3** | through-hole, straddles the channel | 14 pins, 2 rows × 7 at 2.54 mm, rows 0.6" (6 holes) apart. Rotation 0 = **USB pointing left**, anchor = the `5V` pin. Top row (left→right) `5V GND 3V3 D10 D9 D8 D7`; bottom row `D0 D1 D2 D3 D4 D5 D6`. `D0`, `D8`, `D9` are strapping pins (flagged as info when loaded). `BAT+`/`BAT−` underside pads are modelled as off-grid terminals; `BAT−` is internally tied to `GND`. The anchor must sit in row `b`, `c`, `d` or `e` so the other row lands in `f`–`i`. |
| **ULN2003 stepper module** | bench (off-board) | `IN1–IN4` header, `−` / `+` power header (5–12 V), the `+`→`COM` jumper (default closed), a 5-pin keyed `SOCKET`, LEDs A–D. `INx` HIGH ⇒ `OUTx` sinks to GND. |
| **28BYJ-48 stepper** | bench | one 5-wire keyed `PLUG`: red = COM, blue/pink/yellow/orange = OUT1..OUT4. Connect it with a single *plug* wire to the ULN2003 socket. Rotor steps 11.25° per half-step frame. |
| **Servo** | bench | `SIG`, `VCC`, `GND`. |
| **Electromagnet** | bench | two polarity-agnostic leads. |
| **Power supply** | bench | `V+`, `GND`; `voltage` prop (default 5 V). |
| **N-MOSFET** | through-hole | `TO-220` = `[G, D, S]` (IRLZ44N, default) or `TO-92` = `[S, G, D]` (2N7000), three adjacent columns. |
| **Resistor / diode / capacitor** | through-hole | two pins, `span` prop (default 4 holes). Diode has polarity (`A`/`K`, band at K); capacitor may be `polarized`. `rot 90` + span 3 or 7 straddles the channel vertically. |

Jumper wires are plain wires between any two nodes (holes, rail holes, part
pins or module terminals), in one of ten colours.

### Assumptions (read before trusting a layout)

1. **XIAO row spacing of 0.6"** (15.24 mm) is *inferred* from the 17.8 mm
   board width and edge-castellated pads; it is not taken from a drawing.
   Test-fit the module on the board before soldering anything else.
2. **Rails are continuous** by default. If your board's rails are split in
   the middle, turn on `railSplit` in the board properties.
3. **Rail polarity labels are cosmetic.** The `+` / `−` stripes only help
   you keep things straight; the checker derives net names from what is
   actually wired to them.
4. **The dual board is an approximation**: it is modelled as a second
   `a–j` block (rows `k–t`) directly below the first with its own channel; the
   real gap and mounting holes are not reproduced.
5. **The simulation is logic-level, not SPICE.** Nets are `GND`, `VCC`,
   `HIGH`, `LOW`, `FLOAT` or `CONFLICT`; there are no currents, voltages drops
   or timing. A MOSFET conducts when its gate is HIGH/VCC and its source is
   GND; a ULN2003 output sinks when the module is powered and `INx` is HIGH.
   It catches wiring mistakes, not component-value mistakes.
6. **The 5 V external supply is the default power source.** The XIAO's own
   `5V` pin is modelled as a power output (USB VBUS); tying it to the supply
   is reported as an *info* (`VBUS_TIED_TO_SUPPLY`) so you remember to not
   plug in USB and the bench supply at the same time without a diode.
7. Occupancy is tracked per **pin**, not per body outline; bodies are drawn
   for orientation only.

### Preset: fishing game receiver

The preset encodes the firmware pin map from
`programming/receiver_controller/receiver_controller.ino`:

| XIAO pin | Function | Circuit |
|---|---|---|
| `D0` | Electromagnet | → 220 Ω (`R1`) → `Q1` gate; 10 kΩ pulldown (`R2`) gate→GND; `Q1` drain → magnet → 5 V; flyback diode `D1` (1N4007) across the magnet, cathode to 5 V |
| `D1` | Servo signal | → `SV1` SIG; servo powered from the 5 V rails |
| `D10` `D9` `D8` `D7` | Stepper | → ULN2003 `IN1` `IN2` `IN3` `IN4`; module `+`/`−` on the 5 V rails; 28BYJ-48 on the socket |

Both the XIAO `5V` pin and the bench supply feed the `+` rails. Expected
check result on the preset: **0 errors, 0 warnings**, 4 infos (one
`VBUS_TIED_TO_SUPPLY`, three `STRAPPING_PIN_LOAD` for `D0`, `D8`, `D9`).

## Project JSON (version 1)

```jsonc
{
  "version": 1,
  "meta": { "name": "Fishing game receiver", "modified": 1730000000000 },
  "board": { "kind": "half", "railSplit": false },          // half | mini | dual | full
  "parts": [
    { "id": "U1", "type": "xiao_esp32c3", "at": { "x": 1, "y": 2 }, "rot": 0,
      "props": { "label": "XIAO ESP32C3" } },                 // through-hole: at = anchor pin (ints)
    { "id": "DRV1", "type": "uln2003", "at": { "x": 3, "y": -12 }, "rot": 0,
      "props": { "jumper": true } }                           // bench: at = body top-left
  ],
  "wires": [
    { "id": "W1",  "kind": "wire", "a": "h:a1",      "b": "r:tp:3",        "color": "red",  "mid": null },
    { "id": "W22", "kind": "plug", "a": "p:M1:PLUG", "b": "p:DRV1:SOCKET", "color": "grey", "mid": null }
  ],
  "bridges": [ { "id": "B1", "a": "h:c5", "b": "h:c6" } ]      // adjacent holes only
}
```

* Coordinates are in grid units (1 = one hole pitch). `x` is the 1-based
  column; `y` is the row position (`a..e` = 0..4, channel = 5,6, `f..j` =
  7..11, rails at −3/−2 and 14/15 on the half board).
* Node ids: strip hole `h:c5`, rail hole `r:tp:3`, part pin or module terminal
  `p:{partId}:{pin}` (`p:U1:D0`, `p:Q1:G`, `p:DRV1:IN1`, `p:PS1:V+`).
* Part ids are `{prefix}{n}`: `U` XIAO, `DRV` driver, `M` motor, `SV` servo,
  `L` magnet, `PS` supply, `Q` MOSFET, `R`, `D`, `C`. Wires `W{n}`, bridges `B{n}`.
* `mid` is an optional `{x,y}` control point for bending a wire.
* `rot` ∈ {0, 90, 180, 270}, about the anchor pin (through-hole) or body
  top-left (bench).

The autosaved copy lives in `localStorage['protoplanner.project']`; UI state
(tool, wire colour, view transform) in `localStorage['protoplanner.ui']`.

## Code layout

```
index.html / styles.css   page shell (SVG styles live in render.js so exports carry them)
src/board.js              board geometry: holes, strips, rails
src/parts.js              part library, pin resolution, placement validation
src/netlist.js            union-find connectivity + net naming
src/drc.js                design-rule checks
src/sim.js                logic-level evaluation, stepper sequence, scripts
src/presets.js            blank boards + fishing receiver preset
src/store.js              project state, undo/redo, autosave, derived model, UI state
src/render.js             SVG renderer, net highlight, sim visuals, SVG export
src/interact.js           pointer/keyboard state machine
src/panels.js             palette, properties, checks, run panel, toolbar
src/io.js                 JSON / SVG / PNG / Markdown export, JSON import
src/app.js                bootstrap
tests/                    node --test suites for the pure engine
```
