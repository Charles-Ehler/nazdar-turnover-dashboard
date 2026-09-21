#!/usr/bin/env python3
"""Regenerate data/turnover-data.json from Taylor's workbook.

Usage:
    python3 tools/build_data.py "path/to/Turnover YTD_9.21.26.xlsx" [--as-of 2026-09-21]

Requires: pip install openpyxl

Rules (from the handover doc, section 8):
- Nazdar US MFG = Company "Nazdar" and segment "MFG"; Packaging / Processing by Department; everything else "Other MFG".
- Category: reason starting with "Retire" -> Retirement; otherwise the Voluntary/Involuntary column.
- Tenure bucket from "Tenure - Days": <=30, 31-90, 91-180, >180.
- Hire -> separation match on last name + first name (case-insensitive, trimmed); unmatched "Terminated" hires are warned about.
- Coding quirks are preserved, not fixed (a Job Abandonment coded Involuntary, a Poor Attendance coded Voluntary, Misconduct vs Gross Misconduct).
- Spelling variants normalised (see NORMALISE).
- Headcount arrays have 9 slots Jan-Sep; missing months stay null.
- Fails loudly if the cube total != count of MFG terms.
"""
import argparse
import datetime as dt
import json
import shutil
import sys
import warnings
from collections import Counter, defaultdict
from pathlib import Path

warnings.filterwarnings("ignore", module="openpyxl")
import openpyxl  # noqa: E402

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
NORMALISE = {
    "Another Job": "Another job",
    "indeed": "Indeed",
    "Re-hire": "Rehire",
    "Grayso Munson": "Grayson Munson",
}
FRONTLINE = ("Packaging", "Processing")
SHIFTS = ("Day Shift", "Mid-Shift")


def norm(v):
    v = " ".join(str(v).split()) if v is not None else ""
    return NORMALISE.get(v, v)


def sheet_rows(wb, name):
    """Yield dict rows keyed by header for a sheet whose first row is the header."""
    rows = list(wb[name].iter_rows(values_only=True))
    header = [norm(h) if h is not None else None for h in rows[0]]
    for r in rows[1:]:
        if not any(x is not None for x in r):
            continue
        yield {h: r[i] for i, h in enumerate(header) if h}


def roster_rows(wb, name):
    """Roster tabs (1-26 ...) are inconsistent: Shift header is sometimes blank. Shift is always the column after Job Title."""
    rows = list(wb[name].iter_rows(values_only=True))
    header = list(rows[0])
    ji = header.index("Job Title")
    header[ji + 1] = "Shift"
    for r in rows[1:]:
        if r[0] is None:
            continue
        yield {h: r[i] for i, h in enumerate(header) if h}


def key_name(last, first):
    return (norm(last).lower(), norm(first).lower())


def department(d):
    d = norm(d)
    return d if d in FRONTLINE else "Other MFG"


def tenure_bucket(days):
    days = int(days)
    if days <= 30:
        return "0-30 days"
    if days <= 90:
        return "31-90 days"
    if days <= 180:
        return "91-180 days"
    return "Over 180 days"


def category(reason, vol_invol):
    return "Retirement" if norm(reason).startswith("Retire") else norm(vol_invol)


def is_us_mfg(row, seg_col):
    return norm(row.get("Company")) == "Nazdar" and norm(row.get(seg_col)) == "MFG"


def build(xlsx, as_of):
    wb = openpyxl.load_workbook(xlsx, read_only=True, data_only=True)
    n_months = as_of.month  # Jan..as_of month
    months = MONTHS[:n_months]

    # ---- Terms -----------------------------------------------------------
    terms = list(sheet_rows(wb, "2026 YTD Terms"))
    seg_col = next(k for k in terms[0] if "SG&A" in k)
    mfg_terms = [t for t in terms if is_us_mfg(t, seg_col)]
    sga_terms = [t for t in terms if norm(t["Company"]) == "Nazdar" and norm(t[seg_col]) == "SG&A"]

    cube = Counter()
    reasons = Counter()
    for t in mfg_terms:
        m = t["Separation Date"].month
        dep = department(t["Department"])
        shift = norm(t.get("Shift")) or "N/A"
        cat = category(t["Separation Reason"], t["Voluntary/ Involuntary"])
        cube[(m, dep, shift, cat, tenure_bucket(t["Tenure - Days"]))] += 1
        reasons[(dep, norm(t["Separation Reason"]), cat)] += 1
    cube_rows = [
        {"month": k[0], "department": k[1], "shift": k[2], "category": k[3], "tenure_bucket": k[4], "count": v}
        for k, v in sorted(cube.items())
    ]
    if sum(cube.values()) != len(mfg_terms):
        sys.exit(f"FATAL: cube total {sum(cube.values())} != MFG terms {len(mfg_terms)}")
    reason_rows = [
        {"department": k[0], "reason": k[1], "category": k[2], "count": v}
        for k, v in sorted(reasons.items(), key=lambda kv: (-kv[1], kv[0]))
    ]
    sga = Counter((t["Separation Date"].month, category(t["Separation Reason"], t["Voluntary/ Involuntary"])) for t in sga_terms)
    sga_rows = [{"month": k[0], "category": k[1], "count": v} for k, v in sorted(sga.items())]

    # ---- Headcount -------------------------------------------------------
    hc_names = {"Nazdar MFG": "Nazdar MFG", "Packaging Headcount": "Packaging", "Processing Headcount": "Processing", "Nazdar SG&A": "Nazdar SG&A"}
    headcount = {v: [None] * n_months for v in hc_names.values()}
    month_cols = {}  # column index -> month, taken from the date header rows
    for r in wb["2026 Headcount"].iter_rows(values_only=True):
        for i, v in enumerate(r):
            if isinstance(v, dt.datetime) and v.year == as_of.year:
                month_cols[i] = v.month
        if r[0] in hc_names:
            for i, m in month_cols.items():
                if isinstance(r[i], (int, float)) and m <= n_months:
                    headcount[hc_names[r[0]]][m - 1] = int(r[i])

    # ---- Rosters: dept|shift headcount and supervisor team sizes ----------
    roster_tabs = [f"{m}-{str(as_of.year)[2:]}" for m in range(1, n_months + 1)]
    roster_tabs = [t for t in roster_tabs if t in wb.sheetnames]
    dept_shift = {f"{d}|{s}": [] for d in FRONTLINE for s in SHIFTS}
    sup_team = defaultdict(lambda: [0] * len(roster_tabs))  # keyed by supervisor last name
    sup_roster_name, sup_depts, sup_shifts = {}, defaultdict(Counter), defaultdict(Counter)
    for i, tab in enumerate(roster_tabs):
        c = Counter()
        for r in roster_rows(wb, tab):
            if norm(r["Company"]) != "Nazdar" or norm(r["Department"]) not in FRONTLINE:
                continue
            c[f"{norm(r['Department'])}|{norm(r['Shift'])}"] += 1
            last = norm(r["Supervisor"]).split(",")[0].lower()  # roster is "Last, First M."
            sup_team[last][i] += 1
            sup_roster_name[last] = norm(r["Supervisor"])
            sup_depts[last][norm(r["Department"])] += 1
            sup_shifts[last][norm(r["Shift"])] += 1
        for k in dept_shift:
            dept_shift[k].append(c[k])

    # ---- Supervisor view (Packaging + Processing terms) ------------------
    sup = {}
    for t in mfg_terms:
        if department(t["Department"]) not in FRONTLINE:
            continue
        s = sup.setdefault(norm(t["Supervisor"]), Counter())
        s["separations"] += 1
        s["voluntary"] += category(t["Separation Reason"], t["Voluntary/ Involuntary"]) == "Voluntary"
        s["left_within_90_days"] += int(t["Tenure - Days"]) <= 90
    # supervisors on the roster with zero separations still appear
    for last, full in sup_roster_name.items():
        if not any(last == n.split()[-1].lower() for n in sup):
            l, f = [x.strip() for x in full.split(",")]
            sup[f"{f.split()[0]} {l}"] = Counter()
    sup_rows = []
    for name, s in sup.items():
        last = name.split()[-1].lower()  # ponytail: match terms to roster on last name; unique for this plant
        team = sup_team.get(last, [0] * len(roster_tabs))
        active = [x for x in team if x]
        sup_rows.append({
            "supervisor": name,
            "departments": " / ".join(k for k, _ in sup_depts[last].most_common()),
            "shifts": " / ".join(k for k, _ in sup_shifts[last].most_common()),
            "separations": s["separations"],
            "voluntary": s["voluntary"],
            "left_within_90_days": s["left_within_90_days"],
            "roster_team_size_by_month": team,
            "avg_team_size_active_months": round(sum(active) / len(active), 2) if active else 0,
            "months_on_roster": len(active),
        })
    sup_rows.sort(key=lambda r: (-r["separations"], -r["voluntary"], r["supervisor"]))

    # ---- Hires and cohorts -----------------------------------------------
    hires = list(sheet_rows(wb, "2026 YTD Hires"))
    seg_col_h = next(k for k in hires[0] if "SG&A" in k)
    mfg_hires = [h for h in hires if is_us_mfg(h, seg_col_h)]
    term_by_name = {key_name(t["Last Name"], t["First Name"]): t for t in terms}
    term_by_last = defaultdict(list)
    for t in terms:
        term_by_last[norm(t["Last Name"]).lower()].append(t)

    def find_term(h):
        t = term_by_name.get(key_name(h["Last Name"], h["First Name"]))
        if t is None and norm(h.get("Status")) == "Terminated":
            # ponytail: first-name typos happen ("Chalres"); accept a unique last-name match hired the same day
            cands = [c for c in term_by_last[norm(h["Last Name"]).lower()] if c.get("Hire Date") == h["Hire Date"]]
            if len(cands) == 1:
                t = cands[0]
                print(f"WARNING: hire {h['First Name']} {h['Last Name']} matched to separation of {t['First Name']} {t['Last Name']} by last name + hire date", file=sys.stderr)
        return t
    cohorts = Counter()
    hires_by_month = {"Nazdar MFG": [0] * n_months, "Packaging + Processing": [0] * n_months}
    for h in mfg_hires:
        hd = h["Hire Date"]
        t = find_term(h)
        if norm(h.get("Status")) == "Terminated" and t is None:
            print(f"WARNING: hire {h['First Name']} {h['Last Name']} is Terminated but has no matching separation row", file=sys.stderr)
        days_to_sep = (t["Separation Date"] - hd).days if t else None
        grp = "Frontline" if norm(h["Department"]) in FRONTLINE else "Other MFG"
        k = (hd.month, grp, norm(h.get("Hire Source")) or "Unknown")
        c = cohorts.setdefault(k, Counter())
        c["hires"] += 1
        c["still_employed"] += t is None
        c["left_within_30"] += days_to_sep is not None and days_to_sep <= 30
        for n in (30, 90, 180):
            if (as_of - hd.date()).days >= n:
                c[f"eligible_{n}"] += 1
                c[f"retained_{n}"] += days_to_sep is None or days_to_sep > n
        hires_by_month["Nazdar MFG"][hd.month - 1] += 1
        if grp == "Frontline":
            hires_by_month["Packaging + Processing"][hd.month - 1] += 1
    cohort_rows = []
    for (m, grp, src), c in sorted(cohorts.items()):
        cohort_rows.append({"hire_month": m, "department_group": grp, "source": src, "hires": c["hires"],
                            **{f"{p}_{n}": c[f"{p}_{n}"] for n in (30, 90, 180) for p in ("eligible", "retained")},
                            "still_employed": c["still_employed"], "left_within_30": c["left_within_30"]})

    # ---- Validation totals ---------------------------------------------
    S = lambda f: sum(r["count"] for r in cube_rows if f(r))  # noqa: E731
    R = lambda n: [sum(r[f"retained_{n}"] for r in cohort_rows), sum(r[f"eligible_{n}"] for r in cohort_rows)]  # noqa: E731
    front_reasons = [r for r in reason_rows if r["department"] in FRONTLINE]
    expected = {
        "mfg_separations_ytd": S(lambda r: True),
        "mfg_voluntary": S(lambda r: r["category"] == "Voluntary"),
        "mfg_involuntary": S(lambda r: r["category"] == "Involuntary"),
        "mfg_retirements": S(lambda r: r["category"] == "Retirement"),
        "packaging": S(lambda r: r["department"] == "Packaging"),
        "processing": S(lambda r: r["department"] == "Processing"),
        "august_mfg": S(lambda r: r["month"] == 8),
        "left_within_30_days": S(lambda r: r["tenure_bucket"] == "0-30 days"),
        "left_within_180_days": S(lambda r: r["tenure_bucket"] != "Over 180 days"),
        "frontline_attendance_plus_abandonment": sum(r["count"] for r in front_reasons if r["reason"] in ("Poor Attendance", "Job Abandonment")),
        "frontline_total": sum(r["count"] for r in front_reasons),
        "mfg_hires_2026": sum(r["hires"] for r in cohort_rows),
        "mfg_hires_still_employed": sum(r["still_employed"] for r in cohort_rows),
        "retention_30": R(30), "retention_90": R(90), "retention_180": R(180),
        "processing_mid_shift_separations": S(lambda r: r["department"] == "Processing" and r["shift"] == "Mid-Shift"),
        "sga_separations_ytd": sum(r["count"] for r in sga_rows),
        "sga_retirements": sum(r["count"] for r in sga_rows if r["category"] == "Retirement"),
    }

    last_sep = max(t["Separation Date"] for t in mfg_terms).date()
    aug = S(lambda r: r["month"] == 8)
    aug_hc = headcount["Nazdar MFG"][7]
    return {
        "meta": {
            "title": f"Nazdar manufacturing turnover: {as_of.year} year to date",
            "as_of": as_of.isoformat(),
            "basis": f"Nazdar US manufacturing (Shawnee) only; separations through {last_sep}; hires through {as_of}. "
                     "Retirements shown as their own category.",
            "months": months,
            "months_elapsed_ytd": round(as_of.month - 1 + as_of.day / 30, 1),
            "notes": [
                f"{months[-1]} has no start-of-month headcount yet; show turnover % as n/a for {months[-1]}."
                if headcount["Nazdar MFG"][-1] is None else "Start-of-month headcount is reported for every month shown.",
                "The Hiring & Retention Snapshot dated Sep 19 reported August at 9.7% (15 terminations ÷ 155, data through 9/5, "
                f"UK plant administration included). On this dataset's basis August is {aug} ÷ {aug_hc} = {100 * aug / aug_hc:.1f}%. "
                "Both are correct on their own definitions.",
            ],
            "snapshot_reported_august_rate": 0.097,
        },
        "headcount_start_of_month": headcount,
        "roster_headcount_by_dept_shift": dept_shift,
        "separations_cube": cube_rows,
        "separation_reasons": reason_rows,
        "sga_separations_by_month": sga_rows,
        "hire_cohorts": cohort_rows,
        "expected_totals_for_validation": expected,
        "supervisors_packaging_processing": {
            "note": "Counts follow shift and team size; supervisors changed during the year (Logan Borders left in April, Edwin Reyes in June), "
                    "so read this as a coverage view, not a performance measure.",
            "rows": sup_rows,
        },
        "hires_by_month": hires_by_month,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx")
    ap.add_argument("--as-of", default=dt.date.today().isoformat())
    ap.add_argument("--out", default=Path(__file__).resolve().parent.parent / "data" / "turnover-data.json")
    a = ap.parse_args()
    as_of = dt.date.fromisoformat(a.as_of)
    data = build(a.xlsx, as_of)
    out = Path(a.out)
    if out.exists():
        archive = out.parent / "archive" / f"turnover-data-{as_of}.json"
        archive.parent.mkdir(exist_ok=True)
        shutil.copy(out, archive)
    out.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
    (out.parent / "data.js").write_text("window.TURNOVER_DATA = " + json.dumps(data, ensure_ascii=False) + ";\n")
    print(f"wrote {out} and data.js — {data['expected_totals_for_validation']['mfg_separations_ytd']} MFG separations, "
          f"{data['expected_totals_for_validation']['mfg_hires_2026']} MFG hires")


if __name__ == "__main__":
    main()
