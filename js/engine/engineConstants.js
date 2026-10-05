/**
 * engineConstants.js
 * ------------------
 * Empirical coefficients and physical constants used by the dispersion
 * engine. Every value here is traceable to a published source, cited inline.
 * Nothing in this file is a HAZEL invention.
 *
 * Primary reference:
 *   Jones, R., Lehr, W., Simecek-Beatty, D., Reynolds, R.M. (2013).
 *   ALOHA (Areal Locations of Hazardous Atmospheres) 5.4.4: Technical
 *   Documentation. NOAA Technical Memorandum NOS OR&R 43.
 *   Referred to below as "Tech Doc".
 *
 * Keeping these in one file means a reviewer can check the numbers against
 * the literature without reading any code.
 */

/** Pasquill-Gifford-Turner atmospheric stability classes, most to least unstable. */
export const STABILITY_CLASSES = ["A", "B", "C", "D", "E", "F"];

/**
 * Briggs (1973) dispersion parameter coefficients, as tabulated in Tech Doc
 * Table 13. They feed the formulas implemented in engineGaussian.js:
 *
 *   sigmaY(x) = sy1 * x * (1 + sy2 * x)^(-1/2)
 *   sigmaZ(x) = sz1 * x * (1 + sz2 * x)^(sz3)
 *   sigmaX(x) = sx1 * x^(sx2)                     [Beals 1971]
 *
 * Two notes carried over from the Tech Doc, both deliberate:
 *
 * 1. sigmaY uses the RURAL coefficients for every surface roughness. Briggs's
 *    rural and urban lateral coefficients were derived from data with
 *    different averaging times (3 minutes vs 1 hour); once corrected for that
 *    difference the curves are similar, so ALOHA uses the 3-minute rural set
 *    throughout. HAZEL follows the same choice for comparability.
 *
 * 2. The value sz2 = 0.0015 for rural class D is correct. Briggs (1973) and
 *    many later reprints contain a typo (0.00015); ALOHA uses 0.0015 and so
 *    does HAZEL.
 */
export const BRIGGS_COEFFICIENTS = {
  // Alongwind spread, all roughness classes (Tech Doc Table 13, "Both")
  alongwind: {
    A: { sx1: 0.02, sx2: 1.22 },
    B: { sx1: 0.02, sx2: 1.22 },
    C: { sx1: 0.02, sx2: 1.22 },
    D: { sx1: 0.04, sx2: 1.14 },
    E: { sx1: 0.17, sx2: 0.97 },
    F: { sx1: 0.17, sx2: 0.97 },
  },

  // Crosswind spread, all roughness classes (Tech Doc Table 13, "Both")
  crosswind: {
    A: { sy1: 0.22, sy2: 0.0001 },
    B: { sy1: 0.16, sy2: 0.0001 },
    C: { sy1: 0.11, sy2: 0.0001 },
    D: { sy1: 0.08, sy2: 0.0001 },
    E: { sy1: 0.06, sy2: 0.0001 },
    F: { sy1: 0.04, sy2: 0.0001 },
  },

  // Vertical spread, small surface roughness / "rural" (Tech Doc Table 13)
  verticalRural: {
    A: { sz1: 0.2, sz2: 0, sz3: 0 },
    B: { sz1: 0.12, sz2: 0, sz3: 0 },
    C: { sz1: 0.08, sz2: 0.0002, sz3: -0.5 },
    D: { sz1: 0.06, sz2: 0.0015, sz3: -0.5 },
    E: { sz1: 0.03, sz2: 0.0003, sz3: -1 },
    F: { sz1: 0.016, sz2: 0.0003, sz3: -1 },
  },

  // Vertical spread, large surface roughness / "urban" (Tech Doc Table 13)
  verticalUrban: {
    A: { sz1: 0.24, sz2: 0.001, sz3: 0.5 },
    B: { sz1: 0.24, sz2: 0.001, sz3: 0.5 },
    C: { sz1: 0.2, sz2: 0, sz3: 0 },
    D: { sz1: 0.14, sz2: 0.0003, sz3: -0.5 },
    E: { sz1: 0.08, sz2: 0.0015, sz3: -0.5 },
    F: { sz1: 0.08, sz2: 0.0015, sz3: -0.5 },
  },
};

/**
 * Power-law wind profile exponents per stability class (Tech Doc Table 7,
 * after Havens and Spicer 1985). Used to shift a wind speed measured at one
 * height to the height the model needs:  U2 = U1 * (z2/z1)^n
 */
export const WIND_PROFILE_EXPONENTS = {
  A: 0.108,
  B: 0.112,
  C: 0.12,
  D: 0.142,
  E: 0.203,
  F: 0.253,
};

/**
 * Surface roughness lengths for the three terrain presets offered to the user
 * (Tech Doc section 4.2.3). Open Water is not a fixed value — it depends on
 * wind speed — so it is computed by roughnessForOpenWater() below.
 */
export const GROUND_ROUGHNESS_PRESETS = {
  openCountry: 0.03, // m
  urbanOrForest: 1.0, // m
};

/**
 * Open water roughness length, which grows with wind speed because the wave
 * field itself is the roughness (Tech Doc section 4.2.3):
 *   z0 = 0.0000026 * (U10)^2.5
 *
 * @param {number} windSpeed10m - wind speed at 10 m, in m/s
 * @returns {number} roughness length in metres
 */
export function roughnessForOpenWater(windSpeed10m) {
  return 0.0000026 * Math.pow(windSpeed10m, 2.5);
}

/**
 * The Gaussian model distinguishes only between "large" and "small" surface
 * roughness when choosing vertical dispersion coefficients. The Tech Doc
 * (section 4.3.1) sets the split at 20 cm: below that, rural; at or above,
 * urban.
 */
export const ROUGHNESS_URBAN_THRESHOLD = 0.2; // m

/* ---------- Physical constants ---------- */

export const UNIVERSAL_GAS_CONSTANT = 8.314462618; // J/(mol·K)
export const STANDARD_PRESSURE = 101325; // Pa

/**
 * Model applicability floor for wind speed. The Tech Doc states plainly that
 * the models are applicable above 1 m/s at 10 m and "should not be used for
 * very low wind speeds or calm conditions" (section 1.2). HAZEL refuses to
 * produce a result below this rather than returning a number that looks
 * authoritative but is not supported by the model.
 */
export const MIN_WIND_SPEED = 1.0; // m/s at 10 m

/**
 * Maximum release duration the Gaussian treatment covers. Longer releases are
 * outside the range the model was built and validated for (Tech Doc section
 * 4.3: releases "of finite duration up to one hour").
 */
export const MAX_RELEASE_DURATION = 3600; // seconds
