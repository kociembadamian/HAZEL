# HAZEL — Hazardous Atmosphere Zoning for European Locations

**Free, auditable, open-source modelling of hazardous chemical releases.**

HAZEL estimates how far the danger reaches after an uncontrolled release of a
dangerous substance: toxic gas clouds, flammable clouds, fires and vapour cloud
explosions. It runs entirely in a web browser, works offline once loaded, and
needs no server, account or installation.

<img width="1404" height="656" alt="Screenshot 2026-10-05 at 15 29 21" src="https://github.com/user-attachments/assets/0ad2c66f-7ef8-41df-8624-17d0c07f8d2e" />


- Application: <https://lab.hazel-project.eu/>
- Project site (overview, accuracy, sources): <https://hazel-project.eu/>
- Contact: Damian Kociemba, <damian@kocie.mba>

> **Status: beta (version 1.0.0).** HAZEL is a training and planning aid. It is
> not a certified or validated hazard assessment and must not be the only basis
> for an operational decision. See [Disclaimer](#disclaimer).

---

## What HAZEL does

HAZEL covers the chain from "something is leaking" to "where does the danger
reach":

1. **Release rate** — a known rate, an evaporating puddle, or a damaged tank
   (horizontal or vertical cylinder, sphere) holding a liquid, a gas liquefied
   under pressure, or a compressed gas.
2. **Dispersion** — Gaussian plume for passive clouds and a DEGADIS-style
   heavy-gas model for clouds denser than air, chosen automatically from the
   Richardson number. Stability classes A–F, inversions, elevated sources,
   open-country and urban terrain.
3. **Fire and explosion** — flammable area (60 % and 10 % of LEL), vapour cloud
   explosion (Baker-Strehlow-Tang), BLEVE fireball, pool fire and jet fire.
4. **Indoor concentration** — how much of an outdoor cloud infiltrates a nearby
   building, to compare sheltering with evacuating.
5. **Map and report** — zones are drawn on an OpenStreetMap base, saved locally
   as scenarios, and exported as a PDF report with every input and the
   limitations that apply.

The chemical library holds **3,148 substances** with Protective Action Criteria
(PAC-1/2/3) from the US Department of Energy dataset. You can add your own
substances or fill gaps in existing records; these stay in your browser.

## How accurate is it?

HAZEL has been checked against about 100 side-by-side runs of ALOHA 5.4.7 (the
program's last release), covering roughly 250 compared values (release rates, tank contents, Gaussian
and heavy-gas zone lengths and widths, fire radiation distances, explosion
overpressures, indoor concentrations). The summary table and the known
deviations are on the [About page](https://hazel-project.eu/about.html).
In short: most groups agree within a few per cent to about 10 %; the
heavy-gas model runs systematically 5–20 % short of ALOHA, which is disclosed
in the application and on the About page rather than tuned away.

Agreement with another program is not proof of agreement with reality. Every
model here is a simplification, and the list of simplifications is shown in
the application next to every result (`engineLimitations.js`).

## What it is based on

The engine is written from published technical sources, with the source cited
next to each formula in the code:

- *ALOHA 5.4.4 Technical Documentation*, NOAA Technical Memorandum NOS OR&R 43
  (2013) — release, dispersion, fire, explosion and indoor models. (The
  formulas come from this document; the comparison runs above were made with
  the program, version 5.4.7.)
- Spicer & Havens, *User's Guide for the DEGADIS 2.1 Dense Gas Dispersion
  Model*, US EPA-450/4-89-019 (1989), and Havens & Spicer, *Development of an
  Atmospheric Dispersion Model for Heavier-than-Air Gas Mixtures*, vol. I
  (1985).
- Chamberlain, G. A. (1987), thermal radiation from flares, *Chem. Eng. Res.
  Des.* 65, 299–309.
- Further primary sources cited in the code and listed on the About page
  (Pasquill, Briggs, Beals, Palazzi et al., Mudan, Roberts, Moorhouse &
  Pritchard, Sherman, Wilson, AIChE guidelines for vapour cloud explosions and
  others).
- US DOE Protective Action Criteria for the chemical data.

One rule governs the project: **no formula enters the code without being
checked against its source.** Where something could not be verified it is left
out or documented as a limitation, not guessed.

HAZEL is an independent project. It is not affiliated with, endorsed by, or
supported by NOAA or the US EPA. ALOHA is a registered trademark of NOAA.

## Run it

### Use the hosted version

Open <https://lab.hazel-project.eu/>. On first load the service worker stores
the whole program (under 10 MiB, including the chemical database) on your
device; after that it works without a connection and can be installed as an
app from the browser menu.

### Host your own copy

HAZEL consists of static files only: no build step, no database, no back end.

1. Copy the files of this repository to any web server, keeping the folder
   structure (or run `python3 -m http.server` in the repository root for a
   local test). `landing.html` is the home page of the project site and is
   not needed for the application.
2. Serve it over HTTPS if it is not on `localhost` — service workers require
   it.
3. Edit `config.js` (in the root) for your installation. It is the only file
   you need to change; every setting is commented.
4. If you change cached files, bump `CACHE_NAME` in `sw.js` (for example
   `hazel-shell-v34`) so clients fetch the new version.

The standalone information pages (`about.html`, `how-to-use.html`) are also
loaded into the application's About and How-to-use views, so keep them next to
`index.html`.

### Optional live weather

Live weather from [MET Norway](https://api.met.no/) is **off by default**. A
browser cannot send the identifying header MET Norway requires, so it needs a
small relay that carries *your own* contact details. [docs/RELAY.md](docs/RELAY.md)
describes a complete example (about 60 lines, nothing stored). Without a relay
the Weather step works in manual-entry mode, which is a full mode of operation.
Address search, elevation and terrain lookups follow the same pattern (see
`config.js`).

### Run the tests

The physics engines are plain ES modules with no dependencies. Each test file
in `tests/` runs under Node.js (version 18 or newer), from any directory:

```sh
node tests/engineTests.js
node tests/heavyGasTests.js
node tests/gaussianAlohaTests.js
node tests/fireAlohaTests.js
node tests/sourceIntegrationTests.js
```

Other `tests/*Tests.js` files cover the remaining modules. Every test file exits with
a non-zero status on failure. Many tests compare HAZEL's results with values
read from ALOHA runs (recorded in comments next to the assertions) and are
meant as regression guards, not as a claim of exact agreement.

## Privacy

HAZEL has no server of its own. Scenarios, saved settings and your own
chemical entries are stored in your browser (IndexedDB and similar browser storage) and
leave your device only if you export them. Network requests the application
can make:

- map tiles from OpenStreetMap, and the Leaflet and jsPDF libraries from public
  CDNs (jsPDF only when you generate a PDF report);
- the icons of the "Other tools" cards in the sidebar;
- when you generate a PDF report, a request to `api.ipify.org` to print your
  public IP address on the report (skipped silently if offline);
- the weather, address, elevation and terrain relays, **only** if you configure
  them in `config.js`.

If you host your own copy and need to avoid third-party requests, serve the
libraries yourself and adjust the loading code accordingly.

## Repository layout

| Path | Contents |
|---|---|
| `index.html`, `manifest.json`, `sw.js`, `config.js` | Application page, PWA manifest, offline cache (must stay in the root) and deployment settings |
| `about.html`, `how-to-use.html` | Documentation pages, shown standalone and inside the app (must stay next to `index.html`) |
| `landing.html` | Home page of the project site (hazel-project.eu); not needed to run the application |
| `js/main.js` | Application entry point |
| `js/engine/` | Physics modules (`engine*.js`) and pure helpers (units, coordinates, solar position): no DOM access |
| `js/services/` | Chemical database, user's own substances, scenario and weather storage, location and weather services, PDF export |
| `js/ui/` | Application shell, the five-step wizard (Location, Chemical, Weather, Source, Results), pages and panels |
| `js/site.js`, `css/` | Script and styles shared by the application and the information pages |
| `data/` | `chemicals.json` (full records) and `chemicals.slim.json` (search index) |
| `tools/convert_pac_data.py` | Rebuilds the two JSON files from the DOE `PacData.xlsx` spreadsheet |
| `tests/` | Test files, one or more per engine |
| `docs/` | `RELAY.md` and `weatherRelayWorkerExample.js` (optional weather relay) |
| `assets/` | Logo and icon |

### Deploying the two sites

The application (`lab.hazel-project.eu`) is the whole tree, in this structure.
The project site (`hazel-project.eu`) uses `landing.html` (uploaded as
`index.html`), `about.html`, `how-to-use.html`, and the folders `css/`,
`assets/` and `js/site.js`, with the same relative paths.

## Contributing

Corrections, sources and code are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). The most valuable contribution is a source
(especially an older handbook that was never digitised) that lets us replace
one of the documented simplifications with the real method.

Please report problems through GitHub issues, or write to
<damian@kocie.mba>. Security-relevant findings should be sent by e-mail rather
than opened as public issues.

## Disclaimer

HAZEL produces indicative estimates from simplified models and from inputs
entered by its user. It is intended for training, planning and as an aid to
professional judgement. It is not a certified, validated or official hazard
assessment and is no substitute for a qualified responder, safety adviser or
the competent authority. Results can be wrong, and the application is labelled
beta for that reason. Use is at your own risk; see the licence for the full
terms, including the exclusion of warranty and liability.

## Licence

HAZEL is released under the [Apache License 2.0](LICENSE). Copyright 2026
Damian Kociemba and contributors. Attribution notices for HAZEL and for the
third-party material it uses are collected in [NOTICE](NOTICE); if you
redistribute HAZEL, keep that file with it.

The "HAZEL" name and logo are not licensed for use as the name of a modified
version in a way that suggests it comes from or is endorsed by this project.
