/**
 * gaussianAlohaTests.js
 * ---------------------
 * The Gaussian (passive) model against real ALOHA runs, 2026-10-01.
 * Run with:  node tests/gaussianAlohaTests.js
 *
 * Three changes are pinned here (all in engineGaussian.js):
 *   1. transport wind = Tech Doc 4.2.3 profile at 3 m, not the 10 m wind
 *      (gaussianTransportWindSpeed());
 *   2. an evaporating puddle is an area source: initial crosswind spread
 *      sigma0 = D / sqrt(2 pi) (AREA_SOURCE_NOTE);
 *   3. a time-varying release is summed as up to five steady steps
 *      (peakEffectiveRate(), Tech Doc 4.3).
 */

import {
  findThreatZone, gaussianTransportWindSpeed, peakConcentration, peakEffectiveRate,
} from "../js/engine/engineGaussian.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}

const zone = (s, ppm) => findThreatZone({ releaseHeight: 0, releaseDuration: 3600, ...s, levelOfConcernPpm: ppm }).maxDownwindDistance;

console.log("\n=== 1. Transport wind ===");
check("neutral, open country: ln(3.03/0.03)/ln(10.03/0.03) of the 10 m wind",
  Math.abs(gaussianTransportWindSpeed(5, 0.03, "D") / 5 - Math.log(101) / Math.log(10.03 / 0.03)) < 1e-9);
check("lower in stable air than in neutral, higher in unstable",
  gaussianTransportWindSpeed(5, 0.03, "F") < gaussianTransportWindSpeed(5, 0.03, "D") &&
  gaussianTransportWindSpeed(5, 0.03, "A") > gaussianTransportWindSpeed(5, 0.03, "D"));
check("lower over rough (urban) terrain",
  gaussianTransportWindSpeed(1.5, 1.0, "F") < gaussianTransportWindSpeed(1.5, 0.03, "F"));

console.log("\n=== 2. Point sources against ALOHA (direct source, Eindhoven 02:00) ===");
/* K1-K5: ammonia 0.1 kg/min; K7: methanol 27.9 kg/min, Gaussian forced.
   User-set levels 1000 / 100 / 10 ppm. ALOHA zones in metres. */
const ammonia = { releaseRate: 0.1 / 60, molecularWeight: 17.03 };
const points = [
  ["K1 F 1.5 m/s 10 C, 60 min", { ...ammonia, windSpeed10m: 1.5, stabilityClass: "F", temperature: 283.15, roughnessLength: 0.03 }, [35, 113, 373]],
  ["K2 D 5 m/s 15 C", { ...ammonia, windSpeed10m: 5, stabilityClass: "D", temperature: 288.15, roughnessLength: 0.03 }, [null, 20, 64]],
  ["K3 F urban", { ...ammonia, windSpeed10m: 1.5, stabilityClass: "F", temperature: 283.15, roughnessLength: 1.0 }, [18, 59, 194]],
  ["K4 F, 5 min", { ...ammonia, windSpeed10m: 1.5, stabilityClass: "F", temperature: 283.15, roughnessLength: 0.03, releaseDuration: 300 }, [35, 113, 371]],
  ["K5 A 3 m/s 20 C", { ...ammonia, windSpeed10m: 3, stabilityClass: "A", temperature: 293.15, roughnessLength: 0.03 }, [null, null, 26]],
  ["K7 methanol 27.9 kg/min, D", { releaseRate: 27.9 / 60, molecularWeight: 32.04, windSpeed10m: 5, stabilityClass: "D", temperature: 288.15, roughnessLength: 0.03 }, [78, 262, 970]],
];
for (const [label, s, aloha] of points) {
  [1000, 100, 10].forEach((ppm, i) => {
    if (!aloha[i]) return;
    const d = zone(s, ppm);
    check(`${label}, ${ppm} ppm: within 5% of ALOHA's ${aloha[i]} m`, Math.abs(d / aloha[i] - 1) < 0.05,
      `${d.toFixed(0)} m = ${(d / aloha[i]).toFixed(3)}x`);
  });
}

/* Zone widths (W1 = K1, W2 = K2, re-run with KML export, 2026-10-02). The
   KML polygons, rotated into the downwind frame, give ALOHA's greatest
   half-widths: 13.1 m (10 ppm) and 4.1 m (100 ppm) for K1, 4.5 m (10 ppm)
   for K2. ALOHA draws its contour through nine points joined by a Bezier
   curve (Tech Doc 4.5.2), so its widest point is approximate. */
for (const [label, s, ppm, alohaHalfWidth] of [
  ["W1 (K1) 10 ppm", points[0][1], 10, 13.1],
  ["W1 (K1) 100 ppm", points[0][1], 100, 4.1],
  ["W2 (K2) 10 ppm", points[1][1], 10, 4.5],
]) {
  const fp = findThreatZone({ releaseHeight: 0, releaseDuration: 3600, ...s, levelOfConcernPpm: ppm }).footprint;
  const w = Math.max(...fp.map((p) => Math.abs(p.y)));
  check(`${label}: greatest half-width within 0.88-1.08x of ALOHA's ${alohaHalfWidth} m`,
    w / alohaHalfWidth > 0.88 && w / alohaHalfWidth < 1.08, `${w.toFixed(2)} m = ${(w / alohaHalfWidth).toFixed(2)}x`);
}

/* Inversion lid (I1-I3, 2026-10-02): ammonia direct 1 kg/s, 60 min, 5 m/s,
   15 C; LOCs 100 / 30 / 10 ppm. ALOHA accepts an inversion only with class
   E or F, so I2 and I3 ran with E. */
for (const [label, cls, inv, aloha] of [
  ["I1 D, no inversion", "D", null, [570, 1200, 2300]],
  ["I0 E, no inversion", "E", null, [962, 2000, 4400]],
  ["I2 E, inversion 50 m", "E", 50, [962, 2100, 6700]],
  ["I3 E, inversion 100 m", "E", 100, [962, 2000, 4400]],
]) {
  [100, 30, 10].forEach((ppm, i) => {
    const d = zone({ releaseRate: 1, molecularWeight: 17.03, windSpeed10m: 5, stabilityClass: cls, temperature: 288.15,
      roughnessLength: 0.03, inversionHeight: inv }, ppm);
    check(`${label}, ${ppm} ppm: within 5% of ALOHA's ${aloha[i]} m`, Math.abs(d / aloha[i] - 1) < 0.05,
      `${d.toFixed(0)} m = ${(d / aloha[i]).toFixed(3)}x`);
  });
}

/* Elevated release (E1/E2, 2026-10-02): ammonia 1 kg/s, 60 min, D 5 m/s,
   15 C, source at 10 and 30 m. The transport wind is taken at the release
   height (gaussianTransportWindSpeed()). */
for (const [label, h, aloha] of [["E1 source at 10 m", 10, [470, 990, 2000]], ["E2 source at 30 m", 30, [null, 641, 1600]]]) {
  [100, 30, 10].forEach((ppm, i) => {
    const z = findThreatZone({ releaseRate: 1, releaseDuration: 3600, releaseHeight: h, molecularWeight: 17.03, windSpeed10m: 5,
      stabilityClass: "D", temperature: 288.15, roughnessLength: 0.03, levelOfConcernPpm: ppm });
    if (aloha[i] === null) {
      check(`${label}, ${ppm} ppm: never reached at ground level, as in ALOHA`, !z.thresholdExceeded);
    } else {
      const d = z.maxDownwindDistance;
      check(`${label}, ${ppm} ppm: within 3% of ALOHA's ${aloha[i]} m`, Math.abs(d / aloha[i] - 1) < 0.03,
        `${d.toFixed(0)} m = ${(d / aloha[i]).toFixed(3)}x`);
    }
  });
}

console.log("\n=== 3. Puddles as area sources (ALOHA's own evaporation rate) ===");
/* Stand-alone puddles, ALOHA Gaussian runs, with the rate ALOHA reported, so
   only the dispersion is compared. Diameter from the puddle area. */
const puddles = [
  ["P1 acetone 10 m2", 2.58, 58.08, 288.15, 5, "D", 10, [[200, 37]]],
  ["B1 benzene 10 m2", 1.29, 78.11, 288.15, 5, "D", 10, [[52, 45]]],
  ["T2 toluene 10 m2, F", 0.0867, 92.14, 278.15, 1.5, "F", 10, [[67, 49]]],
  ["G2 benzene 10 m2, F", 0.369, 78.11, 283.15, 1.5, "F", 10, [[1000, 22], [200, 67], [50, 142]]],
  ["M3 methanol 200 m2, 10 m/s", 24.2, 32.04, 288.15, 10, "D", 200, [[2100, 16], [530, 49]]],
  ["T4 toluene 200 m2, 10 m/s", 12.6, 92.14, 288.15, 10, "D", 200, [[560, 13], [67, 67]]],
  ["K6 methanol 500 m2", 27.9, 32.04, 288.15, 5, "D", 500, [[1000, 38], [100, 248], [10, 966]]],
];
for (const [label, rate, mw, T, U, cls, area, pts] of puddles) {
  const s = { releaseRate: rate / 60, molecularWeight: mw, temperature: T, windSpeed10m: U, stabilityClass: cls,
    roughnessLength: 0.03, sourceWidth: Math.sqrt((4 * area) / Math.PI) };
  for (const [ppm, aloha] of pts) {
    const d = zone(s, ppm);
    // The very nearest zones of the big puddles (13-38 m from 200-500 m2)
    // are the loosest; both tools flag them as unreliable.
    const band = aloha < 40 && area >= 200 ? [0.7, 1.35] : [0.85, 1.15];
    check(`${label}, ${ppm} ppm: within ${band[0]}-${band[1]}x of ALOHA's ${aloha} m`,
      d / aloha > band[0] && d / aloha < band[1], `${d.toFixed(0)} m = ${(d / aloha).toFixed(2)}x`);
  }
  const point = zone({ ...s, sourceWidth: 0 }, pts[0][0]);
  check(`${label}: the area source is never longer than a point source of the same rate`,
    zone(s, pts[0][0]) <= point + 1e-6);
}

console.log("\n=== 4. Time-varying release as steady steps ===");
{
  const base = { x: 300, y: 0, z: 0, releaseRate: 1, releaseDuration: 600, releaseHeight: 0,
    windSpeed10m: 3, stabilityClass: "D", roughnessLength: 0.03 };
  const single = peakConcentration(base);
  const twoHalves = peakConcentration({ ...base, releaseSteps: [
    { startTime: 0, duration: 300, rate: 1 }, { startTime: 300, duration: 300, rate: 1 },
  ] });
  check("two equal back-to-back steps reproduce the single-step closed form (within 1%)",
    Math.abs(twoHalves / single - 1) < 0.01, `${twoHalves.toExponential(4)} vs ${single.toExponential(4)}`);
  const declining = [
    { startTime: 0, duration: 60, rate: 1 }, { startTime: 60, duration: 840, rate: 0.5 },
    { startTime: 900, duration: 2700, rate: 0.2 },
  ];
  const r = peakEffectiveRate(500, declining, gaussianTransportWindSpeed(3, 0.03, "D"), "D");
  check("a declining release peaks below its first-step rate and above its later steps", r < 1 && r > 0.5,
    `effective rate ${r.toFixed(3)}`);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
