/**
 * engineHeavyGas.js
 * -----------------
 * Dense (heavy) gas dispersion — the model engineDispersionChoice.js refers
 * scenarios to when the Richardson number test says the release slumps and
 * spreads under gravity instead of dispersing passively.
 *
 * STAGE 1 SCOPE, STATED UP FRONT
 * -------------------------------
 * This implements a genuine, physically grounded piece of ALOHA-DEGADIS's
 * heavy gas methodology — the far-field downwind dispersion of a CONTINUOUS,
 * constant-rate release, PLUS (as of 2026-09-22, see "SECONDARY SOURCE
 * BLANKET" below) the steady-state sizing of the near-field gas "blanket"
 * that forms when a release outpaces the atmosphere's own capacity to take
 * gas up passively, PLUS (as of 2026-09-26, see "FINITE-DURATION
 * CORRECTION" below) a genuine dependence of the reported concentration on
 * how long the release actually lasts. It deliberately does NOT implement:
 *
 *   - Instantaneous (puff) releases modelled via the momentum-balance
 *     "gravity current head and tail" equations, or the blanket's own
 *     TRANSIENT growth trajectory (see "SECONDARY SOURCE BLANKET" below for
 *     why the blanket's steady-state size is what this project needs
 *     instead).
 *   - Ground heat transfer and humidity effects on entrainment (Tech Doc
 *     section 4.4.4.3). The dispersion coefficients used here are the ones
 *     that apply without that correction.
 *   - (Formerly listed here: ALOHA's "up to five time-stepped sources"
 *     treatment of a release whose rate varies over time. Implemented
 *     2026-09-30 — see compositeMarch().)
 *
 * SOURCES
 * -------
 * Three documents were used together:
 *
 *   [TechDoc]     Jones, Lehr, Simecek-Beatty, Reynolds (2013). ALOHA 5.4.4
 *                 Technical Documentation, NOAA TM NOS OR&R 43, section 4.4.
 *                 Gives the vertical dispersion ODE and the effective
 *                 height/velocity relations in clean, unambiguous form.
 *
 *   [Vol.I]       Havens, J. and Spicer, T.O. (1985). Development of an
 *                 Atmospheric Dispersion Model for Heavier-Than-Air Gas
 *                 Mixtures, Volume I. U.S. Coast Guard report CG-D-22-85.
 *                 The original DEGADIS derivation TechDoc summarises.
 *
 *   [UsersGuide]  Spicer, T. and Havens, J. (1989). User's Guide for the
 *                 DEGADIS 2.1 Dense Gas Dispersion Model, EPA-450/4-89-019.
 *                 A far cleaner, better-scanned restatement of the same
 *                 Chapter V derivation as [Vol.I] (same equation numbers,
 *                 V.1 through V.101) — this is where the constants and the
 *                 Q*max closure below (previously unreadable in the only
 *                 available [Vol.I] scan) were finally confirmed.
 *
 * SECONDARY SOURCE BLANKET — RESOLVED 2026-09-22
 * ------------------------------------------------
 * A gas "secondary source blanket" forms over the primary source whenever
 * the release rate, spread over the primary source's own footprint, exceeds
 * the maximum rate at which the atmosphere can take gas up passively —
 * Q*max, the "maximum atmospheric takeup flux" [UsersGuide eq. V.59]. When
 * that happens, the excess gas piles up and spreads outward under gravity
 * (a "gravity current") until the blanket's own, now-larger footprint has
 * grown enough that the atmosphere's takeup over that larger area matches
 * the release rate again — a steady-state balance, explicitly described in
 * [TechDoc section 4.4.3]: "the blanket reaches its steady-state size when
 * the atmospheric uptake rate equals the Primary Source."
 *
 * [UsersGuide]'s own equations (V.1-V.31) describe the full TRANSIENT
 * trajectory of that growth — a momentum balance on an accelerating gravity
 * current, split into "head" and "tail" regions, with its own set of
 * empirical constants (a_v, b_v, d_v, e_v, epsilon). That transient
 * trajectory matters when the RATE of growth itself is of interest, or for
 * a genuinely instantaneous release. This project's dispersion engines,
 * however, already evaluate every release at its peak rate held constant
 * (see the module docstring for both this file and engineGaussian.js) — a
 * conservative simplification made everywhere else, and one that happens to
 * make the blanket's STEADY-STATE size the only piece of eqs. V.1-V.50 this
 * project actually needs: at steady state, the contaminant mass balance on
 * the blanket [UsersGuide eq. V.34], dMc/dt = E(t) - Q*max*(pi*R^2), reduces
 * (since dMc/dt = 0 at steady state) to
 *
 *     E = Q*max * pi * R_steady^2
 *
 * an exact, direct consequence of that equation, not an approximation
 * layered on top of it. secondarySourceBlanketRadius() below is exactly
 * this relation, solved for R_steady. This avoids building the entire
 * momentum-balance ODE system (eqs. V.1-V.31), which this project's own
 * steady-release simplification makes unnecessary: by the time a constant
 * release rate has been sustained long enough to matter, the blanket has
 * already reached (or is closely approaching) this steady size.
 *
 * The steady-state radius, once found, replaces the raw physical source
 * dimension (a puddle's diameter, or a tank's small rupture hole) as the
 * STARTING footprint for the downwind march below — see marchDownwind().
 * This is the concrete difference the blanket model makes: a release that
 * outpaces atmospheric takeup starts its downwind journey already spread
 * over a wider, shallower area than the bare hole or puddle would suggest,
 * exactly the physical effect the blanket represents.
 *
 * FINITE-DURATION CORRECTION — RESOLVED 2026-09-26
 * ---------------------------------------------------
 * Reported bug: changing a chlorine release's declared duration from 60 s
 * to 6 s, at the SAME 1 kg/s rate, produced the IDENTICAL threat distances
 * at every threshold. That is not defensible — a release one-tenth the
 * total mass cannot plausibly reach exactly as far — and the cause was
 * structural: marchDownwind() below never read releaseDuration at all, so
 * every release was treated as though it had been running forever. This was
 * a real gap, not a side effect of any earlier change to this file (in
 * particular, the crosswind "homogeneous core + Gaussian tail" profile and
 * the cosine-spaced footprint sampling added earlier only ever touched how
 * the plume's cross-section is drawn, never whether duration was read at
 * all — marchDownwind()'s signature never accepted it, from when this file
 * was first written).
 *
 * The right fix was found not by building a "puff" momentum-balance model
 * (which would only govern the blanket's own transient growth, a separate
 * question — see above) but by reading what [TechDoc section 4.4] actually
 * says ALOHA-DEGADIS itself does for a heavy-gas release that does not run
 * forever:
 *
 *   "For any non-instantaneous sources in ALOHA, the model generates a
 *   five-step release; each step is a finite-duration steady-state
 *   release. The Heavy Gas model generates infinite-duration steady-state
 *   plumes for each of these sources. A composite time-varying cloud is
 *   created by adding together pieces of the five steady-state plumes. The
 *   pieces start as steady-state plumes ten meters in length. Each piece is
 *   converted into a Gaussian in the downwind direction, conserving mass,
 *   but maintaining its vertical and horizontal dimensions. The pieces are
 *   summed to create the time-varying cloud. The Gaussian dispersion
 *   parameter used, sigma_x, is the same as that used in the Gaussian
 *   dispersion model (Beals 1971)."
 *
 * In other words: ALOHA does not re-derive dense-gas physics for a finite
 * release either. It takes the SAME steady-state DEGADIS plume this file
 * already computes, and smears its along-wind edges using the SAME Beals
 * (1971) sigma_x correlation, and the SAME Palazzi et al. (1982)
 * leading/trailing-edge construction, already implemented and tested in
 * engineGaussian.js's peakConcentration() for the passive model. Because
 * this project represents every release (heavy gas or passive) as a single
 * constant rate held for one duration, rather than ALOHA's up-to-five
 * time-stepped sources, there is only ever one steady-state plume to
 * convert — which collapses ALOHA's "sum of 10-metre Gaussian-in-x pieces"
 * into exactly the same closed-form erf expression peakConcentration()
 * already uses. finiteDurationFactor() below is that expression, applied to
 * this file's own centreline concentration. No new physics, no new source
 * material, and no unverified formula were needed: this reuses
 * machinery already validated elsewhere in this project.
 *
 * UPDATE 2026-09-30: ALOHA's five-step breakdown of a release whose RATE
 * changes over time (an evaporating puddle, a draining tank) is now
 * implemented as well — see releaseStepsFromSeries() and compositeMarch()
 * below. The single-step path described above is unchanged and is still
 * what a constant (direct) release uses.
 *
 * INTEGRATION STEP — FIXED 2026-10-01
 * ------------------------------------
 * marchDownwind() used to advance the cloud's growth equations in one
 * explicit step per output station. The coarse search passes space their
 * stations ~50 m apart, so the first step from a source a few metres wide
 * overshot the cloud's growth, and the concentration at "50 m" depended on
 * how far the march happened to reach. The search trusted those values, so
 * zones of small sources (under ~100-250 m) came out 15-60% short, or were
 * cut off at the first coarse station. Found in ALOHA comparisons with
 * small benzene puddles (G1-G6): a 100 m2 puddle gave 38/56/56 m against
 * ALOHA's 44/109/256 m. The march now integrates between stations in
 * midpoint sub-steps of at most 2% of the distance; the result no longer
 * depends on the station spacing, the small-source zones fall in the same
 * band as every other comparison (0.71-0.85x), and the long-range zones
 * are unchanged (0.78-0.95x).
 *
 * ALOHA COMPARISON FIXES — 2026-09-30
 * -------------------------------------
 * Controlled comparisons against real ALOHA runs (chlorine, acetone and
 * sulfur dioxide; stability classes C, D, E and F; wind 1.5-8 m/s; 1 to 30
 * minute releases; 0.01 to 15 kg/s) showed this model's zones scattered
 * from 0.4x to 1.7x of ALOHA's, and systematically too SHORT under stable
 * night-time conditions. Two corrections, each taken from the Tech Doc
 * rather than tuned, brought every one of those comparisons into a tight
 * 0.78-0.94x band (see
 * the 2026-09-30 ALOHA re-validation runs):
 *
 *   1. heavyGasFrictionVelocity(): the stability-corrected wind profile
 *      of Tech Doc 4.2.3 (Obukhov length per class, Businger psi, and the
 *      0.10 m roughness cap the Tech Doc states for this model), in place
 *      of the neutral log law the march used for every class.
 *   2. The mass-carrying width is max(2 B_eff, sqrt(pi) S_y), with
 *      S_y = sqrt(2) sigma_y: once the homogeneous core has gone, "the cloud
 *      width is defined by S_y(x)" [Tech Doc 4.4.4.1], and the concentration
 *      must carry the release's mass across the profile actually drawn.
 *
 * The small uniform shortfall that remains is of the same size as the
 * Tech Doc's own reported difference between ALOHA-DEGADIS and DEGADIS
 * (ALOHA's threat zones "averaged 10% longer than those predicted by
 * DEGADIS", section 4.4), and is disclosed in engineLimitations.js rather
 * than tuned away.
 *
 * WHAT REPLACES THE REST
 * -----------------------
 * Both the primary-source boundary-layer treatment (Vol.I section III.1.2)
 * and the downwind dispersion phase (section III.2) turn out to share the
 * same entrainment closure and the same governing ODEs — the only
 * difference is a source term present within the primary source's own
 * footprint and absent beyond it. Given that, and given this module does
 * not track the blanket's own transient mass and enthalpy trajectory (only
 * its steady-state radius, above), the calculation is unified into one
 * downwind march starting at the edge of the (possibly widened) source,
 * with the contaminant's total mass flux held equal to the release rate at
 * every downwind station (ordinary conservation of the pollutant, not a
 * re-derivation of DEGADIS's own mixture bookkeeping). Temperature is not
 * tracked as a function of distance (the cloud is assumed to warm to
 * ambient quickly compared to how fast it dilutes), but the density
 * difference IS tracked as the cloud dilutes — see "WHY REDUCED GRAVITY IS
 * RECOMPUTED LOCALLY" below; an earlier version of this file froze it at
 * the source value for the whole march, which turned out not to be a merely
 * conservative simplification but a genuine bug (see that section).
 *
 * WHY REDUCED GRAVITY IS RECOMPUTED LOCALLY
 * ------------------------------------------
 * BUG FOUND AND FIXED (2026-09-28): comparing HAZEL's plotted threat-zone
 * outline against a real ALOHA run's exported footprint (chlorine,
 * Eindhoven, direct source, 10-minute release) shows ALOHA's shape rising
 * from the source to a maximum width roughly a third of the way out, then
 * narrowing smoothly back to a point — the "lightbulb" shape [TechDoc
 * Figure 4.4's own sketch of a dense-gas footprint shows the same profile].
 * HAZEL's plot instead widened without limit: an ever-flaring wedge whose
 * far edge was determined only by wherever the search happened to stop.
 *
 * The two entrainment rates that shape the footprint — dS_z/dx (vertical)
 * and dB_eff/dx (lateral), both above — both grow with the cloud's
 * buoyancy (the reduced gravity g_hat), and both are damped as the
 * Richardson number Ri* = g_hat*H_eff/U*^2 rises (dS_z/dx directly, through
 * phi(Ri*) in its denominator; dB_eff/dx indirectly, since it depends on
 * the same H_eff that phi's suppression of dS_z/dx keeps from running away
 * on its own). With g_hat frozen at the source's undiluted value, H_eff
 * keeps growing for as long as any vertical growth remains at all, which
 * makes Ri* climb without bound — the opposite of what should happen as a
 * real cloud entrains air and becomes less dense relative to its
 * surroundings. dB_eff/dx has no phi-style brake of its own, so it simply
 * kept growing with the ever-larger H_eff, producing the unbounded wedge.
 *
 * The fix: g_hat is recomputed at every downwind station from how diluted
 * the cloud already is there, not held at its source value. At fixed
 * temperature and pressure, an ideal-gas mixture's density is a linear,
 * mole-fraction-weighted blend of its components' pure densities, so the
 * local reduced gravity is just the source's own g_hat scaled by the
 * contaminant's local volume (mole) fraction — itself simply the local
 * centreline concentration (already computed for the mass-flux calculation
 * below) divided by the pure contaminant's density. As the cloud dilutes,
 * this fraction falls toward zero, g_hat(x) falls with it, both growth
 * rates decelerate together, and the width turns over and narrows instead
 * of flaring indefinitely — reproducing the measured lightbulb profile
 * rather than an unbounded wedge. See marchDownwind() below for the exact
 * calculation.
 *
 * The lateral MASS distribution used to compute the centreline concentration
 * cc(x) is still a "top hat" (uniform across an effective width, see
 * marchDownwind() below) — that is how the release rate is converted into a
 * concentration in the first place, via straightforward conservation of
 * mass, and does not depend on any equation this project could not verify.
 * How that same cc(x) is then distributed ACROSS y, for drawing a threat
 * zone or answering "what is the concentration at this point," is a
 * separate question, answered below (concentrationAtOffset(),
 * edgeAtThreshold()) with DEGADIS's own homogeneous-core-plus-Gaussian-tail
 * shape (Tech Doc section 4.4.4's c(x,y,z) piecewise definition) rather than
 * a second top-hat: the tail's spread S_y(x) turned out to be exactly the
 * ordinary Pasquill-Gifford sigma_y this project's Gaussian model already
 * computes (confirmed via [UsersGuide]'s own remark that the passive
 * far-field tail ties back to that standard correlation), so no unverified
 * formula was needed to add it.
 */

import { WIND_PROFILE_EXPONENTS } from "./engineConstants.js";
import { gasDensity, reducedGravity } from "./engineDispersionChoice.js";
import { sigmaY, sigmaX, obukhovLength, businger } from "./engineGaussian.js";
import { erf } from "./engineMath.js";

/**
 * Von Karman constant, as used throughout [UsersGuide]'s Chapter V
 * derivation (the wind-profile relations, the vertical growth-rate ODE,
 * and the Q*max closure below all share this same symbol and value): 0.35.
 *
 * CORRECTION (2026-09-22): this file previously used 0.4 here, noting only
 * that "Havens & Spicer [Vol.I] cite 0.35-0.40; DEGADIS and the rest of this
 * project use 0.4." [UsersGuide]'s own List of Symbols removes that
 * ambiguity for THIS specific derivation: "k — von Karman's constant, 0.35"
 * — stated once, used consistently across every equation in Chapter V that
 * carries the symbol k, including the entrainment-integral closure
 * (phi_c = 3.1, corresponding to Ri* = 20) that Q*max's derivation is
 * calibrated against. Using 0.4 here would quietly drift from the exact fit
 * those constants were derived for. (engineSourcePuddle.js's own, unrelated
 * use of a von Karman constant for a different heat/mass-transfer
 * correlation is untouched by this change.)
 */
const VON_KARMAN = 0.35;

/** Frontal spreading velocity coefficient, C_E = 1.15 [UsersGuide eq. V.1].
 *  Named but not given a value in [TechDoc]; this is where the number comes from. */
const FRONTAL_SPREADING_COEFFICIENT = 1.15;

/** Reference height for wind speed and the dispersion coefficients, 10 m. */
const REFERENCE_HEIGHT = 10;

/**
 * Empirical constant delta_L = 2.15 [UsersGuide eqs. V.53 and V.59],
 * relating the vertically-averaged layer height H_L to the effective cloud
 * depth H_eff (H_L = delta_L * H_eff), and appearing again in the Q*max
 * closure below.
 */
const DELTA_L = 2.15;

/**
 * Fixed value of the stability function, phi_c = 3.1, corresponding to a
 * Richardson number Ri* = 20 (the midpoint of the range 8 < Ri* < 32 that
 * Britter's (1980) water-tunnel data identifies as where lateral spreading
 * becomes significant) [UsersGuide, "Maximum Atmospheric Takeup Rate"].
 * Used only inside the Q*max closure below, as a fixed reference point for
 * evaluating how Ri* varies across the primary source's own footprint — NOT
 * the same as stabilityFunction(), which is evaluated at the ACTUAL,
 * varying Ri* along that footprint (see integratedInverseStabilityFunction()).
 */
const PHI_C_FOR_ENTRAINMENT_CLOSURE = 3.1;

/* ========================================================================
   GAMMA FUNCTION
   ======================================================================== */

/**
 * Gamma function, via the Lanczos approximation (g=7, 9-term series).
 * Accurate to about 15 significant digits — verified against the exact
 * values Gamma(1)=1, Gamma(2)=1, Gamma(3)=2, Gamma(0.5)=sqrt(pi) in
 * heavyGasTests.js.
 *
 * Needed because the effective height and velocity relations below involve
 * Gamma(1/(1+alpha)) for a non-integer argument, and JavaScript has no
 * built-in gamma function.
 */
const LANCZOS_COEFFICIENTS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
const LANCZOS_G = 7;

export function gammaFunction(z) {
  if (z < 0.5) {
    // Reflection formula, for arguments this module never actually needs
    // below 0.5 but which keeps the function correct in general.
    return Math.PI / (Math.sin(Math.PI * z) * gammaFunction(1 - z));
  }
  const zz = z - 1;
  let x = LANCZOS_COEFFICIENTS[0];
  for (let i = 1; i < 9; i++) x += LANCZOS_COEFFICIENTS[i] / (zz + i);
  const t = zz + LANCZOS_G + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, zz + 0.5) * Math.exp(-t) * x;
}

/* ========================================================================
   STABILITY FUNCTION AND RICHARDSON NUMBER
   ======================================================================== */

/**
 * The stability function phi(Ri*), which reduces vertical entrainment as
 * density stratification increases [TechDoc section 4.4.4.4; UsersGuide
 * eq. V.76, positive branch]. A curve fit to laboratory data from McQuaid
 * (1976), Kantha et al. (1977) and Lofquist (1960).
 *
 * Only the Ri* >= 0 branch is implemented. The negative branch in
 * [UsersGuide] applies when a temperature-corrected Richardson number goes
 * negative under unstable, heat-transfer-driven convection — out of scope
 * here since Stage 1 does not model ground heat transfer at all (see the
 * module docstring), so Ri* as computed in this file is never negative: it
 * is built from a density difference that is always positive for a gas
 * dense enough to have triggered this model in the first place.
 *
 * @param {number} richardsonStar - Ri*, dimensionless, >= 0
 * @returns {number} phi(Ri*), dimensionless
 */
export function stabilityFunction(richardsonStar) {
  const ri = Math.max(richardsonStar, 0);
  return 0.88 + 0.099 * Math.pow(ri, 1.04) + 1.4e-25 * Math.pow(ri, 5.7);
}

/**
 * The Richardson number governing vertical entrainment at a downwind
 * station, Ri* = ĝ * H_eff / U*^2 — the same form used to decide whether the
 * heavy gas model applies at all (engineDispersionChoice.js), evaluated
 * here with the LOCAL effective cloud height rather than the fixed
 * characteristic source height.
 */
export function richardsonStarAt(reducedG, effectiveHeightValue, uStar) {
  return (reducedG * effectiveHeightValue) / (uStar * uStar);
}

/* ========================================================================
   SECONDARY SOURCE BLANKET: MAXIMUM ATMOSPHERIC TAKEUP FLUX (Q*max)
   ======================================================================== */

/**
 * The entrainment-scaling coefficient "zeta" (varsigma) [UsersGuide eq.
 * V.62], used only to evaluate how the local Richardson number Ri*(x) varies
 * across the primary source's own footprint (0 to L) when computing Q*max.
 * This is a distinct, local approximation from the general Ri* used
 * elsewhere in the downwind march (richardsonStarAt()) — it exists purely
 * so the entrainment closure below can be evaluated without assuming the
 * cloud is already uniform across the source.
 *
 * zeta = ĝ * (z0/U*^2) * [Gamma(1/(1+a))/(1+a)] *
 *        { [k*U*(1+a)/phi_c] * [(1+a)/(U0*z0)] * [delta_L/(delta_L-1)] }^(1/(1+a))
 *
 * Units work out to m^(-1/(1+a)) — confirmed against [UsersGuide]'s own List
 * of Symbols entry for "zeta" (varsigma).
 */
function entrainmentScalingZeta({ reducedG, uStar, alpha, windSpeed10m }) {
  const z0 = REFERENCE_HEIGHT;
  const gammaTerm = gammaFunction(1 / (1 + alpha)) / (1 + alpha);
  const bracket =
    ((VON_KARMAN * uStar * (1 + alpha)) / PHI_C_FOR_ENTRAINMENT_CLOSURE) *
    ((1 + alpha) / (windSpeed10m * z0)) *
    (DELTA_L / (DELTA_L - 1));
  const bracketPowered = Math.pow(bracket, 1 / (1 + alpha));
  return reducedG * (z0 / (uStar * uStar)) * gammaTerm * bracketPowered;
}

/**
 * The reciprocal of the entrainment-averaged stability function, 1/phi_hat
 * [UsersGuide eq. V.60]:
 *
 *   1/phi_hat = (1/L) * integral from 0 to L of dx / phi(Ri*(x))
 *
 * where Ri*(x) = zeta * x^(1/(1+alpha)) [eq. V.61, with the upwind source
 * edge x_up taken as 0 — the natural choice here, since this integral is
 * evaluated across the primary source's own footprint, not the general
 * downwind march].
 *
 * [UsersGuide] notes this integral "can be solved analytically (Gradshteyn
 * and Ryzhik, 1980)" but does not print the closed form on the pages
 * available. Rather than guess at that closed form, this integrates the
 * SAME expression numerically (Simpson's rule) — mathematically equivalent
 * to any correct closed form, to well beyond the precision this model's
 * other approximations warrant, and requiring no unverified algebra.
 */
function integratedInverseStabilityFunction(zeta, alpha, sourceLength, segments = 60) {
  if (!(sourceLength > 0)) return 1 / stabilityFunction(0);

  const n = segments % 2 === 0 ? segments : segments + 1; // Simpson's rule needs an even count
  const h = sourceLength / n;
  const integrand = (x) => {
    const ri = zeta * Math.pow(Math.max(x, 0), 1 / (1 + alpha));
    return 1 / stabilityFunction(ri);
  };

  let sum = integrand(0) + integrand(sourceLength);
  for (let i = 1; i < n; i++) {
    sum += integrand(i * h) * (i % 2 === 0 ? 2 : 4);
  }
  const integral = (h / 3) * sum;
  return integral / sourceLength;
}

/**
 * The maximum atmospheric takeup flux, Q*max [UsersGuide eq. V.59] — the
 * largest rate (per unit area, kg/m^2/s) at which the atmosphere can take
 * contaminant up from a gas layer sitting over the primary source, before
 * a gravity-spreading secondary source blanket must form to handle the
 * excess.
 *
 *   Q*max = (c_c)_s * [k*U*(1+a)/phi_hat] * [delta_L/(delta_L-1)]
 *
 * where (c_c)_s is the contaminant concentration at the source. This
 * project's sources release essentially pure contaminant vapour (see
 * engineSourceTank.js, engineSourcePuddle.js) rather than a pre-diluted
 * mixture, so (c_c)_s is taken as the pure contaminant's own vapour density
 * at release conditions — the same cloudDensity already computed for the
 * Richardson-number screening and the downwind march below.
 *
 * @param {object} params
 * @param {number} params.sourceConcentration - (c_c)_s, kg/m^3
 * @param {number} params.reducedG - ĝ, m/s^2 (reducedGravity())
 * @param {number} params.uStar - friction velocity, m/s
 * @param {number} params.alpha - wind-profile power-law exponent for the stability class
 * @param {number} params.windSpeed10m - m/s at 10 m
 * @param {number} params.sourceLength - m, the primary source's own characteristic
 *        length (this project uses the source diameter, 2R, matching the
 *        same "equivalent fetch L=2R" convention [UsersGuide] uses to
 *        represent a circular source as a rectangle elsewhere in Chapter V)
 * @returns {number} Q*max, kg/m^2/s
 */
export function maximumAtmosphericTakeupFlux({
  sourceConcentration,
  reducedG,
  uStar,
  alpha,
  windSpeed10m,
  sourceLength,
}) {
  const zeta = entrainmentScalingZeta({ reducedG, uStar, alpha, windSpeed10m });
  const inversePhiHat = integratedInverseStabilityFunction(zeta, alpha, sourceLength);
  return sourceConcentration * VON_KARMAN * uStar * (1 + alpha) * inversePhiHat * (DELTA_L / (DELTA_L - 1));
}

/**
 * The secondary source blanket's steady-state radius — see the module
 * docstring's "SECONDARY SOURCE BLANKET" section for the derivation. Simply
 * E = Q*max * pi * R^2 solved for R, floored at the primary source's own
 * radius (a blanket cannot be smaller than the hole or puddle feeding it)
 * [UsersGuide: "the radius of the blanket [is] constrained to be greater
 * than or equal to the primary source radius R_p"].
 *
 * @param {object} params
 * @param {number} params.releaseRate - E, kg/s
 * @param {number} params.potentialTakeupFlux - Q*max, kg/m^2/s
 * @param {number} params.primarySourceRadius - R_p, m
 * @returns {number} m
 */
export function secondarySourceBlanketRadius({ releaseRate, potentialTakeupFlux, primarySourceRadius }) {
  if (!(potentialTakeupFlux > 0)) return primarySourceRadius;
  const steadyStateRadius = Math.sqrt(releaseRate / (Math.PI * potentialTakeupFlux));
  return Math.max(primarySourceRadius, steadyStateRadius);
}

/* ========================================================================
   FRICTION VELOCITY FOR THE DENSE-GAS MARCH
   ======================================================================== */

/**
 * Largest roughness length the heavy-gas model uses. [TechDoc section
 * 4.2.3]: "the Heavy Gas model uses a roughness length of 0.10 m for all
 * user-specified roughness lengths greater than 0.10 m."
 */
export const HEAVY_GAS_MAX_ROUGHNESS = 0.1;

// obukhovLength() and businger() — the Tech Doc 4.2.3 wind-profile pieces —
// moved to engineGaussian.js on 2026-10-01, where the Gaussian model now
// uses them too (gaussianTransportWindSpeed()). Re-exported here so existing
// imports keep working.
export { obukhovLength, businger };

/**
 * Friction velocity for the dense-gas march, from the stability-corrected
 * logarithmic wind profile [TechDoc section 4.2.3]:
 *
 *   U(z) = (U* / k) * [ ln((z + z0)/z0) - psi(z/L) ]
 *
 * solved for U* at the 10 m reference height.
 *
 * 2026-09-30: this replaces the neutral log law (engineDispersionChoice.js's
 * frictionVelocity(), no stability term) that the march used before for
 * every stability class. Under a stable atmosphere the neutral form
 * overstates U*, and with it the vertical entrainment and Q*max, which
 * showed up in comparisons against real ALOHA runs as dense-gas zones that
 * were consistently too SHORT under classes E and F. See
 * the 2026-09-30 ALOHA re-validation runs.
 *
 * k is this file's own VON_KARMAN (0.35), the value [UsersGuide] uses
 * throughout the Chapter V derivation that every other U*-dependent
 * equation here comes from, so the whole calculation uses one k.
 *
 * @param {number} windSpeed10m - m/s at 10 m
 * @param {number} roughnessLength - z0, m (capped at HEAVY_GAS_MAX_ROUGHNESS)
 * @param {string} stabilityClass - "A".."F"
 * @returns {number} U*, m/s
 */
export function heavyGasFrictionVelocity(windSpeed10m, roughnessLength, stabilityClass) {
  const z0 = Math.min(roughnessLength, HEAVY_GAS_MAX_ROUGHNESS);
  const L = obukhovLength(stabilityClass, z0);
  const zeta = Number.isFinite(L) ? REFERENCE_HEIGHT / L : 0;
  const profile = Math.log((REFERENCE_HEIGHT + z0) / z0) - businger(zeta);
  return (VON_KARMAN * windSpeed10m) / profile;
}

/* ========================================================================
   EFFECTIVE HEIGHT AND VELOCITY
   ======================================================================== */

/**
 * Effective cloud height, H_eff(x) = S_z(x)/(1+alpha) * Gamma(1/(1+alpha))
 * [TechDoc section 4.4.4.1]. This is the depth a cloud of uniform
 * concentration c_c would need to hold the same total contaminant per unit
 * area as the actual power-law vertical profile does.
 */
export function effectiveHeight(verticalDispersion, alpha) {
  return (verticalDispersion / (1 + alpha)) * gammaFunction(1 / (1 + alpha));
}

/**
 * Effective advection velocity, the concentration-weighted mean of the wind
 * speed through the depth of the cloud [TechDoc section 4.4.4.1]:
 *
 *   U_eff(x) = (S_z(x) / Z_R)^alpha * U_R / Gamma(1/(1+alpha))
 */
export function effectiveVelocity(verticalDispersion, referenceWindSpeed, alpha) {
  return (
    (Math.pow(verticalDispersion / REFERENCE_HEIGHT, alpha) * referenceWindSpeed) /
    gammaFunction(1 / (1 + alpha))
  );
}

/* ========================================================================
   DOWNWIND GROWTH RATES
   ======================================================================== */

/**
 * Rate of growth of the vertical dispersion parameter with downwind
 * distance, dS_z/dx.
 *
 * Derived by differentiating the similarity relation given directly in
 * [TechDoc, section 4.4.4.4] (equivalently [UsersGuide] eq. V.77):
 *
 *   d/dx [ (U_R Z_R)/(1+n) * (S_z(x)/Z_R)^(1+n) ] = k U* (1+n) / phi(Ri*')
 *
 * Differentiating the left side with respect to S_z and solving for dS_z/dx:
 *
 *   dS_z/dx = [k U* (1+n) / phi(Ri*')] / [U_R (S_z/Z_R)^n]
 */
export function verticalGrowthRate({ verticalDispersion, uStar, referenceWindSpeed, alpha, phi }) {
  const numerator = VON_KARMAN * uStar * (1 + alpha);
  const denominator = referenceWindSpeed * Math.pow(verticalDispersion / REFERENCE_HEIGHT, alpha);
  return numerator / (phi * denominator);
}

/**
 * Rate of growth of the plume's effective half-width with downwind
 * distance, dB_eff/dx — the gravity-driven lateral spreading term
 * [TechDoc section 4.4.4.1; UsersGuide eq. V.8 / V.28-derived], expressed as
 * a Froude number relation:
 *
 *   dB_eff/dx = C_E * Gamma(1/(1+n)) * (Z_R/S_z(x))^n * [ĝ H_eff(x) / U_R^2]^(1/2)
 */
export function lateralGrowthRate({ verticalDispersion, effHeight, reducedG, referenceWindSpeed, alpha }) {
  const gammaTerm = gammaFunction(1 / (1 + alpha));
  const roughnessTerm = Math.pow(REFERENCE_HEIGHT / verticalDispersion, alpha);
  const froudeTerm = Math.sqrt((reducedG * effHeight) / (referenceWindSpeed * referenceWindSpeed));
  return FRONTAL_SPREADING_COEFFICIENT * gammaTerm * roughnessTerm * froudeTerm;
}

/* ========================================================================
   CROSSWIND PROFILE: HOMOGENEOUS CORE + GAUSSIAN TAIL
   ======================================================================== */

/**
 * Lateral (crosswind) spread of the passive tail beyond the homogeneous
 * core, S_y(x).
 *
 * The tail has the shape exp(-((|y| - b)/S_y)^2) [TechDoc section 4.4.4].
 * For that shape to be the same Gaussian as the ordinary passive model's
 * exp(-y^2 / (2 sigma_y^2)) once the core has shrunk to nothing, S_y must be
 * sqrt(2) * sigma_y — reusing the SAME Briggs sigma_y this project's
 * Gaussian model already computes (engineGaussian.js).
 *
 * CORRECTION (2026-09-30): this previously returned sqrt(pi) * sigma_y. The
 * sqrt(pi) belongs to the effective-width DEFINITION
 * B_eff = b + (sqrt(pi)/2) * S_y (the integral of the tail), not to S_y
 * itself; carrying it into S_y made the passive tail about 25% wider than
 * the Gaussian it is meant to become, i.e. it did not actually hand over to
 * the passive profile the Tech Doc describes.
 */
export function lateralSpread(x, stabilityClass) {
  return Math.SQRT2 * sigmaY(x, stabilityClass);
}

/**
 * Half-width of the homogeneous (uniform-concentration) core, b(x).
 *
 * Derived algebraically from the effective half-width B_eff(x) — already
 * tracked by marchDownwind() below via its own growth equation — and the
 * passive tail's spread S_y(x):
 *
 *     b(x) = B_eff(x) - (sqrt(pi)/2) * S_y(x)
 *
 * which is simply the definition B_eff = b + (sqrt(pi)/2)*S_y, solved for
 * b. As the cloud dilutes, S_y(x) grows faster than B_eff(x) does, and at
 * some downwind distance this would go negative — physically, the point
 * where the gravity-dominated core has fully dissolved into passive
 * turbulent mixing. Clamped to zero there: beyond that point the profile
 * below collapses to an ordinary Gaussian, exactly matching how the
 * ordinary (passive) dispersion model already behaves.
 */
export function coreHalfWidth(effectiveHalfWidth, sy) {
  return Math.max(0, effectiveHalfWidth - (Math.sqrt(Math.PI) / 2) * sy);
}

/**
 * Ground-level concentration at a crosswind offset y, given the centreline
 * (y=0) concentration at this downwind station.
 *
 * Replaces the plain top-hat this module started with (uniform inside
 * B_eff, zero outside) with the actual two-part DEGADIS profile: uniform
 * across the homogeneous core |y|<=b(x), then a Gaussian-shaped tail
 * beyond it. The core's own uniform value already came from conservation
 * of mass (see marchDownwind()); this only reshapes how that mass is
 * distributed across y, not the total amount of it.
 *
 * @param {number} centrelineConcentration - kg/m^3, at this x
 * @param {number} y - crosswind offset, m
 * @param {number} effectiveHalfWidth - B_eff(x), m
 * @param {number} x - downwind distance, m
 * @param {string} stabilityClass - "A".."F"
 * @returns {number} kg/m^3
 */
export function concentrationAtOffset(centrelineConcentration, y, effectiveHalfWidth, x, stabilityClass) {
  const sy = lateralSpread(x, stabilityClass);
  const b = coreHalfWidth(effectiveHalfWidth, sy);
  const absY = Math.abs(y);

  if (absY <= b) return centrelineConcentration;
  if (sy <= 0) return 0; // no tail to extend into, and already outside the (zero-width) core
  return centrelineConcentration * Math.exp(-Math.pow((absY - b) / sy, 2));
}

/**
 * Inverts concentrationAtOffset() for y: the crosswind distance at which
 * concentration falls to a given threshold, at a station whose centreline
 * concentration is known to be at or above that threshold.
 *
 * This is what removes the "flat wall" the plain top-hat model had at the
 * far tip of a threat zone: as the centreline concentration approaches the
 * threshold from above, the returned edge shrinks smoothly toward b(x)
 * (which is itself shrinking toward zero as the core dissolves), rather
 * than staying pinned at the full B_eff right up until the threshold is
 * crossed and then dropping to nothing.
 *
 * @returns {number|null} m, or null if centrelineConcentration is already below the threshold
 */
export function edgeAtThreshold(centrelineConcentration, effectiveHalfWidth, x, stabilityClass, thresholdConcentration) {
  if (centrelineConcentration < thresholdConcentration) return null;

  const sy = lateralSpread(x, stabilityClass);
  const b = coreHalfWidth(effectiveHalfWidth, sy);

  if (centrelineConcentration <= thresholdConcentration || sy <= 0) return b;
  return b + sy * Math.sqrt(Math.log(centrelineConcentration / thresholdConcentration));
}

/* ========================================================================
   FINITE-DURATION CORRECTION
   ======================================================================== */

/**
 * Finite-duration correction for the heavy-gas plume — see the module
 * docstring's "FINITE-DURATION CORRECTION" section for the full derivation
 * and why this is the ALOHA-authentic fix rather than a new approximation.
 *
 * In short: [TechDoc section 4.4] describes ALOHA-DEGADIS building a
 * time-varying heavy-gas cloud by smearing a steady-state plume's along-wind
 * edges with the same Beals (1971) sigma_x correlation used by the passive
 * Gaussian model. Because this project holds every release at one constant
 * rate for one duration (rather than ALOHA's up to five time-stepped
 * sources), that construction collapses into exactly the same closed-form
 * Palazzi et al. (1982) expression engineGaussian.js's peakConcentration()
 * already implements — reused here in its corrected form (see the FIX note
 * below), as a standalone multiplier on the centreline concentration
 * marchDownwind() already computes, rather than duplicated.
 *
 * FIX (2026-09-27), mirroring the same fix in engineGaussian.js's
 * peakConcentration(): this originally evaluated the Palazzi (1982)
 * leading/trailing-edge expression at a FIXED time (the instant the source
 * shuts off), which is only the moment of peak concentration at x = 0. Past
 * that point the cloud keeps advecting downwind, so the real peak at a
 * station further out happens later — solving for the maximizing time at
 * fixed x collapses the two-erf expression to the single term used below.
 * See engineGaussian.js's peakConcentration() docstring for the full
 * derivation; it applies unchanged here since both files smear the same kind
 * of steady-state plume with the same ambient-wind sigma_x correlation.
 *
 * Found the same way as the Gaussian-model fix: comparing HAZEL's heavy-gas
 * output against a real ALOHA run (chlorine, Eindhoven, 2026-09-27), whose
 * AEGL-1/AEGL-2 threat distances ran past 6 miles while HAZEL's old duration
 * factor had already collapsed to numerically zero by about 4-5 km — for a
 * 10-minute, 5 m/s release, U*t_r is only 3 km, and the previous formula
 * effectively treated the cloud as frozen in place once the source shut off,
 * instead of continuing to advect downwind at full strength until sigma_x(x)
 * grew large enough (compared to the release length) to actually dilute it.
 *
 *   durationFactor(x) = erf( (U * t_r) / (2 * sigmaX(x) * sqrt2) )
 *
 * The wind speed used is windSpeed10m, the same ambient transport wind
 * peakConcentration() itself uses (see findThreatZone() in
 * engineGaussian.js) — not this file's own locally-varying effective
 * velocity — because sigma_x is an ambient-wind correlation (Beals 1971),
 * not a dense-gas-specific one.
 *
 * @param {number} x - downwind distance, m
 * @param {number} windSpeed10m - m/s at 10 m
 * @param {number|undefined} releaseDuration - seconds; a missing or
 *        non-positive value is treated as a continuous release (factor 1),
 *        which is exactly this file's behaviour before 2026-09-26 and keeps
 *        any caller that does not yet supply a duration working unchanged.
 * @param {string} stabilityClass - "A".."F"
 * @returns {number} dimensionless factor in [0, 1]
 */
export function finiteDurationFactor(x, windSpeed10m, releaseDuration, stabilityClass) {
  if (x <= 0) return 0;
  if (!(releaseDuration > 0)) return 1;

  const sx = sigmaX(x, stabilityClass);
  if (sx <= 0) return 1;

  const releaseLength = windSpeed10m * releaseDuration;
  return erf(releaseLength / (2 * sx * Math.SQRT2));
}

/* ========================================================================
   DOWNWIND MARCH
   ======================================================================== */

/**
 * Marches the dense-gas plume downwind from the edge of the (possibly
 * blanket-widened) primary source, integrating S_z and B_eff together and
 * computing the centreline ground-level concentration at each station from
 * conservation of the contaminant's mass flux (see the module docstring for
 * why this replaces DEGADIS's own mixture density bookkeeping in this
 * version), then applying the finite-duration correction (see above) so a
 * release that has not run long enough to establish a fully continuous
 * plume out to a given distance reports a correspondingly lower
 * concentration there.
 *
 * SECONDARY SOURCE BLANKET (2026-09-22): before marching, this now checks
 * whether the release rate over the primary source's own footprint exceeds
 * Q*max (maximumAtmosphericTakeupFlux()). If it does, a gas blanket forms
 * and spreads under gravity to a wider, steady-state footprint
 * (secondarySourceBlanketRadius()) before wind-driven dispersion takes
 * over — see the module docstring's "SECONDARY SOURCE BLANKET" section.
 * The march then starts from THAT footprint's edge rather than the bare
 * physical source dimension, with the characteristic height recomputed for
 * the widened area (the same mass flux spread over more area makes a
 * shallower starting layer — the concrete, physical effect the blanket
 * represents).
 *
 * A circular footprint of radius R (primary source or blanket, whichever
 * applies) is represented as an equivalent rectangle for the downwind
 * model, per [UsersGuide]'s own convention ("The circular source cloud is
 * represented as an equivalent area rectangle (pi*R^2 = 2*b*L) with
 * equivalent fetch (L = 2R)"), giving b = pi*R/4. This project's march
 * previously seeded its starting half-width directly from the raw source
 * radius, skipping this conversion; applying it now, uniformly (whether or
 * not a blanket forms), removes both that inconsistency with [UsersGuide]
 * and a discontinuity that would otherwise appear right at the
 * blanket-formation threshold.
 *
 * @param {object} params
 * @param {number} params.releaseRate - kg/s, held constant (see module docstring)
 * @param {number} [params.releaseDuration] - seconds; see finiteDurationFactor()
 *        above. Omitted (or non-positive) reproduces this file's original
 *        continuous-release behaviour exactly.
 * @param {number} params.molecularWeight - g/mol
 * @param {number} params.temperature - K
 * @param {number} [params.sourceTemperature] - K, temperature of the gas as
 *   it enters the air (an expanded compressed gas); defaults to temperature
 * @param {number} params.windSpeed10m - m/s at 10 m
 * @param {number} params.roughnessLength - m
 * @param {string} params.stabilityClass - "A".."F"
 * @param {number} params.sourceHalfWidth - m, the primary source's own radius
 *        (despite the name: callers pass sourceDiameter/2 — see
 *        stepResults.js — i.e. this IS the primary source radius R_p, not
 *        an already-converted rectangle half-width)
 * @param {number} params.characteristicHeight - m, H from engineDispersionChoice.js,
 *        used as the starting seed UNLESS a blanket forms, in which case it
 *        is recomputed for the widened footprint (see above)
 * @param {number} [params.maxDistance] - m, integration ceiling
 * @param {number} [params.stepCount] - number of downwind stations to record
 * @returns {Array<{x: number, concentrationKgM3: number, halfWidth: number, effHeight: number, ri: number}>}
 */
export function marchDownwind({
  releaseRate,
  releaseDuration,
  molecularWeight,
  temperature,
  windSpeed10m,
  roughnessLength,
  stabilityClass,
  sourceHalfWidth,
  characteristicHeight,
  releaseSteps,
  sourceTemperature,
  maxDistance = 20000,
  stepCount = 400,
}) {
  // A release whose rate changes over time (puddle, tank) arrives as up to
  // five steady steps — see compositeMarch() below. A single step, or none,
  // is the constant-rate case this function has always handled directly.
  if (Array.isArray(releaseSteps) && releaseSteps.length > 1) {
    return compositeMarch({
      releaseRate, releaseDuration, molecularWeight, temperature, windSpeed10m,
      roughnessLength, stabilityClass, sourceHalfWidth, characteristicHeight,
      releaseSteps, sourceTemperature, maxDistance, stepCount,
    });
  }

  const alpha = WIND_PROFILE_EXPONENTS[stabilityClass];
  // Stability-corrected friction velocity — see heavyGasFrictionVelocity().
  const uStar = heavyGasFrictionVelocity(windSpeed10m, roughnessLength, stabilityClass);

  const airDensity = gasDensity(28.96, temperature);
  // COLD SOURCE (2026-10-02): a compressed gas cools as it expands to
  // atmospheric pressure (Tech Doc 3.4.6), so it leaves the hole denser
  // than its molecular weight alone would make it — carbon monoxide from
  // 20 atm at 15 C comes out at about 122 K, 2.3 times the density of air.
  // The source density is taken at that temperature. Downwind, the cloud's
  // density excess is scaled by the contaminant's volume fraction, as
  // before: mixing a cold gas into air dilutes its temperature deficit in
  // the same proportion as its molecular-weight excess (for comparable
  // molar heat capacities), so the same scaling covers both.
  const cloudTemperature =
    Number.isFinite(sourceTemperature) && sourceTemperature > 0 ? sourceTemperature : temperature;
  const cloudDensity = gasDensity(molecularWeight, cloudTemperature);
  const reducedG = reducedGravity(cloudDensity, airDensity);

  // --- Secondary source blanket: does one form, and if so, how wide? -----
  const primarySourceRadius = Math.max(sourceHalfWidth, 0.01);
  const potentialTakeupFlux = maximumAtmosphericTakeupFlux({
    sourceConcentration: cloudDensity,
    reducedG,
    uStar,
    alpha,
    windSpeed10m,
    sourceLength: 2 * primarySourceRadius, // equivalent fetch L = 2R, see docstring
  });
  const releaseRatePerArea = releaseRate / (Math.PI * primarySourceRadius * primarySourceRadius);
  const blanketForms = releaseRatePerArea > potentialTakeupFlux;
  const effectiveRadius = blanketForms
    ? secondarySourceBlanketRadius({ releaseRate, potentialTakeupFlux, primarySourceRadius })
    : primarySourceRadius;

  // Same mass flux, spread over the (possibly wider) blanket footprint
  // instead of the bare physical hole or puddle: a shallower starting
  // layer. Reuses the puddle-style relation because once a gravity-spread
  // blanket has formed, the source behaves like a puddle of that effective
  // diameter regardless of the original source type.
  const effectiveCharacteristicHeight = blanketForms
    ? releaseRate / (cloudDensity * windSpeed10m * (2 * effectiveRadius))
    : characteristicHeight;

  // Equivalent-rectangle half-width, pi*R/4 — see the docstring above for
  // why this is applied uniformly rather than only when a blanket forms.
  const effectiveHalfWidth = (Math.PI * effectiveRadius) / 4;

  // Starting station: the downwind edge of the (possibly widened) source.
  const x0 = Math.max(effectiveRadius, 0.1);
  let verticalDispersion = (effectiveCharacteristicHeight * (1 + alpha)) / gammaFunction(1 / (1 + alpha));
  let halfWidth = effectiveHalfWidth;

  const dx = (maxDistance - x0) / stepCount;
  const series = [];

  // Local state of the cloud at distance x, and the growth rates there.
  // Factored out so the growth equations can be integrated in sub-steps
  // between the output stations (see INTEGRATION STEP below).
  const stateAt = (x, verticalDispersionHere, halfWidthHere) => {
    const effHeight = effectiveHeight(verticalDispersionHere, alpha);
    const effVelocity = effectiveVelocity(verticalDispersionHere, windSpeed10m, alpha);
    // Width carrying the mass flux (2026-09-30): see the module notes —
    // max(2 B_eff, sqrt(pi) S_y), the integral of the crosswind profile.
    const sy = lateralSpread(x, stabilityClass);
    const massWidth = Math.max(2 * halfWidthHere, Math.sqrt(Math.PI) * sy);
    const crossSectionFlow = effVelocity * massWidth * effHeight;
    const continuousConcentration = crossSectionFlow > 0 ? releaseRate / crossSectionFlow : 0;
    // LOCAL reduced gravity (2026-09-28): source buoyancy scaled by the
    // contaminant's volume fraction at this station.
    const dilutionFraction = Math.min(1, Math.max(0, continuousConcentration / cloudDensity));
    const localReducedG = dilutionFraction * reducedG;
    const ri = richardsonStarAt(localReducedG, effHeight, uStar);
    const phi = stabilityFunction(ri);
    const dSzdx = verticalGrowthRate({
      verticalDispersion: verticalDispersionHere, uStar, referenceWindSpeed: windSpeed10m, alpha, phi,
    });
    const dBdx = lateralGrowthRate({
      verticalDispersion: verticalDispersionHere, effHeight, reducedG: localReducedG,
      referenceWindSpeed: windSpeed10m, alpha,
    });
    return { effHeight, continuousConcentration, ri, dSzdx, dBdx };
  };

  for (let i = 0; i <= stepCount; i++) {
    const x = x0 + i * dx;
    const here = stateAt(x, verticalDispersion, halfWidth);
    const durationFactor = finiteDurationFactor(x, windSpeed10m, releaseDuration, stabilityClass);
    series.push({
      x,
      concentrationKgM3: here.continuousConcentration * durationFactor,
      halfWidth,
      effHeight: here.effHeight,
      ri: here.ri,
    });

    // INTEGRATION STEP (2026-10-01): the growth equations are integrated
    // from this station to the next in sub-steps no longer than 2% of the
    // distance travelled (and never shorter than 1 cm), instead of one
    // explicit step of the full station spacing. Close to the source the
    // cloud grows fastest, and a single step of tens of metres there
    // overshot its growth badly — the computed concentration a few tens of
    // metres out depended on how far the march happened to extend. The
    // threat-zone search then trusted that wrong coarse value and cut short
    // the zones of small sources (found in ALOHA comparisons G1-G6: zones
    // under ~100 m came out 40-60% short, one even stuck at the first
    // coarse station).
    if (i < stepCount) {
      let xs = x;
      const xEnd = x + dx;
      let state = here;
      while (xs < xEnd - 1e-12) {
        const h = Math.min(xEnd - xs, Math.max(0.01, 0.02 * xs));
        // Midpoint (second-order) step: rates evaluated half way along.
        const vMid = verticalDispersion + 0.5 * h * state.dSzdx;
        const bMid = halfWidth + 0.5 * h * state.dBdx;
        const mid = stateAt(xs + 0.5 * h, vMid, bMid);
        verticalDispersion += h * mid.dSzdx;
        halfWidth += h * mid.dBdx;
        xs += h;
        if (xs < xEnd - 1e-12) state = stateAt(xs, verticalDispersion, halfWidth);
      }
    }
  }

  return series;
}


/* ========================================================================
   TIME-VARYING RELEASES: SUPERPOSED STEADY STEPS
   ======================================================================== */

/**
 * Along-wind pulse weight for one steady release step, at downwind distance
 * x and time t: the fraction of that step's steady-state concentration
 * present there at that moment, after Palazzi et al. (1982) with the Beals
 * (1971) sigma_x — the same construction finiteDurationFactor() uses, but
 * kept as a function of time so several steps can be added together before
 * the peak is taken.
 *
 *   w(x, t) = 1/2 [ erf((U(t - t0) - x) / (sqrt2 sigma_x))
 *                 - erf((U(t - t0 - dt) - x) / (sqrt2 sigma_x)) ]
 *
 * For a single step its maximum over t is exactly finiteDurationFactor().
 */
export function stepPulseWeight(x, t, step, windSpeed10m, sigmaXTimesSqrt2) {
  const front = windSpeed10m * (t - step.startTime) - x;
  const back = windSpeed10m * (t - step.startTime - step.duration) - x;
  return 0.5 * (erf(front / sigmaXTimesSqrt2) - erf(back / sigmaXTimesSqrt2));
}

/**
 * Downwind march for a release whose rate varies over time, represented as
 * up to five steady steps (2026-09-30).
 *
 * [TechDoc section 3.1]: ALOHA "approximates continuously variable releases
 * with a series of very short steady-state releases ... reduced to five or
 * fewer steady-state timesteps which are linked to the dispersion models".
 * [TechDoc section 4.4]: "The Heavy Gas model generates infinite-duration
 * steady-state plumes for each of these sources. A composite time-varying
 * cloud is created by adding together pieces of the five steady-state
 * plumes ... converted into a Gaussian in the downwind direction ... The
 * Gaussian dispersion parameter used, sigma_x, is the same as that used in
 * the Gaussian dispersion model (Beals 1971)." [TechDoc 4.5.1]: the threat
 * zone uses the maximum over all time of the concentration at each point.
 *
 * That is what this does: one steady plume per step (marchDownwind() with
 * that step's own rate), each weighted by its own time window
 * (stepPulseWeight()), summed, and the maximum over time taken at every
 * downwind station.
 *
 * Why it matters: holding a declining source at its PEAK rate for its whole
 * duration (this project's approach before 2026-09-30) made a boiling
 * chlorine puddle's zones 2-3 times too long against real ALOHA runs. With
 * the steps, the same comparison comes out within about 15%.
 *
 * The crosswind half-width and effective height reported at each station
 * are those of the step contributing most to the peak there, so the drawn
 * profile (concentrationAtOffset()) follows the part of the cloud that sets
 * the zone.
 *
 * @param {object} scenario - marchDownwind()'s fields, with releaseSteps an
 *        array of { startTime, duration, rate, characteristicHeight } (s, s,
 *        kg/s, m)
 * @returns {Array<{x, concentrationKgM3, halfWidth, effHeight, ri}>}
 */
export function compositeMarch(scenario) {
  const { releaseSteps, windSpeed10m, stabilityClass, maxDistance = 20000, stepCount = 400 } = scenario;

  const steadyOf = (step) =>
    marchDownwind({
      ...scenario,
      releaseSteps: undefined,
      releaseDuration: undefined, // steady plume; the time windows are applied below
      releaseRate: step.rate,
      characteristicHeight: step.characteristicHeight ?? scenario.characteristicHeight,
      maxDistance,
      stepCount,
    });

  // The step with the highest rate supplies the station grid (ALOHA also
  // centres its peak search on that step, TechDoc 4.5.1).
  let lead = 0;
  releaseSteps.forEach((st, k) => { if (st.rate > releaseSteps[lead].rate) lead = k; });
  const plumes = releaseSteps.map((st) => (st.rate > 0 ? steadyOf(st) : null));
  const grid = plumes[lead];

  const valueAt = (series, x) => {
    if (!series) return null;
    if (x < series[0].x) return series[0];
    for (let i = 1; i < series.length; i++) {
      if (series[i].x >= x) {
        const a = series[i - 1], b = series[i];
        const f = (x - a.x) / (b.x - a.x || 1);
        return {
          concentrationKgM3: a.concentrationKgM3 + f * (b.concentrationKgM3 - a.concentrationKgM3),
          halfWidth: a.halfWidth + f * (b.halfWidth - a.halfWidth),
          effHeight: a.effHeight + f * (b.effHeight - a.effHeight),
          ri: a.ri + f * (b.ri - a.ri),
        };
      }
    }
    return null; // beyond this step's own march
  };

  const totalEnd = Math.max(...releaseSteps.map((st) => st.startTime + st.duration));

  return grid.map((station) => {
    const x = station.x;
    const local = plumes.map((series) => valueAt(series, x));
    const sx = sigmaX(x, stabilityClass) * Math.SQRT2;

    const total = (t) => {
      let c = 0;
      releaseSteps.forEach((st, k) => {
        if (local[k]) c += local[k].concentrationKgM3 * stepPulseWeight(x, t, st, windSpeed10m, sx);
      });
      return c;
    };

    // Coarse scan across every time the cloud can be over this station,
    // then a golden-section refinement around the best sample.
    const tStart = Math.max(0, (x - 4 * sx) / windSpeed10m);
    const tEnd = (x + 4 * sx) / windSpeed10m + totalEnd;
    const samples = 240;
    const h = (tEnd - tStart) / samples;
    let bestT = tStart;
    let best = -1;
    for (let i = 0; i <= samples; i++) {
      const t = tStart + i * h;
      const c = total(t);
      if (c > best) { best = c; bestT = t; }
    }
    let lo = Math.max(tStart, bestT - h), hi = Math.min(tEnd, bestT + h);
    const g = (Math.sqrt(5) - 1) / 2;
    for (let i = 0; i < 30; i++) {
      const m1 = hi - g * (hi - lo), m2 = lo + g * (hi - lo);
      if (total(m1) >= total(m2)) hi = m2; else lo = m1;
    }
    const tPeak = (lo + hi) / 2;
    const peak = Math.max(best, total(tPeak));

    // Which step carries most of the peak — its plume shape is reported.
    let dominant = lead;
    let dominantShare = -1;
    releaseSteps.forEach((st, k) => {
      if (!local[k]) return;
      const share = local[k].concentrationKgM3 * stepPulseWeight(x, tPeak, st, windSpeed10m, sx);
      if (share > dominantShare) { dominantShare = share; dominant = k; }
    });
    const shape = local[dominant] ?? station;

    return {
      x,
      concentrationKgM3: peak,
      halfWidth: shape.halfWidth,
      effHeight: shape.effHeight,
      ri: shape.ri,
    };
  });
}


/**
 * Reduces a source model's time series (engineSourcePuddle.js,
 * engineSourceTank.js — one sample per minute) to at most five steady
 * release steps for compositeMarch(), conserving the mass released in each.
 *
 * [TechDoc section 3.1]: up to 150 source time steps "are reduced to five
 * or fewer steady-state timesteps which are linked to the dispersion
 * models"; the shortest step ALOHA uses is one minute, and the rate it
 * reports as the "maximum average sustained release rate" is the highest
 * such average (never a one-second spike). The split used here: the first
 * minute on its own (so that highest sustained rate is represented exactly),
 * then the rest of the release in four equal parts, boundaries on whole
 * minutes. Comparisons against real ALOHA runs were insensitive to the
 * exact split (five equal steps, or 150 short ones, gave the same zones to
 * within about 10%).
 *
 * @param {object} params
 * @param {Array<{t:number, remaining?:number, remainingMass?:number}>} params.series
 * @param {number} params.initialMass - kg at t = 0
 * @param {number} params.totalMass - kg released by the end
 * @param {number} params.durationSeconds - s
 * @param {(rate:number) => number} [params.heightOf] - characteristic height for a
 *        given rate (differs between puddle and jet sources); omitted leaves it unset
 * @returns {Array<{startTime:number, duration:number, rate:number, characteristicHeight?:number}>}
 */
export function releaseStepsFromSeries({ series, initialMass, totalMass, durationSeconds, heightOf }) {
  const D = Math.min(durationSeconds, 3600);
  const withHeight = (step) =>
    heightOf && step.rate > 0 ? { ...step, characteristicHeight: heightOf(step.rate) } : step;

  if (!(D > 0) || !Array.isArray(series) || series.length < 3 || D <= 120) {
    return [withHeight({ startTime: 0, duration: D, rate: D > 0 ? totalMass / D : 0 })];
  }

  const remainingAt = (p) => (p.remaining ?? p.remainingMass);
  const cumulative = (t) => {
    if (t <= 0) return 0;
    if (t >= D) return totalMass;
    const point = series.find((p) => p.t === t);
    return point ? Math.min(totalMass, initialMass - remainingAt(point)) : null;
  };

  const minuteMarks = series.map((p) => p.t).filter((t) => t > 60 && t < D);
  const bounds = [0, 60];
  for (let k = 1; k <= 3; k++) {
    const target = 60 + (k * (D - 60)) / 4;
    const snapped = minuteMarks.reduce((best, t) => (Math.abs(t - target) < Math.abs(best - target) ? t : best), minuteMarks[0]);
    if (snapped > bounds[bounds.length - 1]) bounds.push(snapped);
  }
  bounds.push(D);

  const steps = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i], b = bounds[i + 1];
    const ma = cumulative(a), mb = cumulative(b);
    if (ma === null || mb === null || !(b > a)) {
      return [withHeight({ startTime: 0, duration: D, rate: totalMass / D })];
    }
    steps.push(withHeight({ startTime: a, duration: b - a, rate: Math.max(0, (mb - ma) / (b - a)) }));
  }
  return steps;
}

/**
 * Runs an additional, finely-resolved march sized specifically around
 * windSpeed10m * releaseDuration — the distance scale finiteDurationFactor()'s
 * own leading/trailing-edge transition is centred on (see
 * findHeavyGasThreatZone()'s "FINITE-DURATION CLIFF" docstring for the full
 * explanation of why a fixed-spacing coarse pass across the whole default
 * search range can step clean over this transition for a brief release).
 *
 * Factored out of findHeavyGasThreatZone() so every caller that walks a
 * marchDownwind() series looking for where it crosses some threshold — not
 * just the toxic threat-zone search, but also engineFlammableMass.js's
 * heavyGasFlammableMass(), which independently walks the same kind of series
 * for the LEL/UEL band feeding VCE overpressure — shares one implementation
 * of the fix rather than each carrying its own, independently-vulnerable
 * copy. (heavyGasFlammableMass() is exactly how this project discovered a
 * second bug of the identical shape: the same cliff, undetected by the same
 * kind of fixed-spacing coarse pass, silently starving a VCE calculation of
 * flammable mass for a brief release — see
 * the 2026-09-26 duration review, finding #1.)
 *
 * @param {object} scenario - same fields as marchDownwind()
 * @returns {Array|null} the near-field series, or null when there is no
 *        usable duration/wind speed to size it from (a continuous or very
 *        long release skips this pass entirely, leaving the caller's own
 *        full-range coarse pass as the only one — exactly this file's
 *        original behaviour before the cliff was found)
 */
export function nearFieldMarch(scenario) {
  const { windSpeed10m, releaseDuration } = scenario;
  if (
    !(Number.isFinite(releaseDuration) && releaseDuration > 0 &&
      Number.isFinite(windSpeed10m) && windSpeed10m > 0)
  ) {
    return null;
  }
  const releaseLength = windSpeed10m * releaseDuration;
  // Same margin and floor as findHeavyGasThreatZone() originally used,
  // confirmed numerically there: the factor is already down to ~1e-4 within
  // about 1.3x releaseLength, and 50 m is a sane minimum near-field
  // resolution for a very brief or very slow-moving release.
  const nearFieldDistance = Math.min(Math.max(releaseLength * 3, 50), 20000);
  return marchDownwind({ ...scenario, maxDistance: nearFieldDistance, stepCount: 300 });
}

/**
 * Reports the top-hat plume's state at the downwind station nearest a given
 * distance — the piece "threat at a point" (stepResults.js) needs, since
 * that feature queries an arbitrary clicked location rather than one of the
 * fixed stations findHeavyGasThreatZone() already walked.
 *
 * Re-runs the full march rather than caching it: this is triggered by a map
 * click, an infrequent, human-paced interaction, not a hot path. Since this
 * simply forwards `scenario` to marchDownwind(), a releaseDuration on the
 * scenario object is honoured automatically — see marchDownwind() above.
 *
 * @param {object} scenario - same fields as marchDownwind()
 * @param {number} xTarget - downwind distance to query, m
 * @returns {{x: number, concentrationKgM3: number, halfWidth: number, effHeight: number, ri: number}}
 */
export function concentrationAtDistance(scenario, xTarget) {
  const series = marchDownwind(scenario);

  let nearest = series[0];
  let bestDiff = Math.abs(series[0].x - xTarget);
  for (const point of series) {
    const diff = Math.abs(point.x - xTarget);
    if (diff < bestDiff) {
      bestDiff = diff;
      nearest = point;
    }
  }
  return nearest;
}

/**
 * How far the fine (second) pass of a two-pass threshold search must run:
 * out to the first station either coarse pass sampled BEYOND the farthest
 * station found still above the threshold — i.e. a station already known
 * to be below it — so the real crossing is always bracketed.
 *
 * FIX (2026-09-30): the fine pass used to run to roughDistance * 1.15. When
 * a zone is short compared with the coarse pass's station spacing (about
 * 50 m across the default 20 km range) — a small or continuous release,
 * where no near-field pass runs — the only exceeding coarse station can be
 * the very first one, a metre or two from the source, and 1.15 times that
 * cut the fine pass off long before the real crossing. The zone (and, via
 * engineFlammableMass.js, the VCE flammable mass) then came out far too
 * small. This showed up as flammableMassTests.js section 9 reporting a
 * continuous release with LESS flammable mass than a 60 s release of the
 * same rate.
 *
 * Falls back to the old 15% margin only when no sampled station lies
 * beyond roughDistance (the search's own range was exhausted — the
 * separate, documented range-ceiling case).
 *
 * @param {Array<Array<{x:number}>|null>} seriesList - the coarse (and, if run, near-field) series
 * @param {number} roughDistance - farthest station found above threshold, m
 * @returns {number} m
 */
export function fineSearchCeiling(seriesList, roughDistance) {
  let next = Infinity;
  for (const series of seriesList) {
    if (!series) continue;
    for (const point of series) {
      if (point.x > roughDistance && point.x < next) next = point.x;
    }
  }
  return Number.isFinite(next) ? next : roughDistance * 1.15;
}

/**
 * Finds the heavy-gas threat zone: how far downwind the ground-level
 * concentration (see concentrationAtOffset() above) stays above a Level of
 * Concern, and the outline of the affected area.
 *
 * This runs marchDownwind() TWICE, not once. marchDownwind() integrates S_z
 * and B_eff cumulatively along x — each station's values depend on every
 * station before it — so unlike the other threat-distance searches in this
 * project (BLEVE, VCE, pool fire, jet fire), which can cheaply probe a
 * single distance at a time, there is no way to "zoom in" on a narrower
 * range without re-running the whole march from the start. A first, coarse
 * pass across the full default search range finds roughly where the
 * threshold is crossed; a second pass then re-runs the march sized
 * specifically to that distance, so the requested number of stations is
 * spent resolving the zone itself rather than mostly wasted on however much
 * of the original 20 km default search range the real zone did not reach.
 *
 * Without the two-pass approach, a real (short) zone sampled across the
 * full default range could end up represented by only two or three
 * stations — a real, reported symptom. And without the core/tail profile
 * (concentrationAtOffset(), edgeAtThreshold()) above, the crosswind edge at
 * each station would just be the raw, ever-growing B_eff, giving the whole
 * shape a flat-walled wedge silhouette instead of the smoothly narrowing
 * one the real physics — and this project's own ordinary Gaussian model —
 * both produce. Both were real, reported symptoms this function used to
 * have; both are addressed here.
 *
 * FINITE-DURATION CLIFF (2026-09-26, found while sanity-checking the
 * finite-duration correction against a second real report): a brief
 * release's finiteDurationFactor() does not just gently taper concentration
 * — for a release much shorter than the travel time to a given distance,
 * it falls from ~1 to ~0 within a span that can be much NARROWER than this
 * function's default coarse pass, whose stations are a fixed ~50 m apart
 * across the whole default 20 km range. That coarse pass could then step
 * clean over an entire real, substantial threat zone without a single
 * station landing inside it — reporting a wildly too-short distance not
 * because the physics says so, but because nothing was sampled where the
 * real answer was. This is a resolution artefact of the SEARCH, exactly
 * the same species of bug the two-pass approach itself was built to fix
 * above, not a new physical claim. The fix is the same kind: whenever a
 * finite releaseDuration is given, an additional near-field pass — sized
 * and resolved specifically around windSpeed10m * releaseDuration, the
 * distance scale finiteDurationFactor()'s own transition is centred on —
 * runs alongside the original full-range coarse pass, and the two are
 * combined before picking where the real zone roughly ends. A release
 * without a usable duration (or one long enough that this distance exceeds
 * the default range anyway) skips this extra pass entirely, so a
 * continuous or long release's behaviour is completely unchanged.
 *
 * @param {object} scenario - see marchDownwind() for the shared fields, plus:
 * @param {number} scenario.levelOfConcernPpm
 * @returns {{ thresholdExceeded: boolean, maxDownwindDistance: number, footprint: Array<{x:number,y:number}> }}
 */
export function findHeavyGasThreatZone(scenario) {
  const { molecularWeight, temperature, levelOfConcernPpm, stabilityClass, windSpeed10m, releaseDuration } = scenario;

  // Same ppm conversion used throughout the project (ideal gas law) — see
  // engineGaussian.js for the derivation and its own cross-check against
  // the NIOSH chlorine conversion factor.
  const R = 8.314462618;
  const toPpm = (kgM3) =>
    ((kgM3 * 1000) / molecularWeight / (101325 / (R * temperature))) * 1e6;
  const ppmToKgM3 = (ppm) =>
    ((ppm / 1e6) * molecularWeight * (101325 / (R * temperature))) / 1000;
  const thresholdKgM3 = ppmToKgM3(levelOfConcernPpm);

  // Pass 1a: a coarse march across the full default search range, purely to
  // locate roughly where the threshold is crossed.
  const coarseSeries = marchDownwind(scenario);
  let candidateExceeding = coarseSeries.filter((p) => toPpm(p.concentrationKgM3) >= levelOfConcernPpm);

  // Pass 1b: see "FINITE-DURATION CLIFF" above and nearFieldMarch()'s own
  // docstring. Only runs when there is a usable duration and wind speed to
  // size it from.
  const nearFieldSeries = nearFieldMarch(scenario);
  if (nearFieldSeries) {
    candidateExceeding = candidateExceeding.concat(
      nearFieldSeries.filter((p) => toPpm(p.concentrationKgM3) >= levelOfConcernPpm)
    );
  }

  if (candidateExceeding.length === 0) {
    return { thresholdExceeded: false, maxDownwindDistance: 0, footprint: [] };
  }

  // The two passes are concatenated, not necessarily in x order, so the
  // farthest exceeding station is found explicitly rather than assumed to
  // be the last array element.
  const roughDistance = Math.max(...candidateExceeding.map((p) => p.x));

  // Pass 2: re-run the march sized to the zone actually found, with enough
  // stations to resolve it smoothly — out to the first sampled station that
  // is already BELOW the threshold (see fineSearchCeiling()), so the true
  // crossing is always inside the fine pass.
  const fineSeries = marchDownwind({
    ...scenario,
    maxDistance: fineSearchCeiling([coarseSeries, nearFieldSeries], roughDistance),
    stepCount: 200,
  });
  const exceeding = fineSeries.filter((p) => toPpm(p.concentrationKgM3) >= levelOfConcernPpm);

  if (exceeding.length === 0) {
    // Should not happen given the margin above, but fall back to the
    // coarse estimate rather than reporting no zone at all if it does.
    return { thresholdExceeded: true, maxDownwindDistance: roughDistance, footprint: [] };
  }

  // Precise crossing distance via linear interpolation between the last
  // exceeding station and the first that no longer is — used only for
  // reporting maxDownwindDistance more accurately than the fine pass's own
  // station spacing would; the footprint's own taper comes from
  // edgeAtThreshold() below, not from this interpolation.
  const lastExceedingIndex = fineSeries.indexOf(exceeding[exceeding.length - 1]);
  const firstBelowThreshold = fineSeries[lastExceedingIndex + 1];

  let maxDownwindDistance = exceeding[exceeding.length - 1].x;
  if (firstBelowThreshold) {
    const ppmAtLastExceeding = toPpm(exceeding[exceeding.length - 1].concentrationKgM3);
    const ppmAtFirstBelow = toPpm(firstBelowThreshold.concentrationKgM3);
    const frac = (ppmAtLastExceeding - levelOfConcernPpm) / (ppmAtLastExceeding - ppmAtFirstBelow);
    maxDownwindDistance =
      exceeding[exceeding.length - 1].x + frac * (firstBelowThreshold.x - exceeding[exceeding.length - 1].x);
  }

  const upperEdge = exceeding.map((p) => ({
    x: p.x,
    y: edgeAtThreshold(p.concentrationKgM3, p.halfWidth, p.x, stabilityClass, thresholdKgM3),
  }));
  const lowerEdge = upperEdge.map((p) => ({ x: p.x, y: -p.y })).reverse();

  return {
    thresholdExceeded: true,
    maxDownwindDistance,
    footprint: [...upperEdge, ...lowerEdge],
  };
}
