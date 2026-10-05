#!/usr/bin/env python3
"""
convert_pac_data.py
--------------------
Converts the DOE Protective Action Criteria (PAC/TEEL) spreadsheet into the
JSON chemical database HAZEL loads at runtime.

Usage
-----
    python tools/convert_pac_data.py PacData.xlsx -o data/chemicals.json

Re-run this whenever DOE publishes a new PAC revision: download the updated
"PacData.xlsx" from https://emhub1.energy.gov/pacteel and point this script
at it. The output is deterministic (same input, same output), so re-running
after a revision produces a diff that is exactly the changes DOE made — no
manual re-keying required.

Why a script and not a one-off conversion
------------------------------------------
DOE reaffirms this dataset on a rolling schedule (their own documentation
mentions batches through at least 2027), so treating the conversion as
throwaway work would mean redoing this analysis by hand every time. Every
cleaning rule below exists because a specific value in the source workbook
needed it — see the comments at each step — so this file is also the record
of what was found wrong with the raw data and how it was handled.

What this script does NOT do
------------------------------
It does not invent data. Fields the PAC table does not contain (upper
explosive limit, critical temperature and pressure, liquid heat capacity)
are emitted as empty, flagged records pointing at where a human should look
them up (CAMEO Chemicals, NIST WebBook) — never filled with a guess. See
build_manual_entry_stub() below, and engineLimitations.js in the main HAZEL
codebase for the parallel principle applied to the dispersion model itself.

Output shape
------------
A single JSON array of chemical records (see build_chemical_record() for the
exact shape) plus a companion "<output>.report.json" listing every row this
script could not fully parse, so a human reviewer knows exactly what to
check by hand rather than having to diff 3,000+ rows to find out.
"""

import argparse
import json
import math
import re
import sys
from pathlib import Path

import pandas as pd

# ---------------------------------------------------------------------------
# Physical constants (matches the values used in HAZEL's dispersion engine —
# see engineConstants.js — so a value derived here and one computed at
# runtime from the same inputs will always agree).
# ---------------------------------------------------------------------------
GAS_CONSTANT = 8.314462618  # J/(mol*K)
MOLAR_VOLUME_AT_25C_L = 24.45  # L/mol, ideal gas at 25 C and 1 atm — the
# convention NIOSH and this spreadsheet's own "ppm to mg/m3" column both use.


def celsius_to_kelvin(value):
    """Converts Celsius to kelvin, passing through None unchanged."""
    return None if value is None or (isinstance(value, float) and math.isnan(value)) else value + 273.15


def clean_numeric_string(raw):
    """
    Strips known non-numeric annotations from a value that should be a number,
    returning (numeric_value, list_of_flags_removed).

    The PAC table's PAC-1/2/3 columns mix plain numbers with several kinds of
    decoration found during inspection of the source workbook:

      "3,000"      thousand separator                    -> 3000, []
      "65000***"   a flag also seen on the CAMEO website,
                   there indicating the value sits at or
                   above the substance's LEL              -> 65000, ["***"]
      "0.5ₑ"       an unlabelled subscript annotation      -> 0.5, ["ₑ"]
      "9.9E-08"    ordinary scientific notation            -> 9.9e-8, []
                   (float() parses this natively — nothing
                   to strip)

    The *** family is well documented externally (DOE/NOAA describe it as a
    percent-of-LEL warning) and is kept as a flag for that reason. The
    subscript markers (ₐ, ₑ) are NOT documented anywhere this script's author
    could find in DOE's public material, so rather than guess at a meaning
    they are preserved verbatim as a flag and the row is added to the
    anomaly report for a human to check against the authoritative published
    PAC table before the value is relied upon.
    """
    if raw is None or (isinstance(raw, float) and math.isnan(raw)):
        return None, []

    text = str(raw).strip()
    if text == "":
        return None, []

    flags = []

    # LEL-percentage markers: 1, 2 or 3 asterisks. Order matters — check the
    # longest first so "***" is not misread as "*" three times over.
    for marker in ("***", "**", "*"):
        if text.endswith(marker):
            flags.append(marker)
            text = text[: -len(marker)]
            break

    # Undocumented subscript annotations spotted in the source file.
    for marker in ("ₐ", "ₑ"):
        if marker in text:
            flags.append(marker)
            text = text.replace(marker, "")

    # Thousand separators
    text = text.replace(",", "")

    text = text.strip()
    if text == "":
        return None, flags

    try:
        return float(text), flags
    except ValueError:
        # Something this script did not anticipate. Surface it rather than
        # silently dropping the value — see the caller, which logs this to
        # the anomaly report.
        return None, flags + [f"unparsed:{text}"]


def normalise_state(raw):
    """
    Reduces the source workbook's ~70 free-text physical-state variants
    ("S", "L", "Scrystals", "L or S", "S hygr", "6", "??", ...) to the three
    values the dispersion engine's roughness/source logic distinguishes:
    "solid", "liquid", "gas" — plus "unknown" for the genuinely ambiguous
    entries ("L or S", "?", a bare "6").

    The heuristic is deliberately narrow: it reads the FIRST letter only,
    because inspection showed that almost every variant — however much
    qualifying text follows ("hygr", "crystals", "fuming", "@0.1C") — starts
    with the correct primary phase letter. Rows where that heuristic cannot
    even get a first letter (or where the first letter is not L/S/G/V) are
    left as "unknown" and listed in the anomaly report; there were 8 such
    rows in PAC Rev. 29 out of 3,148 (see the report after running this
    script), which is few enough to check by hand rather than build more
    heuristics for.
    """
    if raw is None or (isinstance(raw, float) and math.isnan(raw)):
        return "unknown", None

    text = str(raw).strip()
    if text == "":
        return "unknown", None

    first = text[0].upper()
    mapping = {"L": "liquid", "S": "solid", "G": "gas", "V": "gas"}  # V = vapour
    return mapping.get(first, "unknown"), text


def parse_specific_gravity(raw):
    """
    Parses values like "0.7914 @ 20°C" or a bare "1.5" into a value plus an
    optional reference temperature, preserving the original string for audit.
    """
    if raw is None or (isinstance(raw, float) and math.isnan(raw)):
        return None

    text = str(raw).strip()
    match = re.match(r"([\d.]+)(?:\s*@\s*([\d.\-]+)\s*°?\s*C)?", text)
    if not match:
        return {"value": None, "atC": None, "raw": text}

    value = float(match.group(1))
    at_c = float(match.group(2)) if match.group(2) else None
    return {"value": value, "atC": at_c, "raw": text}


def derive_heat_of_vaporization(boiling_point_c, vapor_pressure_mmhg, vapor_pressure_at_c):
    """
    Derives the molar heat of vaporisation from two points on the vapour
    pressure curve, using the Clausius-Clapeyron relation:

        ln(P2/P1) = -(deltaHvap / R) * (1/T2 - 1/T1)

    The two points available from this spreadsheet for any given substance
    are the normal boiling point (760 mmHg, by definition) and the single
    additional vapour-pressure reading the table provides. This is a
    two-point estimate, not a fit to a full vapour-pressure curve, so
    accuracy varies with how far apart the two temperatures are — see the
    docstring of this module and the worked comparison against NIST
    reference values for methanol and methyl benzoate (1.4% and 8.9% error
    respectively) that motivated including this derivation at all.

    Returns None when the required inputs are missing, or when the two
    temperature points coincide (which would divide by zero).
    """
    if None in (boiling_point_c, vapor_pressure_mmhg, vapor_pressure_at_c):
        return None
    if vapor_pressure_mmhg <= 0:
        return None

    t_boil_k = boiling_point_c + 273.15
    t_vp_k = vapor_pressure_at_c + 273.15

    if abs(t_boil_k - t_vp_k) < 0.5:
        return None  # points too close together for a stable estimate

    if vapor_pressure_mmhg >= 760.0:
        # A vapour pressure at or above 760 mmHg recorded BELOW the stated
        # boiling point is internally inconsistent — by definition the
        # boiling point is where vapour pressure reaches 760 mmHg, so it
        # cannot also be reached at a lower temperature. Four rows in PAC
        # Rev. 29 hit this (ammonium hydroxide, ethylamine, methyl
        # isocyanate and one more), most plausibly because the "vapour
        # pressure" recorded is for the pure compound while the boiling
        # point reflects an aqueous solution, or vice versa. Whatever the
        # cause, feeding it through the formula produces a negative heat of
        # vaporisation, which is not physically possible.
        return None

    ln_ratio = math.log(760.0 / vapor_pressure_mmhg)
    inv_t_diff = (1.0 / t_boil_k) - (1.0 / t_vp_k)

    if inv_t_diff == 0:
        return None

    delta_h_j_per_mol = -GAS_CONSTANT * ln_ratio / inv_t_diff
    result_kj_per_mol = delta_h_j_per_mol / 1000.0

    # Plausibility bound. A two-point Clausius-Clapeyron estimate is a
    # straight-line fit to what is really a curved relationship, so it
    # degrades as the two temperature points spread further apart. In PAC
    # Rev. 29 this shows up as a handful of substances (e.g. one row where
    # the "vapour pressure" temperature was apparently mistyped as 550 C
    # against a 34 C boiling point) producing values of several hundred to
    # over a thousand kJ/mol — an order of magnitude beyond any real
    # molecule's heat of vaporisation, which for organic and inorganic
    # compounds alike falls well under 100 kJ/mol outside a few unusual
    # cases (water and hydrogen-bonded small molecules reach into the 40s;
    # nothing ordinary approaches 150). Rather than guess which root cause
    # applies to which row, any result outside a generous physical envelope
    # is rejected here and left for manual lookup instead.
    PLAUSIBLE_MIN_KJ_MOL = 5.0
    PLAUSIBLE_MAX_KJ_MOL = 150.0
    if not (PLAUSIBLE_MIN_KJ_MOL <= result_kj_per_mol <= PLAUSIBLE_MAX_KJ_MOL):
        return None

    return result_kj_per_mol


def convert_pac_value_to_ppm(value, unit, ppm_to_mgm3_factor):
    """
    Expresses a PAC threshold in ppm regardless of how the source table
    recorded it, using the row's own "ppm to mg/m3" conversion factor so the
    result matches what that factor was calculated from (rather than
    recomputing molar volume independently and risking a rounding mismatch).
    """
    if value is None:
        return None
    if unit == "ppm":
        return value
    if unit == "mg/m3":
        if not ppm_to_mgm3_factor:
            return None  # cannot convert without the substance's own factor
        return value / ppm_to_mgm3_factor
    return None


def build_manual_entry_stub(field_name, how_to_find):
    """
    Builds the placeholder shape for a property this spreadsheet does not
    supply. `needsManualEntry: true` is the signal the Chemical step's
    interface uses to unlock the field and show the `howToFind` text under
    its help icon — see the Weather-step precedent for the same pattern
    applied to fields deriveEngineInputs() cannot compute on its own.
    """
    return {
        "value": None,
        "derived": False,
        "source": None,
        "needsManualEntry": True,
        "howToFind": how_to_find,
    }


MANUAL_ENTRY_FIELDS = {
    "upperExplosiveLimit": (
        "CAMEO Chemicals (cameochemicals.noaa.gov) -> search by CAS number -> "
        "Physical Properties -> Upper Explosive Limit (UEL)"
    ),
    "criticalTemperatureK": (
        "NIST Chemistry WebBook (webbook.nist.gov) -> search by CAS number -> "
        "Phase change data -> top summary table -> Tc row"
    ),
    "criticalPressureBar": (
        "NIST Chemistry WebBook -> Phase change data -> top summary table -> Pc row"
    ),
    "liquidHeatCapacityJmolK": (
        "NIST Chemistry WebBook -> Condensed phase thermochemistry data -> "
        "'Constant pressure heat capacity of liquid' table -> average the "
        "values listed at 298.15 K (there are usually several, from "
        "different studies)"
    ),
    "heatOfVaporizationKJmol": (
        "NIST Chemistry WebBook -> Phase change data -> either the "
        "'Enthalpy of vaporization' summary row near the top of the page, "
        "or the 'Antoine Equation Parameters' table if a more accurate "
        "value is needed at a specific temperature"
    ),
}


def build_chemical_record(row, anomalies):
    """
    Converts one spreadsheet row into a HAZEL chemical record.

    `anomalies` is a list this function appends human-readable notes to,
    one per row that needed a judgement call or could not be fully parsed.
    The caller writes these to the companion report file.
    """
    cas = str(row["cas"]).strip()
    name = str(row["name"]).strip()

    mw = row["mw"] if pd.notna(row["mw"]) else None

    state, state_raw = normalise_state(row["state"])
    if state == "unknown" and state_raw:
        anomalies.append(f"{cas} ({name}): physical state '{state_raw}' could not be classified")

    mp_c = float(row["mpC"]) if pd.notna(row["mpC"]) else None

    # Boiling point is normally numeric; the one exception found in PAC
    # Rev. 29 carries a reduced-pressure annotation (a substance that
    # decomposes before reaching 760 mmHg). Preserve that text rather than
    # discarding it.
    bp_raw = row["bpC"]
    bp_c, bp_c_note = None, None
    if pd.notna(bp_raw):
        try:
            bp_c = float(bp_raw)
        except (TypeError, ValueError):
            bp_c_note = str(bp_raw)
            anomalies.append(f"{cas} ({name}): boiling point '{bp_raw}' is not a plain value at 760 mmHg")

    vp_mmhg = float(row["vpMmHg"]) if pd.notna(row["vpMmHg"]) else None
    vp_at_c = float(row["vpTempC"]) if pd.notna(row["vpTempC"]) else None

    sg = parse_specific_gravity(row["sg"])

    lel_ppm = float(row["lelPpm"]) if pd.notna(row["lelPpm"]) else None

    pac_unit = str(row["units"]).strip() if pd.notna(row["units"]) else None
    ppm_to_mgm3 = float(row["ppmToMgm3"]) if pd.notna(row["ppmToMgm3"]) else None

    pac_values = {}
    for level, column in (("pac1", "pac1"), ("pac2", "pac2"), ("pac3", "pac3")):
        value, flags = clean_numeric_string(row[column])
        if any(f.startswith("unparsed:") for f in flags):
            anomalies.append(f"{cas} ({name}): {level} value '{row[column]}' could not be parsed as a number")
        elif flags:
            anomalies.append(f"{cas} ({name}): {level} carries source annotation {flags} — verify against the published PAC table")
        pac_values[level] = {
            "value": value,
            "unit": pac_unit,
            "flags": flags,
            "ppm": convert_pac_value_to_ppm(value, pac_unit, ppm_to_mgm3),
        }

    # Sanity check the PAC ordering. A violation almost always means a
    # transcription problem in the source (or in this parser), not a real
    # chemical for which mild effects require a HIGHER dose than severe ones.
    ppms = [pac_values[lvl]["ppm"] for lvl in ("pac1", "pac2", "pac3")]
    known = [p for p in ppms if p is not None]
    if len(known) > 1 and known != sorted(known):
        anomalies.append(f"{cas} ({name}): PAC-1/2/3 are not in non-decreasing order ({ppms}) — check the source row")

    heat_of_vaporization = None
    if state == "liquid" and None not in (bp_c, vp_mmhg, vp_at_c):
        derived_value = derive_heat_of_vaporization(bp_c, vp_mmhg, vp_at_c)
        if derived_value is not None:
            heat_of_vaporization = {
                "value": round(derived_value, 2),
                "derived": True,
                "method": (
                    "Clausius-Clapeyron, from the normal boiling point and the "
                    "single vapour-pressure point in the PAC/TEEL table. "
                    "Accuracy depends on the separation between the two "
                    "temperature points; treat as an estimate, not a "
                    "reference value."
                ),
            }
        else:
            # Inputs were present but the result failed the sanity check
            # inside derive_heat_of_vaporization() — worth a human's
            # attention, unlike the ordinary case of missing inputs.
            anomalies.append(
                f"{cas} ({name}): heat of vaporisation could not be derived from "
                f"BP={bp_c} C, VP={vp_mmhg} mmHg at {vp_at_c} C — the two-point estimate "
                f"was physically implausible or inconsistent; look up the value manually"
            )
            heat_of_vaporization = build_manual_entry_stub(
                "heatOfVaporizationKJmol", MANUAL_ENTRY_FIELDS["heatOfVaporizationKJmol"]
            )
    elif state == "liquid":
        # A liquid with no derivable value (missing BP or VP point) still
        # needs this property for the source model — offer manual entry
        # rather than leaving the field absent with no indication why.
        heat_of_vaporization = build_manual_entry_stub(
            "heatOfVaporizationKJmol", MANUAL_ENTRY_FIELDS["heatOfVaporizationKJmol"]
        )

    record = {
        "casNumber": cas,
        "name": name,
        "sourceRowNumber": int(row["no"]) if pd.notna(row["no"]) else None,
        "molecularWeight": mw,
        "molecularFormula": row["formula"] if pd.notna(row["formula"]) else None,
        "state25C": state,
        "state25CRaw": state_raw,
        "meltingPointC": mp_c,
        "meltingPointK": celsius_to_kelvin(mp_c),
        "boilingPointC": bp_c,
        "boilingPointK": celsius_to_kelvin(bp_c),
        "boilingPointRaw": bp_c_note,
        "vaporPressure": (
            {"mmHg": vp_mmhg, "atC": vp_at_c, "atK": celsius_to_kelvin(vp_at_c)}
            if vp_mmhg is not None
            else None
        ),
        "specificGravity": sg,
        "lowerExplosiveLimit": {"ppm": lel_ppm} if lel_ppm is not None else None,
        "ppmToMgPerM3Factor": ppm_to_mgm3,
        "pac": pac_values,
        "heatOfVaporizationKJmol": heat_of_vaporization,
        # Fields this spreadsheet does not supply. The Chemical step's UI
        # renders these unlocked, with the howToFind text under a help icon.
        "upperExplosiveLimit": build_manual_entry_stub(
            "upperExplosiveLimit", MANUAL_ENTRY_FIELDS["upperExplosiveLimit"]
        )
        if lel_ppm is not None
        else None,  # no LEL usually means the substance is not flammable; skip the UEL stub in that case
        "criticalTemperatureK": build_manual_entry_stub(
            "criticalTemperatureK", MANUAL_ENTRY_FIELDS["criticalTemperatureK"]
        ),
        "criticalPressureBar": build_manual_entry_stub(
            "criticalPressureBar", MANUAL_ENTRY_FIELDS["criticalPressureBar"]
        ),
        "liquidHeatCapacityJmolK": build_manual_entry_stub(
            "liquidHeatCapacityJmolK", MANUAL_ENTRY_FIELDS["liquidHeatCapacityJmolK"]
        )
        if state == "liquid"
        else None,
        # Populated later, by hand, for the priority ADR substance list —
        # see the project notes on why automatic UN-number matching was
        # deliberately not attempted (collective entries, many-to-many
        # mappings between UN numbers and single substances).
        "unNumbers": [],
    }

    return record


def load_source_rows(xlsx_path):
    """
    Reads the "Input" sheet of the PAC/TEEL workbook and returns it as a
    DataFrame with plain column names.

    The workbook has two sheets ("Input" and "Rec TEELs"); they were
    compared byte-for-byte on CAS number coverage when this script was
    written and found identical, with "Rec TEELs" being a stripped-down view
    carrying only the PAC values with none of the physical property columns.
    "Input" is therefore the only sheet this script reads. If a future DOE
    revision changes that relationship, the row-count assertion below will
    catch it rather than silently reading a smaller dataset.
    """
    df = pd.read_excel(xlsx_path, sheet_name="Input", header=None, skiprows=3)

    expected_columns = 22
    if df.shape[1] != expected_columns:
        raise ValueError(
            f"Expected {expected_columns} columns in the 'Input' sheet, found "
            f"{df.shape[1]}. DOE may have changed the workbook layout — check "
            f"the header rows manually before trusting this script's column mapping."
        )

    df.columns = [
        "no", "name", "cas", "mw", "origUnit", "ppmToMgm3", "formula", "state",
        "mpC", "bpC", "vpMmHg", "vpTempC", "sg", "lelPpm",
        "pac1", "pac2", "pac3", "sourceUnused", "units",
        "origDate", "reviewDate", "revDate",
    ]

    return df


def build_slim_index(records):
    """
    Builds a compact search index from the full records.

    Why two output files rather than one
    -------------------------------------
    The full record set is 4.2 MB compact. HAZEL is a PWA meant to work
    offline on a phone, where that is a noticeable download and a noticeable
    slice of the service worker's cache.

    The dispersion engine, though, needs exactly two things from a chemical:
    its molecular weight and a Level of Concern in ppm (see findThreatZone()
    in engineGaussian.js). Add the fields needed to search for it by name or
    CAS number and the result is 492 KB — under an eighth the size, and
    enough to run every calculation the application can currently perform.

    The full file stays available for the Source step, which will need
    boiling points, vapour pressures and heats of vaporisation, and for
    anyone auditing the data. It is simply not loaded until something needs it.

    Keys are abbreviated because at 3,148 records the JSON key names
    themselves account for a meaningful share of the file size.
    """
    return [
        {
            "cas": r["casNumber"],
            "n": r["name"],
            "f": r["molecularFormula"],
            "s": r["state25C"],
            "mw": r["molecularWeight"],
            # PAC-1, PAC-2, PAC-3 expressed in ppm (null where not derivable)
            "p": [
                r["pac"]["pac1"]["ppm"],
                r["pac"]["pac2"]["ppm"],
                r["pac"]["pac3"]["ppm"],
            ],
            # The unit the source table originally recorded, kept so the
            # interface can tell the user when a ppm figure is a conversion
            # rather than the published value.
            "u": r["pac"]["pac1"]["unit"],
            # Lower explosive limit in ppm, when the substance is flammable
            # (null for non-flammable substances such as oxidisers, which
            # this dataset correctly gives no LEL at all). Needed for the
            # flash-fire / flammable-area threat zone (ALOHA Tech Doc
            # section 6.6: threshold is 60% of the LEL), which reuses the
            # existing dispersion engines rather than being a model of its
            # own — see engineGaussian.js / engineHeavyGas.js.
            "lel": r["lowerExplosiveLimit"]["ppm"] if r["lowerExplosiveLimit"] else None,
        }
        for r in records
    ]


def convert(xlsx_path, output_path):
    df = load_source_rows(xlsx_path)

    anomalies = []
    records = []

    for _, row in df.iterrows():
        if pd.isna(row["cas"]) or pd.isna(row["name"]):
            anomalies.append(f"Row {row.get('no')}: missing CAS number or name, row skipped")
            continue
        records.append(build_chemical_record(row, anomalies))

    records.sort(key=lambda r: r["name"].lower())

    output_path = Path(output_path)

    # The full record set, written compact. Human-readable indentation would
    # add roughly a third to a file this size for no benefit — anyone
    # inspecting it will do so through a JSON viewer or the report below.
    output_path.write_text(
        json.dumps(records, separators=(",", ":"), ensure_ascii=False), encoding="utf-8"
    )

    # The slim search index the application loads at startup.
    slim_path = output_path.with_name(output_path.stem + ".slim" + output_path.suffix)
    slim_path.write_text(
        json.dumps(build_slim_index(records), separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )

    report_path = output_path.with_suffix(output_path.suffix + ".report.json")
    report = {
        "sourceFile": str(xlsx_path),
        "totalSourceRows": len(df),
        "recordsWritten": len(records),
        "fullIndexBytes": output_path.stat().st_size,
        "slimIndexBytes": slim_path.stat().st_size,
        "anomalyCount": len(anomalies),
        "anomalies": anomalies,
    }
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    return records, report


def main():
    parser = argparse.ArgumentParser(
        description="Convert the DOE PAC/TEEL spreadsheet into HAZEL's chemical database JSON."
    )
    parser.add_argument("xlsx_path", help="Path to PacData.xlsx")
    parser.add_argument(
        "-o", "--output", default="data/chemicals.json", help="Output JSON path (default: data/chemicals.json)"
    )
    args = parser.parse_args()

    records, report = convert(args.xlsx_path, args.output)

    print(f"Wrote {len(records)} chemical records to {args.output} "
          f"({report['fullIndexBytes'] / 1024:.0f} KB)")
    print(f"Wrote the slim search index ({report['slimIndexBytes'] / 1024:.0f} KB) "
          f"— this is the file the application loads at startup")
    print(f"Wrote {report['anomalyCount']} anomaly notes to {args.output}.report.json")
    if report["anomalyCount"] > 0:
        print("Review the report before treating the output as final — see its 'anomalies' list.")


if __name__ == "__main__":
    sys.exit(main())
