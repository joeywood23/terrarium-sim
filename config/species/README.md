# Species definitions

Each `*.json` file here defines one species; `manifest.json` lists which to load.
To add one: create a file and add its name to `manifest.json` → `files`.

## Common fields
- `id` — unique key (required)
- `name` — label in the Place dropdown and population chart
- `behavior` — `aquatic` | `terrestrial` | `aerial` (creatures) or `plant` (flora)
- `chartColor` — population-line color

## Creatures (aquatic / terrestrial / aerial)
- `color` — base body color (hex)
- `geneticColor` — `true` for fish-style heritable color
- `cfg` — (aerial only) flight/size overrides, e.g. `{ "length": 1.3, "altMin": 2 }`
- `model` — `{ "builtin": "fish" }` to reuse a built-in model, or
  `{ "parts": [ ... ] }` declarative primitives. A part is
  `{ shape: "box|sphere|cone|cylinder|eyes", pos:[x,y,z], rot:[x,y,z],
     scale:[x,y,z] | n, color: "body"|"bodyDark"|"accent"|"#hex", glow: true }`

Aquatic/terrestrial species share their archetype's body size and breeding;
aerial species can resize/retune via `cfg`.

## Plants (behavior: "plant")
- `habitat` — `land` (default) or `water` (germinates/grows only submerged)
- `colorYoung` / `colorOld` — stripped→lush gradient (or a single `color` to derive one)
- `maxRadius` — full size of a lush plant (default ~1.8)
- `minDepth` — (water only) how submerged a spot must be to count (default 0.5)
- `seedShare` — relative seeding effort at world generation (default 0.6)
