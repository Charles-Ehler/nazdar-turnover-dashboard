#!/usr/bin/env python3
"""Regenerate data/turnover-data.json from Taylor's workbook(s).

Usage:
    python3 tools/build_data.py "Turnover YTD_9.21.26.xlsx" --as-of 2026-09-21 \
        --history "Turnover.xlsx" --from 2025-10

Requires: pip install openpyxl

Inputs:
- The main workbook (tabs `2026 YTD Terms`, `2026 YTD Hires`, `2026 Headcount`, roster tabs `1-26`, `2-26`, ...).
  It is the only source of headcount, rosters, hire source and hire status.
- Optional `data/headcount-history.csv` (series,month,headcount): start-of-month headcounts for months the main workbook
  lacks. Fills gaps only; the workbook always wins.
- Optional `--history`: a workbook with `Terms` and `Hires` tabs reaching back before the main workbook's year.
  Rows dated before the main workbook's year are merged in; later rows are ignored (the main workbook wins).
  Exact duplicate rows are dropped and reported. Hires from history get source "Not recorded".
- `--from YYYY-MM`: first month of the window (default: January of the as-of year).
- Optional `data/fiscal-periods.csv` (label,start,end): when present, every date is assigned to the fiscal period whose
  start..end range contains it, instead of the calendar month. Labels must be the same "Mon YYYY" form the dashboard
  uses (e.g. "Oct 2025") so headcount and roster tabs still line up. Periods must be contiguous and cover the window.

Rules (handover, section 8):
- Nazdar US MFG = Company "Nazdar" and segment "MFG" (or "Manufacturing"); Packaging / Processing by Department;
  everything else "Other MFG".
- Category: reason starting with "Retire" -> Retirement; otherwise the Voluntary/Involuntary column.
- Tenure bucket from "Tenure - Days": <=30, 31-90, 91-180, >180.
- Hire -> separation match on last name + first name (case-insensitive, trimmed); a "Terminated" hire with no exact
  match is accepted on a unique last-name + hire-date match, and reported; anything still unmatched is warned about.
- Coding quirks are preserved, not fixed. Spelling variants normalised (NORMALISE).
- Every monthly array has one slot per month of the window; months with no data stay null.
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

MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
NORMALISE = {
    "Another Job": "Another job",
    "Left for another job": "Another job",
    "indeed": "Indeed",
    "Re-hire": "Rehire",
    "Grayso Munson": "Grayson Munson",
    "Manufacturing": "MFG",
}
FRONTLINE = ("Packaging", "Processing")
SHIFTS = ("Day Shift", "Mid-Shift")


def norm(v):
    v = " ".join(str(v).split()) if v is not None else ""
    return NORMALISE.get(v, v)


def sheet_rows(wb, name):
    rows = list(wb[name].iter_rows(values_only=True))
    header = [norm(h) if h is not None else None for h in rows[0]]
    for r in rows[1:]:
        if not any(x is not None for x in r):
            continue
        yield {h: r[i] for i, h in enumerate(header) if h}


def roster_rows(wb, name):
    """Roster tabs are inconsistent: the Shift header is sometimes blank. Shift is always the column after Job Title."""
    rows = list(wb[name].iter_rows(values_only=True))
    header = list(rows[0])
    header[header.index("Job Title") + 1] = "Shift"
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
    return "0-30 days" if days <= 30 else "31-90 days" if days <= 90 else "91-180 days" if days <= 180 else "Over 180 days"


def category(reason, vol_invol):
    return "Retirement" if norm(reason).startswith("Retire") else norm(vol_invol)


def seg_col(row):
    return next(k for k in row if "SG&A" in k)


def is_us(row, seg):
    return norm(row.get("Company")) == "Nazdar" and norm(row.get(seg_col(row))) == seg


def dedupe(rows, key, what):
    seen, out = set(), []
    for r in rows:
        k = key(r)
        if k in seen:
            continue
        seen.add(k)
        out.append(r)
    if len(out) != len(rows):
        print(f"NOTE: dropped {len(rows) - len(out)} exact duplicate {what} rows", file=sys.stderr)
    return out


def build(xlsx, as_of, history=None, start=None):
    wb = openpyxl.load_workbook(xlsx, read_only=True, data_only=True)
    start = start or dt.date(as_of.year, 1, 1)
    n_months = (as_of.year - start.year) * 12 + as_of.month - start.month + 1
    ym = [((start.month - 1 + i) % 12 + 1, start.year + (start.month - 1 + i) // 12) for i in range(n_months)]
    months = [f"{MON[m - 1]} {y}" for m, y in ym]
    periods = Path(__file__).resolve().parent.parent / "data" / "fiscal-periods.csv"
    fiscal = None
    if periods.exists():
        import csv
        fiscal = [(r["label"], dt.date.fromisoformat(r["start"]), dt.date.fromisoformat(r["end"])) for r in csv.DictReader(periods.open())]
        fiscal = [f for f in fiscal if f[0] in months]
        if [f[0] for f in fiscal] != months:
            sys.exit(f"FATAL: data/fiscal-periods.csv must define exactly these periods in order: {months}")
        for (_, _, e1), (_, s2, _) in zip(fiscal, fiscal[1:]):
            if s2 != e1 + dt.timedelta(days=1):
                sys.exit(f"FATAL: fiscal periods are not contiguous around {e1}")
        print(f"NOTE: using fiscal periods {fiscal[0][1]} to {fiscal[-1][2]} from data/fiscal-periods.csv", file=sys.stderr)

    def idx(d):  # 1-based period index in the window
        if fiscal:
            day = d.date() if isinstance(d, dt.datetime) else d
            return next((i + 1 for i, (_, s0, e0) in enumerate(fiscal) if s0 <= day <= e0), None)
        return (d.year - start.year) * 12 + d.month - start.month + 1

    def in_window(d):
        if fiscal:
            return idx(d) is not None
        return start <= d.date() <= as_of
    main_year_start = dt.date(as_of.year, 1, 1)
    jan_idx = months.index(f"Jan {as_of.year}") + 1
    if fiscal:
        main_year_start = fiscal[jan_idx - 1][1]  # history rows before the first fiscal period of the year

    # ---- Terms and hires (main workbook, plus history before the main year) ----
    terms = [t for t in sheet_rows(wb, "2026 YTD Terms") if in_window(t["Separation Date"])]
    hires = [h for h in sheet_rows(wb, "2026 YTD Hires") if in_window(h["Hire Date"])]
    if history:
        hb = openpyxl.load_workbook(history, read_only=True, data_only=True)
        ht = [t for t in sheet_rows(hb, "Terms") if t["Separation Date"].date() < main_year_start and in_window(t["Separation Date"])]
        hh = [h for h in sheet_rows(hb, "Hires") if h["Hire Date"].date() < main_year_start and in_window(h["Hire Date"])]
        ht = dedupe(ht, lambda t: (key_name(t["Last Name"], t["First Name"]), t["Separation Date"]), "history separation")
        hh = dedupe(hh, lambda h: (key_name(h["Last Name"], h["First Name"]), h["Hire Date"]), "history hire")
        for h in hh:
            h.setdefault("Hire Source", "Not recorded")
        terms = ht + terms
        hires = hh + hires
    terms = dedupe(terms, lambda t: (key_name(t["Last Name"], t["First Name"]), t["Separation Date"]), "separation")
    mfg_terms = [t for t in terms if is_us(t, "MFG")]
    sga_terms = [t for t in terms if is_us(t, "SG&A")]
    mfg_hires = [h for h in hires if is_us(h, "MFG")]

    cube, reasons = Counter(), Counter()
    for t in mfg_terms:
        m, dep = idx(t["Separation Date"]), department(t["Department"])
        cat = category(t["Separation Reason"], t["Voluntary/ Involuntary"])
        cube[(m, dep, norm(t.get("Shift")) or "N/A", cat, tenure_bucket(t["Tenure - Days"]))] += 1
        reasons[(m, dep, norm(t["Separation Reason"]), cat)] += 1
    cube_rows = [{"month": k[0], "department": k[1], "shift": k[2], "category": k[3], "tenure_bucket": k[4], "count": v} for k, v in sorted(cube.items())]
    if sum(cube.values()) != len(mfg_terms):
        sys.exit(f"FATAL: cube total {sum(cube.values())} != MFG terms {len(mfg_terms)}")
    reason_rows = [{"month": k[0], "department": k[1], "reason": k[2], "category": k[3], "count": v} for k, v in sorted(reasons.items())]
    sga = Counter((idx(t["Separation Date"]), category(t["Separation Reason"], t["Voluntary/ Involuntary"])) for t in sga_terms)
    sga_rows = [{"month": k[0], "category": k[1], "count": v} for k, v in sorted(sga.items())]

    # ---- Headcount (main workbook only; other months stay null) ----
    hc_names = {"Nazdar MFG": "Nazdar MFG", "Packaging Headcount": "Packaging", "Processing Headcount": "Processing", "Nazdar SG&A": "Nazdar SG&A"}
    headcount = {v: [None] * n_months for v in hc_names.values()}
    month_cols = {}
    for r in wb["2026 Headcount"].iter_rows(values_only=True):
        for i, v in enumerate(r):
            # column headers are first-of-month dates used as month labels, so map by label (a fiscal period can start in the prior month)
            if isinstance(v, dt.datetime) and f"{MON[v.month - 1]} {v.year}" in months:
                month_cols[i] = months.index(f"{MON[v.month - 1]} {v.year}") + 1
        if r[0] in hc_names:
            for i, m in month_cols.items():
                if isinstance(r[i], (int, float)):
                    headcount[hc_names[r[0]]][m - 1] = int(r[i])

    # Months the main workbook does not carry (e.g. late 2025) come from data/headcount-history.csv; it never overrides the workbook.
    extra = Path(__file__).resolve().parent.parent / "data" / "headcount-history.csv"
    if extra.exists():
        import csv
        for row in csv.DictReader(extra.open()):
            d = dt.date.fromisoformat(row["month"] + "-01")
            label = f"{MON[d.month - 1]} {d.year}"
            if row["series"] in headcount and label in months and headcount[row["series"]][months.index(label)] is None:
                headcount[row["series"]][months.index(label)] = int(row["headcount"])

    # ---- Rosters: dept|shift headcount and supervisor team sizes ----
    roster_tabs = [(i, f"{m}-{str(y)[2:]}") for i, (m, y) in enumerate(ym)]
    roster_tabs = [(i, t) for i, t in roster_tabs if t in wb.sheetnames]
    dept_shift = {f"{d}|{s}": [None] * n_months for d in FRONTLINE for s in SHIFTS}
    sup_team = defaultdict(lambda: [0] * n_months)  # keyed by supervisor last name
    sup_roster_name, sup_depts, sup_shifts = {}, defaultdict(Counter), defaultdict(Counter)
    for i, tab in roster_tabs:
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
            dept_shift[k][i] = c[k]

    # ---- Supervisor view (Packaging + Processing terms, whole window) ----
    sup = {}
    for t in mfg_terms:
        if department(t["Department"]) not in FRONTLINE:
            continue
        s = sup.setdefault(norm(t["Supervisor"]), Counter())
        s["separations"] += 1
        s["voluntary"] += category(t["Separation Reason"], t["Voluntary/ Involuntary"]) == "Voluntary"
        s["left_within_90_days"] += int(t["Tenure - Days"]) <= 90
    for last, full in sup_roster_name.items():  # supervisors on the roster with zero separations still appear
        if not any(last == n.split()[-1].lower() for n in sup):
            l, f = [x.strip() for x in full.split(",")]
            sup[f"{f.split()[0]} {l}"] = Counter()
    sup_rows = []
    for name, s in sup.items():
        last = name.split()[-1].lower()  # ponytail: match terms to roster on last name; unique for this plant
        team = sup_team.get(last, [0] * n_months)
        active = [x for x in team if x]
        sup_rows.append({
            "supervisor": name,
            "departments": " / ".join(k for k, _ in sup_depts[last].most_common()),
            "shifts": " / ".join(k for k, _ in sup_shifts[last].most_common()),
            "separations": s["separations"], "voluntary": s["voluntary"], "left_within_90_days": s["left_within_90_days"],
            "roster_team_size_by_month": team,
            "avg_team_size_active_months": round(sum(active) / len(active), 2) if active else 0,
            "months_on_roster": len(active),
        })
    sup_rows.sort(key=lambda r: (-r["separations"], -r["voluntary"], r["supervisor"]))

    # ---- Hires and cohorts ----
    term_by_name, term_by_last = defaultdict(list), defaultdict(list)
    for t in terms:
        term_by_name[key_name(t["Last Name"], t["First Name"])].append(t)
        term_by_last[norm(t["Last Name"]).lower()].append(t)

    def find_term(h):
        # A separation counts only if it happened after this hire (rehires share a name with an earlier separation).
        after = [t for t in term_by_name[key_name(h["Last Name"], h["First Name"])] if t["Separation Date"] >= h["Hire Date"]]
        t = min(after, key=lambda t: t["Separation Date"]) if after else None
        if t is None and norm(h.get("Status")) == "Terminated":
            cands = [c for c in term_by_last[norm(h["Last Name"]).lower()] if c.get("Hire Date") == h["Hire Date"]]
            if len(cands) == 1:
                t = cands[0]
                print(f"WARNING: hire {h['First Name']} {h['Last Name']} matched to separation of {t['First Name']} {t['Last Name']} by last name + hire date", file=sys.stderr)
        return t

    cohorts = {}
    hires_by_month = {"Nazdar MFG": [0] * n_months, "Packaging + Processing": [0] * n_months}
    for h in mfg_hires:
        hd = h["Hire Date"]
        t = find_term(h)
        if norm(h.get("Status")) == "Terminated" and t is None:
            print(f"WARNING: hire {h['First Name']} {h['Last Name']} is Terminated but has no matching separation row", file=sys.stderr)
        days_to_sep = (t["Separation Date"] - hd).days if t else None
        grp = "Frontline" if norm(h["Department"]) in FRONTLINE else "Other MFG"
        c = cohorts.setdefault((idx(hd), grp, norm(h.get("Hire Source")) or "Not recorded"), Counter())
        c["hires"] += 1
        c["still_employed"] += t is None
        c["left_within_30"] += days_to_sep is not None and days_to_sep <= 30
        for n in (30, 90, 180):
            if (as_of - hd.date()).days >= n:
                c[f"eligible_{n}"] += 1
                c[f"retained_{n}"] += days_to_sep is None or days_to_sep > n
        hires_by_month["Nazdar MFG"][idx(hd) - 1] += 1
        if grp == "Frontline":
            hires_by_month["Packaging + Processing"][idx(hd) - 1] += 1
    cohort_rows = [{"hire_month": m, "department_group": grp, "source": src, "hires": c["hires"],
                    **{f"{p}_{n}": c[f"{p}_{n}"] for n in (30, 90, 180) for p in ("eligible", "retained")},
                    "still_employed": c["still_employed"], "left_within_30": c["left_within_30"]}
                   for (m, grp, src), c in sorted(cohorts.items())]

    # ---- Validation totals: the as-of year only (the handover's acceptance figures) ----
    Y = lambda r: r["month"] >= jan_idx  # noqa: E731
    S = lambda f: sum(r["count"] for r in cube_rows if Y(r) and f(r))  # noqa: E731
    yc = [r for r in cohort_rows if r["hire_month"] >= jan_idx]
    R = lambda n: [sum(r[f"retained_{n}"] for r in yc), sum(r[f"eligible_{n}"] for r in yc)]  # noqa: E731
    fr = [r for r in reason_rows if Y(r) and r["department"] in FRONTLINE]
    expected = {
        "year": as_of.year, "year_start_month_index": jan_idx,
        "mfg_separations_ytd": S(lambda r: True),
        "mfg_voluntary": S(lambda r: r["category"] == "Voluntary"),
        "mfg_involuntary": S(lambda r: r["category"] == "Involuntary"),
        "mfg_retirements": S(lambda r: r["category"] == "Retirement"),
        "packaging": S(lambda r: r["department"] == "Packaging"),
        "processing": S(lambda r: r["department"] == "Processing"),
        "august_mfg": S(lambda r: months[r["month"] - 1].startswith("Aug")),
        "left_within_30_days": S(lambda r: r["tenure_bucket"] == "0-30 days"),
        "left_within_180_days": S(lambda r: r["tenure_bucket"] != "Over 180 days"),
        "frontline_attendance_plus_abandonment": sum(r["count"] for r in fr if r["reason"] in ("Poor Attendance", "Job Abandonment")),
        "frontline_total": sum(r["count"] for r in fr),
        "mfg_hires_2026": sum(r["hires"] for r in yc),
        "mfg_hires_still_employed": sum(r["still_employed"] for r in yc),
        "retention_30": R(30), "retention_90": R(90), "retention_180": R(180),
        "processing_mid_shift_separations": S(lambda r: r["department"] == "Processing" and r["shift"] == "Mid-Shift"),
        "sga_separations_ytd": sum(r["count"] for r in sga_rows if Y(r)),
        "sga_retirements": sum(r["count"] for r in sga_rows if Y(r) and r["category"] == "Retirement"),
    }

    last_sep = max(t["Separation Date"] for t in mfg_terms).date()
    aug_i = next(i for i, l in enumerate(months) if l == f"Aug {as_of.year}")
    aug = sum(r["count"] for r in cube_rows if r["month"] == aug_i + 1)
    aug_hc = headcount["Nazdar MFG"][aug_i]
    no_hc = [months[i] for i, v in enumerate(headcount["Nazdar MFG"]) if v is None]
    return {
        "meta": {
            "title": f"Nazdar manufacturing turnover: {FULL[start.month - 1]} {start.year} to {FULL[as_of.month - 1]} {as_of.year}",
            "as_of": as_of.isoformat(),
            "window_start": start.isoformat(),
            "basis": f"Nazdar US manufacturing (Shawnee) only; separations through {last_sep}; hires through {as_of}. "
                     f"Retirements shown as their own category."
                     + (f" Months are fiscal periods ({fiscal[0][1]} to {fiscal[-1][2]}), matching the monthly report." if fiscal else ""),
            "fiscal_periods": [{"label": l, "start": s0.isoformat(), "end": e0.isoformat()} for l, s0, e0 in fiscal] if fiscal else None,
            "months": months,
            "year_start_month_index": jan_idx,
            "months_elapsed": round((n_months - 1 + (as_of - fiscal[-1][1]).days / ((fiscal[-1][2] - fiscal[-1][1]).days + 1)) if fiscal else (n_months - 1 + as_of.day / 30), 1),
            "notes": [
                (f"No start-of-month headcount is reported for {', '.join(no_hc)}; turnover % shows n/a there."
                 if no_hc else "Start-of-month headcount is reported for every month shown."),
                "The Hiring & Retention Snapshot dated Sep 19 reported August at 9.7% (15 terminations ÷ 155, data through the August close on 9/5, "
                f"UK plant administration included). This dataset is US only: August is {aug} ÷ {aug_hc} = {100 * aug / aug_hc:.1f}%. "
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
                    "so read this as a coverage view, not a performance measure. Team sizes come from the months with a roster.",
            "rows": sup_rows,
        },
        "hires_by_month": hires_by_month,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx")
    ap.add_argument("--as-of", default=dt.date.today().isoformat())
    ap.add_argument("--history", help="workbook with Terms and Hires tabs for earlier months")
    ap.add_argument("--from", dest="start", help="first month of the window, YYYY-MM (default: January of the as-of year)")
    ap.add_argument("--out", default=Path(__file__).resolve().parent.parent / "data" / "turnover-data.json")
    a = ap.parse_args()
    as_of = dt.date.fromisoformat(a.as_of)
    start = dt.date.fromisoformat(a.start + "-01") if a.start else None
    data = build(a.xlsx, as_of, a.history, start)
    out = Path(a.out)
    if out.exists():
        archive = out.parent / "archive" / f"turnover-data-{as_of}.json"
        archive.parent.mkdir(exist_ok=True)
        shutil.copy(out, archive)
    out.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
    (out.parent / "data.js").write_text("window.TURNOVER_DATA = " + json.dumps(data, ensure_ascii=False) + ";\n")
    e = data["expected_totals_for_validation"]
    print(f"wrote {out} and data.js: {len(data['meta']['months'])} months, {sum(r['count'] for r in data['separations_cube'])} MFG separations "
          f"({e['mfg_separations_ytd']} in {e['year']}), {sum(r['hires'] for r in data['hire_cohorts'])} MFG hires ({e['mfg_hires_2026']} in {e['year']})")


if __name__ == "__main__":
    main()
