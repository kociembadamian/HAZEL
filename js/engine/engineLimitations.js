/**
 * engineLimitations.js
 * --------------------
 * A structured, machine-readable statement of what this model does not do.
 *
 * Why this is a code module and not a paragraph in a README: the limitations
 * have to travel with the results. They belong on screen next to the threat
 * zone, in the exported PDF, and in the scenario file. Keeping them as data
 * means the same wording appears everywhere and cannot drift out of sync with
 * the model.
 *
 * Two sources feed this list:
 *   1. Limitations stated by NOAA for ALOHA itself (Tech Doc section 1.2 and
 *      the on-screen limitations list ALOHA shows at startup). These apply to
 *      HAZEL because HAZEL implements the same models.
 *   2. Limitations specific to HAZEL's current state of implementation —
 *      things ALOHA does that HAZEL does not do yet, or simplifications
 *      HAZEL has made. These are marked with scope "hazel" and should shrink
 *      over time as modules are added.
 *
 * Every limitation carries a `consequence` field saying what it means in
 * practice, because "does not account for terrain" is not actionable on its
 * own, while "a valley or building line can channel the cloud somewhere the
 * model does not predict" is.
 *
 * NOTE (2026-10-01, later): "hazel-wind-profile" rewritten — the Gaussian
 * model now uses the 3 m transport wind that reproduces ALOHA; the Gaussian
 * model also follows time-varying releases step by step.
 *
 * NOTE (2026-10-01): "hazel-puddle-spreading" narrowed to the stand-alone
 * puddle — a liquid draining from a tank now forms a spreading puddle
 * (engineSourcePuddle.js, simulateSpreadingPuddle()). The puddle evaporation
 * itself was brought into line with ALOHA the same day (Schmidt number per
 * the Tech Doc; fixed puddle roughness, see PUDDLE_ROUGHNESS_LENGTH); what
 * remained was the vapour pressure, then also improved (Watson's heat of
 * vaporisation below the boiling point) and recorded as
 * "hazel-vapour-pressure"; "hazel-freezing-point" added.
 *
 * NOTE (2026-09-22): the jet fire frustum geometry limitation that used to
 * appear here ("hazel-jet-fire-geometry") has been removed — it is
 * resolved. The original Chamberlain (1987) paper (Figure 1 and sections
 * 4.1.3-4.1.4) confirmed the frustum's spatial placement already used in
 * engineJetFire.js / engineViewFactor.js, and revealed that the R_L
 * formula this project had copied from the ALOHA Tech Doc had a sign
 * error (the Tech Doc's transcription has a PLUS under the square root;
 * Chamberlain's original has MINUS). See engineJetFire.js's module
 * docstring for the full account.
 *
 * NOTE (2026-09-22, later the same day): the "hazel-heavy-gas" entry below
 * has been narrowed. The secondary source gas blanket's STEADY-STATE size
 * (the Q*max closure and the resulting widened starting footprint for the
 * downwind march) is now implemented, using the DEGADIS 2.1 User's Guide
 * (Spicer & Havens, 1989) as a clean source for equations that a degraded
 * scan of the original 1985 Volume I report could not support. What remains
 * out of scope — the blanket's TRANSIENT growth trajectory, instantaneous
 * (puff) releases, and ground heat transfer — is described below. See
 * engineHeavyGas.js's module docstring for the full account.
 *
 * NOTE (2026-09-23): an "indoor concentration" (shelter-in-place) model was
 * added (engineIndoor.js, indoorPanel.js), implementing Tech Doc section
 * 4.6's R-C filter model and Sherman's (1980) building-leakage estimate of
 * the infiltration time constant. It was not previously in this list as a
 * limitation — it was simply absent, with no entry here at all — because
 * whether it was worth building was, until now, an open and undecided
 * question (see the 2026-09-22 project review). The genuine
 * simplifications it does carry are recorded below as "hazel-indoor".
 *
 * NOTE (2026-10-02): the "hazel-tank-phase-selection" entry below now
 * describes the compressed-gas tank (Source step "Contents: Gas only"),
 * added after ALOHA comparisons C1/C2 (carbon monoxide at 20 atm). It
 * replaces the 2026-09-23 warning-only treatment of substances flagged as
 * non-condensable.
 *
 * NOTE (2026-09-26): the "hazel-heavy-gas" entry below has been narrowed
 * again, in the other direction from most of these notes — a genuine bug,
 * not just a documentation update. A user reported that changing a
 * chlorine release's duration from 60 s to 6 s at the same rate produced
 * IDENTICAL threat distances: engineHeavyGas.js's marchDownwind() never
 * read releaseDuration at all. The fix (a finite-duration correction using
 * the same Beals/Palazzi sigma_x smearing already implemented for the
 * Gaussian model) is described fully in engineHeavyGas.js's module
 * docstring. This entry now describes only what remains after that fix:
 * this project still represents a release whose rate genuinely changes
 * over time (a draining tank) as one constant rate held for the whole
 * duration, rather than breaking it into several separate time-stepped
 * steady-state sources.
 *
 * NOTE (2026-09-26, later the same day): after the finite-duration bug
 * above was found and fixed, a project-wide audit was carried out looking
 * for other places a "known, minor" gap might in practice be worse than
 * assumed (the 2026-09-26 duration review). Three
 * outcomes worth recording here:
 *
 *   - Two further bugs of the SAME shape (a fixed-resolution coarse search
 *     stepping clean over a sharp finite-duration "cliff") and one
 *     unrelated corruption bug were found and fixed in code, not just
 *     documented: engineFlammableMass.js's heavyGasFlammableMass() had the
 *     identical coarse-search vulnerability as findHeavyGasThreatZone()
 *     above, silently starving VCE overpressure calculations for a brief
 *     dense-gas release; and engineSourcePuddle.js's boiling/non-boiling
 *     switch could produce NaN or Infinity for a liquefied gas modelled as
 *     a puddle at ambient temperature, once volatilityCorrection()'s
 *     Infinity return value leaked into a comparison it could never lose.
 *     See those files' own module docstrings.
 *   - The "hazel-indoor" entry below was found to be actually WRONG, not
 *     merely simplified: feeding the indoor R-C filter model the raw
 *     release duration (rather than accounting for how long a brief
 *     release's cloud actually lingers at a downwind point) understated
 *     indoor exposure by up to roughly 37x, the opposite of what that
 *     entry's old wording claimed ("errs toward overstating"). Fixed via
 *     effectiveExposureDurationSeconds() in engineIndoor.js; the entry
 *     below now describes the corrected behaviour.
 *   - engineSourceTank.js's two-phase "dry hole" behaviour, also flagged by
 *     the audit, was reviewed and deliberately left unchanged: it matches
 *     ADR transport reality (a sloshing or rolling tank keeps washing a
 *     hole a static fill-level calculation would call dry), so it is
 *     documented in that file's own module docstring as an intentional
 *     modelling choice rather than surfaced here as a limitation.
 *
 * NOTE (2026-09-26, later still): the "hazel-heavy-gas" entry's wording was
 * trimmed to describe HAZEL's own behaviour on its own terms, rather than
 * repeatedly measuring it against ALOHA's specific five-time-step
 * implementation — the underlying physics citations (DEGADIS, Beals,
 * Palazzi) are unchanged, only the framing. ALOHA comparisons are kept
 * where they are genuinely useful context (the "How to use" page, and this
 * module's own docstring above), not scattered through user-facing text.
 *
 * NOTE (2026-09-30): a separate, real bug in the OTHER direction was found
 * and fixed. stepSource.js's assessDispersionModel() stood in a fictional
 * 1 m nominal diameter for every "direct" (non-puddle, non-tank) release,
 * regardless of the actual release rate — but the ALOHA Tech Doc (section
 * 4.4.3, "Secondary Source in ALOHA") states plainly that "Most of the
 * Primary Sources in ALOHA are point sources; however, the evaporating
 * puddle has a defined area" — a direct release is explicitly NOT one of
 * the sources ALOHA gives a physical footprint to. That fictional 1 m
 * became a real half-metre floor on the downwind march's starting
 * footprint (engineHeavyGas.js's marchDownwind(), via
 * buildDispersionScenario()'s sourceHalfWidth), which a true point source
 * does not have. Fixed: a direct release's characteristic dimension is now
 * a near-zero value, clamped only by the numerical floors already in place
 * to avoid a literal zero radius — matching ALOHA's point-source treatment
 * faithfully rather than approximately.
 *
 * The effect of this fix on the computed distances is small (a few percent
 * to ~15% for a very small release; nil once a secondary-source blanket
 * forms, since the blanket's own steady-state radius then sets the starting
 * footprint), but it removes an invented number that the Tech Doc does not
 * support.
 *
 * Separately, controlled comparisons against real ALOHA runs (chlorine,
 * acetone, sulfur dioxide; stability classes C, D, E, F; wind 1.5-8 m/s;
 * 1-30 min; 0.01-15 kg/s) found the heavy-gas zones scattered between 0.4x
 * and 1.7x of ALOHA's, and too SHORT under stable night-time conditions.
 * Two corrections taken from the Tech Doc (a stability-corrected friction
 * velocity, section 4.2.3; and a mass balance consistent with the drawn
 * crosswind profile once its core has gone, section 4.4.4.1 — see
 * engineHeavyGas.js) brought every one of those comparisons into a tight
 * 0.78-0.94x band. The small, uniform shortfall that remains matches the
 * Tech Doc's own statement that ALOHA-DEGADIS threat zones average about
 * 10% longer than DEGADIS's; it is disclosed in the "hazel-heavy-gas"
 * entry below, which stays at "medium" because it runs in the
 * non-conservative direction. See
 * the 2026-09-30 ALOHA re-validation runs.
 */

export const MODEL_LIMITATIONS = [
  /* ---------- Inherited from the underlying models ---------- */
  {
    id: "terrain",
    scope: "model",
    severity: "high",
    title: "Terrain and buildings are not resolved",
    detail:
      "The wind field is uniform in the horizontal plane and constant in time. " +
      "Hills, valleys, embankments, walls and buildings are not represented.",
    consequence:
      "Where terrain channels or blocks the wind — a river valley, a cutting, a " +
      "line of warehouses — the real cloud can travel somewhere the model does " +
      "not show, or concentrate more than predicted.",
  },
  {
    id: "low-wind",
    scope: "model",
    severity: "high",
    title: "Not valid in calm or very light wind",
    detail:
      "The model requires wind above 1 m/s measured at 10 m. Below that the " +
      "plume is no longer wind-dominated and the mathematics has no meaningful " +
      "solution.",
    consequence:
      "In calm conditions a cloud can meander, pool in low ground, or travel " +
      "upwind. HAZEL refuses to produce a result rather than showing one that " +
      "cannot be trusted.",
  },
  {
    id: "steady-weather",
    scope: "model",
    severity: "medium",
    title: "Weather is assumed constant for the whole release",
    detail:
      "Wind speed, wind direction and stability are held fixed from the start " +
      "of the release to the end, and are assumed to be the same everywhere in " +
      "the modelled area.",
    consequence:
      "A wind shift during the release will move the real cloud away from the " +
      "predicted zone. The longer the release, the less reliable this " +
      "assumption becomes — which is why releases beyond one hour are out of scope.",
  },
  {
    id: "neutrally-buoyant",
    scope: "model",
    severity: "high",
    title: "Applies only to neutrally buoyant gases",
    detail:
      "This model treats the cloud as a passive tracer carried by the wind. A " +
      "gas appreciably denser than air (chlorine, propane, ammonia released as " +
      "a liquid, most refrigerants) behaves differently: it slumps, spreads " +
      "sideways under gravity and hugs the ground.",
    consequence:
      "Using the Gaussian model for a dense gas will usually UNDERESTIMATE the " +
      "hazard close to the source and misplace the cloud. Dense gases need the " +
      "heavy gas model, which is a separate calculation.",
  },
  {
    id: "short-distance",
    scope: "model",
    severity: "medium",
    title: "Unreliable very close to the source",
    detail:
      "Empirical dispersion parameters were derived from measurements made at " +
      "distances of roughly 100 m and beyond. Within the first tens of metres, " +
      "and inside the release structure itself, the model has no support.",
    consequence:
      "Do not use the figures to make decisions about the immediate vicinity of " +
      "the release. That area should be treated as hazardous regardless of what " +
      "the model reports.",
  },
  {
    id: "particulates",
    scope: "model",
    severity: "medium",
    title: "Gases and vapours only",
    detail:
      "Particulates, aerosols, mists, dusts and radioactive material are not " +
      "modelled. Deposition, settling and washout are not represented.",
    consequence:
      "Results do not apply to solid or liquid material carried in the air, and " +
      "do not describe contamination of ground or water.",
  },
  {
    id: "chemical-reaction",
    scope: "model",
    severity: "medium",
    title: "No chemical reaction in the plume",
    detail:
      "The released material is treated as chemically inert once airborne. " +
      "Reaction with humidity, sunlight or other substances is not modelled.",
    consequence:
      "For chemicals that react on contact with moist air the real hazard can " +
      "differ from the prediction in both composition and extent.",
  },
  {
    id: "peak-not-average",
    scope: "model",
    severity: "low",
    title: "Peak concentration compared against averaged thresholds",
    detail:
      "HAZEL reports the highest concentration reached at a location. Levels of " +
      "Concern such as AEGL and ERPG are defined over an averaging period, " +
      "usually 60 minutes.",
    consequence:
      "A location is flagged as inside the threat zone if the concentration is " +
      "ever high enough, even briefly. This errs toward a larger zone, which is " +
      "the intended direction for a planning and response tool.",
  },

  /* ---------- Specific to HAZEL's current implementation ---------- */
  {
    id: "hazel-heavy-gas",
    scope: "hazel",
    severity: "medium",
    title: "Heavy gas model: constant-rate simplification, and zones slightly shorter than the reference results",
    detail:
      "The dense-gas calculation (engineHeavyGas.js) implements DEGADIS's " +
      "far-field downwind dispersion, with the actual homogeneous-core-plus-" +
      "Gaussian-tail crosswind profile (Tech Doc section 4.4.4), the secondary " +
      "source gas blanket that forms when a release outpaces the atmosphere's " +
      "own capacity to take gas up passively (the 'Q*max' maximum atmospheric " +
      "takeup flux, DEGADIS 2.1 User's Guide eq. V.59), and, as of 2026-09-26, " +
      "a genuine finite-duration correction: the Beals (1971) sigma_x " +
      "alongwind smearing and Palazzi et al. (1982) leading/trailing-edge " +
      "construction already used by HAZEL's Gaussian model, applied to build " +
      "a time-varying heavy-gas cloud from the underlying steady-state plume. " +
      "A shorter release now genuinely reports a shorter threat distance than " +
      "a longer one at the same rate. As of 2026-09-30 a release whose rate " +
      "changes over time (an evaporating puddle, a draining tank) is also " +
      "represented the way ALOHA does it — as up to five steady steps whose " +
      "clouds are added together — instead of its peak rate held throughout. " +
      "Since 2026-10-01 the passive (Gaussian) model does the same. This model " +
      "also does not implement instantaneous (puff) releases via the " +
      "momentum-balance 'gravity current head and tail' equations, the gas " +
      "blanket's own TRANSIENT growth trajectory, or ground heat transfer. " +
      "Separately (2026-09-30): a direct/continuous release's starting " +
      "footprint is now correctly treated as a true point source, per the " +
      "Tech Doc's explicit statement that non-puddle Primary Sources are " +
      "point sources — a fictional 1 m nominal diameter previously stood in " +
      "here instead. Across controlled comparisons with real ALOHA runs " +
      "(stability classes C to F, wind 1.5-8 m/s, 1-30 minute releases), " +
      "HAZEL's heavy-gas threat distances come out uniformly about 5-20% " +
      "shorter than ALOHA's — close to the ~10% by which the Tech Doc says " +
      "ALOHA's own version of this model runs longer than the original " +
      "DEGADIS it is based on.",
    consequence:
      "For a dense gas, a release that declines over time (a boiling puddle, " +
      "a draining tank) is followed step by step in both dispersion models. " +
      "Set against the reference results of the comparison tests (see About), " +
      "a HAZEL heavy-gas zone is typically 5-20% shorter. Allow at least that " +
      "margin beyond the drawn edge when using it for protective action.",
  },

  {
    id: "hazel-tank-phase-selection",
    scope: "hazel",
    severity: "low",
    title: "Compressed-gas tanks: critical temperature estimated, tank kept at its starting temperature",
    detail:
      "A tank can hold a liquid (or a gas liquefied under pressure) or a compressed " +
      "gas only (Tech Doc 3.4.2, 3.4.6). The Source step chooses gas only by itself " +
      "when the substance is flagged non-condensable in the Chemical library or the " +
      "tank temperature is above the substance's critical temperature — which the " +
      "substance data do not carry, so it is estimated as 1.65 times the boiling " +
      "point (true ratios for the light gases concerned: 1.63-1.71). The user can " +
      "override the choice. The gas leaves choked, then unchoked, and expands to " +
      "atmospheric pressure, cooling to T (Pa/P)^((gamma-1)/gamma); the dispersion " +
      "screening and the heavy-gas model use that cold source density (carbon " +
      "monoxide from 20 atm: about -151 C, 2.3 times as dense as air) — but only for " +
      "a gas at least 0.75 times as heavy as air: ALOHA ran methane expanded from " +
      "50 atm as a Gaussian plume, carbon monoxide and acetylene as heavy gases; the exact " +
      "cut-off (somewhere in 0.55-0.90 of air's molecular weight) is " +
      "not known. The tank depressurises polytropically, P ~ m^n with " +
      "n = (1 + gamma)/2, fitted to the share of the contents ALOHA reports as " +
      "released in five runs (CO 20/5/2 atm, chlorine 3 atm, methane 50 atm: all " +
      "within 4%). The tank mass is corrected for real-gas behaviour (Pitzer virial " +
      "correlation) when the critical temperature and pressure are entered — in the " +
      "Source step or the Chemical library, from the NIST Chemistry WebBook; then it " +
      "matches ALOHA's within 2% (CO, chlorine, methane, acetylene). Without them the " +
      "contents are an ideal gas, up to ~12% short at high pressure.",
    consequence:
      "For a gas between about 0.55 and 0.90 of air's molecular weight the choice " +
      "between dense and passive dispersion is uncertain. Without the critical constants, " +
      "the released mass can be up to ~12% too low at high pressure. Near the estimated " +
      "critical temperature (ethylene at about 10-15 C, for instance) the automatic " +
      "liquid/gas choice can go either way — set the contents explicitly there.",
  },
  {
    id: "hazel-indoor",
    scope: "hazel",
    severity: "low",
    title: "Indoor concentration assumes the building sits on the plume centreline, and estimates how long the cloud actually lingers there",
    detail:
      "The indoor-concentration model (engineIndoor.js) implements the " +
      "standard R-C filter model (Tech Doc section 4.6) exactly, including " +
      "Sherman's (1980) generalised estimate of the infiltration time " +
      "constant from building floor area, height, wind, and the " +
      "indoor/outdoor temperature difference (air-change rates checked against " +
      "ALOHA's printed values 2026-10-02: 0.854 / 0.392 / 0.246 vs 0.85 / 0.39 / " +
      "0.24 per hour). The building is assumed to " +
      "sit directly on the plume centreline — the most exposed position a " +
      "building at that downwind distance could be in, rather than one the " +
      "user places off-axis. The outdoor concentration feeding the model is " +
      "held at its peak value for an EFFECTIVE exposure duration, not the " +
      "true rise-and-fall profile of a passing cloud — the same " +
      "conservative simplification already used for the release rate " +
      "itself throughout this project — but, as of 2026-09-26, that " +
      "duration is not simply the release duration. A brief release's " +
      "elevated concentration lingers at a fixed downwind point for longer " +
      "than the release itself lasted, by roughly " +
      "2*sigma_x(distance)/windSpeed10m (the same Beals 1971 along-wind " +
      "spreading parameter already used by finiteDurationFactor() in " +
      "engineHeavyGas.js and peakConcentration() in engineGaussian.js) — a " +
      "span that grows with distance and, for a short release observed far " +
      "downwind, previously left indoor exposure understated by as much as " +
      "roughly 37x (found in the 2026-09-26 duration review). " +
      "effectiveExposureDurationSeconds() in engineIndoor.js now adds that " +
      "residence-time term on top of the release duration.",
    consequence:
      "A real building offset from the centreline would see a lower " +
      "outdoor concentration, and therefore an even lower indoor one, than " +
      "this model reports. The exposure-duration correction is deliberately " +
      "one-sided (it can only lengthen the modelled exposure, never " +
      "shorten it) and tied to the actual downwind spreading at the " +
      "building's specific distance, rather than an arbitrary or unbounded " +
      "margin — a long, genuinely continuous release sees essentially no " +
      "change from before. Sherman's method is also, by its own author's " +
      "account, a broad generalisation for lack of anything more specific: " +
      "a real building's actual tightness can differ substantially, which " +
      "is why a user who knows a better time constant for a specific " +
      "building can enter it directly instead.",
  },
  {
    id: "hazel-custom-chemical-storage",
    scope: "hazel",
    severity: "low",
    title: "Custom chemical library entries live only in this browser",
    detail:
      "Substances and data enrichments a user adds on the Chemical library " +
      "page (customChemicalStore.js) are stored in this browser's IndexedDB, " +
      "the same as saved scenarios (scenarioStorage.js). There is no server " +
      "and no account to sync them to.",
    consequence:
      "Clearing this browser's site data, switching browsers or devices, or a " +
      "wiped profile loses this library outright. The Chemical library page " +
      "offers a JSON export (and matching import) specifically so a user " +
      "curating more than a handful of entries has an independent backup, " +
      "and shows an estimate of how much local storage HAZEL is using so " +
      "growth stays visible rather than a surprise.",
  },
  {
    id: "hazel-wind-profile",
    scope: "hazel",
    severity: "low",
    title: "Passive plume carried by the wind at 3 m",
    detail:
      "The Gaussian model carries the plume with the wind at 3 m above ground, " +
      "from the stability-corrected wind profile of the Tech Doc (section " +
      "4.2.3), rather than with a value weighted over the depth the cloud " +
      "occupies. Side-by-side ALOHA runs (2026-10-01) are reproduced to within " +
      "1% this way for ground-level point sources in classes A, D and F, open " +
      "and urban terrain.",
    consequence:
      "For ground-level releases, the common transport case, none in practice. " +
      "For an elevated release the travel time and dilution carry a modest error.",
  },
  {
    id: "hazel-ground-conduction",
    scope: "hazel",
    severity: "low",
    title: "Ground conduction uses an analytical approximation",
    detail:
      "Heat flow between a puddle and the ground beneath it is computed with " +
      "the error-function solution for a semi-infinite solid, rather than a " +
      "numerical finite-difference scheme over a soil slab.",
    consequence:
      "The approximation is exact only while the puddle temperature is " +
      "constant, and the puddle does cool as it evaporates. It is most " +
      "accurate in the first minutes after a spill, when conduction is " +
      "strongest and most of the material evaporates, and drifts slowly " +
      "thereafter. In the comparison tests (a published benzene example, and " +
      "acetone and methanol puddles) the evaporation rate agrees with the " +
      "reference results to within about 5% once the vapour pressure is the " +
      "same (see the vapour-pressure limitation).",
  },
  {
    id: "hazel-puddle-spreading",
    scope: "hazel",
    severity: "low",
    title: "A stand-alone puddle has a fixed area",
    detail:
      "For the \"Evaporating puddle\" source the puddle is a circle of the " +
      "area entered, for the whole release. (A puddle formed by a leaking " +
      "tank does spread over time, up to the maximum area entered, as in " +
      "ALOHA — this applies only to the stand-alone puddle.)",
    consequence:
      "Evaporation in the first moments of a spill is slightly overestimated, " +
      "because the full area is assumed to exist immediately. Where the " +
      "puddle size is known — from the spill volume, or from bunding at the " +
      "site — entering it directly gives a good result.",
  },
  {
    id: "hazel-vapour-pressure",
    scope: "hazel",
    severity: "low",
    title: "Vapour pressure is estimated from the boiling point",
    detail:
      "HAZEL estimates a liquid's vapour pressure from its boiling point and " +
      "its heat of vaporisation at the boiling point (Clausius-Clapeyron, " +
      "with Watson's temperature dependence below the boiling point), rather " +
      "than from a fitted vapour-pressure curve as ALOHA does. Against " +
      "ALOHA's values for methanol, acetone, benzene and toluene between 5 " +
      "and 35 C it is within about 10%, usually 5%, and slightly high.",
    consequence:
      "Evaporation from a puddle is proportional to the vapour pressure, so " +
      "it carries the same small error, on the cautious side. The heat of " +
      "vaporisation entered must be the value at the boiling point: a 25 C " +
      "value (several kJ/mol higher) makes the vapour pressure, and the " +
      "evaporation, too low.",
  },
  {
    id: "hazel-freezing-point",
    scope: "hazel",
    severity: "low",
    title: "No check that the liquid is actually liquid",
    detail:
      "HAZEL does not know a substance's freezing point, so it will model a " +
      "puddle or liquid tank release even when the air is colder than that " +
      "point (benzene freezes at 5.5 C, acetic acid at 16.6 C). ALOHA " +
      "refuses such a case.",
    consequence:
      "Check the freezing point yourself when modelling a liquid in cold " +
      "weather. A frozen spill gives off far less vapour than HAZEL's puddle " +
      "model would show.",
  },
  {
    id: "hazel-long-distance",
    scope: "hazel",
    severity: "medium",
    title: "Distances beyond about 20 km are shown, but should not be trusted as precise",
    detail:
      "The downwind search that produces this number is mathematically " +
      "self-consistent out to any distance — the arithmetic behind a figure " +
      "of 20 km and one of 50 km is equally valid on its own terms. But the " +
      "physical assumptions everything is built on (a straight-line, " +
      "constant-speed, constant-direction wind; uniform terrain and " +
      "roughness; one unchanging stability class) become steadily less " +
      "realistic the further downwind and the longer the release runs — " +
      "real wind meanders, terrain channels or blocks the plume, and the " +
      "atmosphere genuinely changes over the time such a distance takes to " +
      "reach. A number that is internally consistent is not the same thing " +
      "as a number that is credible at that range.",
    consequence:
      "Treat any distance beyond roughly 20 km as an indication that the " +
      "hazard is large and far-reaching, not as a specific line on a map. " +
      "For planning or response decisions at that range, the exact figure " +
      "matters far less than the fact that it is large — do not read the " +
      "last kilometre of it as meaningful.",
  },
  {
    id: "hazel-model-choice",
    scope: "hazel",
    severity: "low",
    title: "Choice between the Gaussian and Heavy Gas models: a calibrated threshold and one deliberate exception",
    detail:
      "The Richardson-number screening (Tech Doc 4.4.1) uses a threshold of 1.95, not " +
      "the Tech Doc's 1: ALOHA's own choices in twelve comparison runs fall on either " +
      "side of a cut-off between 1.85 and 2.06 with HAZEL's Richardson number. For a " +
      "flashing two-phase release of a gas lighter than air (ammonia), ALOHA treats the " +
      "cold aerosol as a heavy gas; HAZEL keeps the Gaussian model, whose zones were " +
      "closer to ALOHA's (0.91-0.94) than HAZEL's own heavy-gas zones (0.80-1.10).",
    consequence:
      "Near the threshold (Richardson number about 1.8-2.1) either model could " +
      "reasonably apply, so the choice is uncertain there. A flashing ammonia release " +
      "is kept on the Gaussian model: its zone distances matched the reference results " +
      "within 10%, but the outline is the narrower, longer Gaussian shape.",
  },
  {
    id: "hazel-validation",
    scope: "hazel",
    severity: "high",
    title: "Not independently validated",
    detail:
      "HAZEL's output has not been compared against field trial data or " +
      "certified by any authority. The models it implements are published and " +
      "widely used, but this implementation of them is new.",
    consequence:
      "Treat results as an educational and planning estimate. Do not use them " +
      "as the sole basis for decisions during a live incident.",
  },
];

/**
 * Returns the limitations that are relevant to a given scenario, so the
 * results view can show the ones that actually bear on this calculation rather
 * than a wall of text every time.
 *
 * The general-purpose ones are always returned; the conditional ones are added
 * when the scenario triggers them.
 *
 * @param {object} scenario
 * @param {number} [scenario.vapourDensityRatio] - cloud density / air density
 * @param {number} [scenario.maxDownwindDistance] - m, result of the calculation
 * @returns {Array<object>}
 */
export function relevantLimitations(scenario = {}) {
  const always = MODEL_LIMITATIONS.filter((item) =>
    ["terrain", "steady-weather", "hazel-validation", "peak-not-average"].includes(item.id)
  );

  const conditional = [];

  // A cloud noticeably denser than air is the single most common way to use
  // this model outside its range, so flag it explicitly.
  if (scenario.vapourDensityRatio && scenario.vapourDensityRatio > 1.1) {
    conditional.push(MODEL_LIMITATIONS.find((i) => i.id === "neutrally-buoyant"));
    conditional.push(MODEL_LIMITATIONS.find((i) => i.id === "hazel-heavy-gas"));
  }

  // Short threat distances fall in the range where the empirical parameters
  // have the least support.
  if (scenario.maxDownwindDistance && scenario.maxDownwindDistance < 100) {
    conditional.push(MODEL_LIMITATIONS.find((i) => i.id === "short-distance"));
  }

  // Long threat distances (2026-09-28, prompted by a real ALOHA comparison
  // at multi-substance, 30-60 min durations): the search that produces this
  // number stays mathematically well-behaved arbitrarily far out, but the
  // steady-wind/uniform-terrain assumptions it rests on do not — see
  // "hazel-long-distance" above. 20 km is not a re-derived physical limit;
  // it is this project's own default search range (engineHeavyGas.js's
  // marchDownwind(), engineGaussian.js's findThreatZone()), reused here as a
  // natural, already-existing boundary rather than inventing a new number.
  if (scenario.maxDownwindDistance && scenario.maxDownwindDistance >= 20000) {
    conditional.push(MODEL_LIMITATIONS.find((i) => i.id === "hazel-long-distance"));
  }

  return [...always, ...conditional.filter(Boolean)];
}

/**
 * One-line statement for places too small for the full list — a footer, a
 * tooltip, the header of an exported file.
 */
export const SHORT_DISCLAIMER = "Indicative simulation only.";
