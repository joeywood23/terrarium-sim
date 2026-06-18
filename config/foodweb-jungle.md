# Jungle Food Web — design spec

A top-down predator/prey tree for a jungle biome, apex → vegetation. Intended as
the source for generating `config/species/*.json` creatures and `DIETS` rows.

Every creature rides one of the engine's movement archetypes (`aquatic` /
`terrestrial` / `aerial`); producers use the `plant` behavior (`land` | `water`).
Diet edges map directly to the `DIETS` table in `src/main.js`
(`<predator id> → hunts: [<prey ids>]`), with optional `reach(pos)` positional
catchability tests for cross-archetype edges.

Trophic levels, highest first:

- **L4 Apex** — no natural predators
- **L3 Mesopredators** — prey to apex, predators below
- **L2 Insectivores / small carnivores**
- **L1 Herbivores / primary consumers**
- **L0 Producers** — vegetation, the base

---

## The tree

```
L4 APEX
├─ jaguar        [terrestrial]  hunts: capybara, peccary, agouti, monkey, caiman_juv, boa
├─ harpy_eagle   [aerial]       hunts: monkey, sloth, macaw, boa
└─ black_caiman  [aquatic]      hunts: piranha, capybara, tree_frog, macaw(at water)

L3 MESOPREDATORS
├─ boa           [terrestrial]  hunts: agouti, tree_frog, anole, macaw, piranha
├─ ocelot        [terrestrial]  hunts: agouti, anole, tree_frog, macaw, dart_frog
├─ monkey  (omni)[terrestrial]  hunts: beetle, ant   | grazes: fruit, leaves
└─ piranha       [aquatic]      hunts: tetra, insect, carrion

L2 INSECTIVORES / SMALL CARNIVORES
├─ dart_frog     [terrestrial]  hunts: ant, beetle
├─ tree_frog     [terrestrial]  hunts: beetle, butterfly, ant     (== existing "frog")
├─ anole         [terrestrial]  hunts: ant, beetle
├─ insect_bat    [aerial]       hunts: beetle, butterfly
└─ macaw   (omni)[aerial]       grazes: fruit, seeds | hunts: insect

L1 HERBIVORES / PRIMARY CONSUMERS
├─ capybara      [terrestrial]  grazes: riverbank_grass, aquatic_weed
├─ agouti        [terrestrial]  grazes: seeds(fruit_tree), fruit
├─ peccary       [terrestrial]  grazes: roots, fruit, fungi
├─ sloth         [terrestrial]  grazes: canopy_leaves, liana
├─ ant           [aerial/ground]grazes: leaves                    (swarm grazer)
├─ beetle        [aerial]       grazes: leaves, detritus          (== existing "beetle")
├─ butterfly     [aerial]       grazes: nectar
└─ tetra         [aquatic]      grazes: algae, aquatic_weed       (== existing "fish"/"koi")

L0 PRODUCERS (vegetation)
├─ fruit_tree    [plant/land]
├─ understory_fern [plant/land]
├─ bromeliad     [plant/land]
├─ liana         [plant/land]
├─ riverbank_grass [plant/land]
├─ aquatic_weed  [plant/water]   (== existing "seakelp" role)
└─ leaf_litter   [plant/land]    (detritus base)
```

---

## Per-creature generation table

| id | name | archetype | level | hunts | grazes / eats | eaten by | notes |
|---|---|---|---|---|---|---|---|
| jaguar | Jaguar | terrestrial | 4 | capybara, peccary, agouti, monkey, caiman_juv, boa | — | — | land apex |
| harpy_eagle | Harpy Eagle | aerial | 4 | monkey, sloth, macaw, boa | — | — | air apex; strikes terrestrial prey |
| black_caiman | Black Caiman | aquatic | 4 | piranha, capybara, tree_frog, macaw | — | — | water apex; reach = near/over water |
| boa | Boa | terrestrial | 3 | agouti, tree_frog, anole, macaw, piranha | — | jaguar, harpy_eagle | semi-aquatic ok |
| ocelot | Ocelot | terrestrial | 3 | agouti, anole, tree_frog, macaw, dart_frog | — | jaguar | |
| monkey | Monkey | terrestrial | 3 | beetle, ant | fruit, leaves | jaguar, harpy_eagle | omnivore |
| piranha | Piranha | aquatic | 3 | tetra, insect, carrion | — | black_caiman | scavenges corpses |
| dart_frog | Poison Dart Frog | terrestrial | 2 | ant, beetle | — | ocelot | |
| tree_frog | Tree Frog | terrestrial | 2 | beetle, butterfly, ant | — | boa, ocelot, black_caiman | == existing frog |
| anole | Anole Lizard | terrestrial | 2 | ant, beetle | — | boa, ocelot | |
| insect_bat | Insect Bat | aerial | 2 | beetle, butterfly | — | harpy_eagle | |
| macaw | Macaw | aerial | 2 | insect | fruit, seeds | harpy_eagle, boa, ocelot, black_caiman | omnivore |
| capybara | Capybara | terrestrial | 1 | — | riverbank_grass, aquatic_weed | jaguar, black_caiman, boa | semi-aquatic |
| agouti | Agouti | terrestrial | 1 | — | fruit, seeds | jaguar, ocelot, boa | rodent |
| peccary | Peccary | terrestrial | 1 | — | roots, fruit, fungi | jaguar | |
| sloth | Sloth | terrestrial | 1 | — | canopy_leaves, liana | jaguar, harpy_eagle | slow |
| ant | Leaf-cutter Ant | aerial | 1 | — | leaves | dart_frog, tree_frog, anole, monkey | swarm grazer |
| beetle | Beetle | aerial | 1 | — | leaves, detritus | dart_frog, tree_frog, anole, monkey, insect_bat | == existing beetle |
| butterfly | Butterfly | aerial | 1 | — | nectar | tree_frog, insect_bat | |
| tetra | Tetra | aquatic | 1 | — | algae, aquatic_weed | piranha, black_caiman | == existing fish/koi |
| fruit_tree | Canopy Fruit Tree | plant/land | 0 | — | — | agouti, monkey, macaw, peccary | fruit/seeds |
| understory_fern | Understory Fern | plant/land | 0 | — | — | capybara, sloth | |
| bromeliad | Bromeliad | plant/land | 0 | — | — | — | microhabitat |
| liana | Liana / Vine | plant/land | 0 | — | — | sloth, monkey | |
| riverbank_grass | Riverbank Grass | plant/land | 0 | — | — | capybara | |
| aquatic_weed | Aquatic Weed | plant/water | 0 | — | — | tetra, capybara | == existing seakelp |
| leaf_litter | Leaf Litter / Fungi | plant/land | 0 | — | — | peccary, beetle | detritus base |

---

## Mapping to existing species

| existing id | jungle role |
|---|---|
| frog | tree_frog |
| beetle | beetle |
| fish | tetra (herbivorous fish) |
| koi | tetra variant (genetic color) |
| insect | generic flying prey (ant/butterfly base) |
| seakelp | aquatic_weed |
| plant / bluebell / emberleaf | understory producers (fern/bromeliad/etc.) |

## Cross-archetype edges (need `reach(pos)` tests)

These are where the web gets interesting — a predator in one archetype catching
prey in another, gated by position:

- `black_caiman → capybara / macaw / tree_frog`: reach = prey within shallows / at
  waterline (`waterDepthAt(pos) <= someMargin` on the predator side, prey near edge)
- `harpy_eagle → monkey / sloth / boa`: aerial predator striking terrestrial prey
  (reach = prey on land, predator stoops)
- `piranha → insect`: aquatic predator taking fliers that touch the surface
  (reach = prey over deep-enough water, mirrors existing fish grazing on `birds`)

---

## Expansion v2 — +100 animals & +12 producers

The web was scaled up to a deep Amazon ecosystem: **100 new animal species** (each
with a declarative `model.parts` 3D model) plus **12 new producers**. New predators
are wired in the `DIETS` table in `src/main.js`; herbivores/foragers need no row
(terrestrial graze land plants, aquatic graze water plants); fliers without a row
scavenge carrion. `reach` helpers: `onLand`, `inWater`, `shoreOrWater` (waterline
ambush band). Aquatic ambush species set `cfg.ambush` to stalk + lunge at the bank.

- **Producers (12, L0):** kapok_tree, brazil_nut_tree, strangler_fig, cecropia,
  acai_palm, heliconia, passionflower, orchid, bamboo, bracket_fungus,
  water_hyacinth*, giant_water_lily* (* = habitat:water).
- **Aquatic (19):** apex arapaima; predators giant_otter, boto_dolphin, arowana,
  peacock_bass, payara, wolf_fish†, electric_eel, redtail_catfish,
  freshwater_stingray, matamata_turtle†; grazers tambaqui, pacu, plecostomus,
  neon_tetra, discus_fish, silver_hatchetfish, giant_river_turtle, amazon_manatee
  († cfg.ambush).
- **Terrestrial mammals (26):** apex puma; cats jaguarundi, margay, oncilla;
  tayra, bush_dog, crab_eating_fox; anteaters giant_anteater, tamandua,
  giant_armadillo; coati, capuchin, squirrel_monkey, golden_lion_tamarin;
  grazers lowland_tapir, red_brocket_deer, gray_brocket_deer,
  white_lipped_peccary, paca, acouchi, brazilian_porcupine, kinkajou, opossum,
  howler_monkey, spider_monkey, saki_monkey.
- **Reptiles & amphibians (15):** green_anaconda, emerald_tree_boa, rainbow_boa,
  fer_de_lance, bushmaster, coral_snake, vine_snake, tegu, caiman_lizard,
  green_basilisk, horned_frog†, cane_toad, glass_frog; herbivores green_iguana,
  red_footed_tortoise.
- **Birds (26):** raptors ornate_hawk_eagle, great_black_hawk, laughing_falcon,
  crested_owl, spectacled_owl, swallow_tailed_kite; scavengers king_vulture,
  black_vulture, turkey_vulture; waders/fishers great_egret, cocoi_heron,
  jabiru_stork, scarlet_ibis, anhinga, ringed_kingfisher; canopy toco_toucan,
  green_aracari, hummingbird, paradise_tanager, cock_of_the_rock,
  blue_and_gold_macaw, hyacinth_macaw, motmot, woodpecker, hoatzin, fruit_bat.
- **Invertebrates (14):** praying_mantis, dragonfly, tarantula, wandering_spider,
  giant_centipede, scorpion, assassin_bug, army_ant, bullet_ant (predators);
  blue_morpho, owl_butterfly, rhinoceros_beetle, termite, firefly (prey).

Loader note: `loadSpeciesData()` now fetches all manifest files in parallel
(was serial — 130+ species made the cold load multi-second).
