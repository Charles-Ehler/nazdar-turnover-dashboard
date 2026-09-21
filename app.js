/* Nazdar manufacturing turnover dashboard.
   Pure calculations live in `calc` (also exported for tools/check.js); rendering below. */
'use strict';

// Nazdar brand palette: red is the series that raises its voice, grays carry the rest.
const COLORS = { Voluntary: '#CF102D', Involuntary: '#323E48', Retirement: '#B9C1C9', red: '#CF102D', dark: '#323E48', gray: '#666666', light: '#B9C1C9', text: '#323E48', muted: '#666666' };
const CATS = ['Voluntary', 'Involuntary', 'Retirement'];
const TENURES = ['0-30 days', '31-90 days', '91-180 days', 'Over 180 days'];
const HC_KEY = { 'All MFG': 'Nazdar MFG', Packaging: 'Packaging', Processing: 'Processing' };
const DEFAULT_STATE = { cat: 'All', dept: 'All MFG', tenure: 'All', m0: 1, m1: 9 };

// ---------- pure calculations ----------
const calc = {
  sum(D, f) { return D.separations_cube.reduce((a, r) => a + (f(r) ? r.count : 0), 0); },
  pred(s, ignore = []) {
    const ig = new Set(ignore);
    return r =>
      (ig.has('cat') || s.cat === 'All' || r.category === s.cat) &&
      (ig.has('dept') || s.dept === 'All MFG' || r.department === s.dept) &&
      (ig.has('tenure') || s.tenure === 'All' || r.tenure_bucket === s.tenure) &&
      (ig.has('months') || (r.month >= s.m0 && r.month <= s.m1));
  },
  headcount(D, dept) { return HC_KEY[dept] ? D.headcount_start_of_month[HC_KEY[dept]] : null; },
  avgHeadcount(hc, m0 = 1, m1 = 12) {
    if (!hc) return null;
    const v = hc.slice(m0 - 1, m1).filter(x => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  },
  monthly(D, s) {
    const hc = calc.headcount(D, s.dept);
    const out = [];
    for (let m = s.m0; m <= s.m1; m++) {
      const row = { month: m, label: D.meta.months[m - 1] };
      CATS.forEach(c => { row[c] = calc.sum(D, r => calc.pred(s, ['cat', 'months'])(r) && r.month === m && r.category === c); });
      row.total = calc.sum(D, r => calc.pred(s, ['months'])(r) && r.month === m);
      row.hc = hc ? hc[m - 1] : null;
      row.rate = row.hc ? row.total / row.hc : null;
      out.push(row);
    }
    return out;
  },
  ytd(D, s) {
    const seps = calc.sum(D, calc.pred(s));
    const avg = calc.avgHeadcount(calc.headcount(D, s.dept), s.m0, s.m1);
    return { seps, avg, rate: avg ? seps / avg : null };
  },
  tenure(D, s) {
    const total = calc.sum(D, calc.pred(s, ['tenure']));
    return TENURES.map(t => { const n = calc.sum(D, r => calc.pred(s, ['tenure'])(r) && r.tenure_bucket === t); return { bucket: t, n, share: total ? n / total : 0 }; });
  },
  reasons(D, s) {
    const depts = s.dept === 'All MFG' ? ['Packaging', 'Processing'] : [s.dept];
    const rows = D.separation_reasons.filter(r => depts.includes(r.department));
    const map = new Map();
    rows.forEach(r => { const k = r.reason + '|' + r.category; map.set(k, (map.get(k) || 0) + r.count); });
    const total = rows.reduce((a, r) => a + r.count, 0);
    const list = [...map].map(([k, n]) => { const [reason, category] = k.split('|'); return { reason, category, n, share: total ? n / total : 0 }; }).sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason));
    const attn = list.filter(r => r.reason === 'Poor Attendance' || r.reason === 'Job Abandonment').reduce((a, r) => a + r.n, 0);
    return { list, total, attn, attnShare: total ? attn / total : 0, depts };
  },
  cohorts(D, scope, source) {
    const rows = D.hire_cohorts.filter(r => (scope === 'all' || r.department_group === 'Frontline') && (source === 'All' || r.source === source));
    const agg = keyFn => {
      const m = new Map();
      rows.forEach(r => {
        const k = keyFn(r); const a = m.get(k) || { hires: 0, still_employed: 0, left_within_30: 0, eligible_30: 0, retained_30: 0, eligible_90: 0, retained_90: 0, eligible_180: 0, retained_180: 0 };
        Object.keys(a).forEach(f => { a[f] += r[f]; }); m.set(k, a);
      });
      return m;
    };
    const rate = (a, n) => a['eligible_' + n] ? a['retained_' + n] / a['eligible_' + n] : null;
    const byMonth = [...agg(r => r.hire_month)].sort((a, b) => a[0] - b[0]).map(([m, a]) => ({ label: D.meta.months[m - 1], ...a, r30: rate(a, 30), r90: rate(a, 90), r180: rate(a, 180) }));
    const bySource = [...agg(r => r.source)].sort((a, b) => b[1].hires - a[1].hires).map(([src, a]) => ({ label: src, ...a, left30Share: a.hires ? a.left_within_30 / a.hires : 0 }));
    const tot = agg(() => 'all').get('all') || { hires: 0, still_employed: 0, eligible_30: 0, retained_30: 0, eligible_90: 0, retained_90: 0, eligible_180: 0, retained_180: 0, left_within_30: 0 };
    return { byMonth, bySource, total: { ...tot, r30: rate(tot, 30), r90: rate(tot, 90), r180: rate(tot, 180) }, sources: [...new Set(D.hire_cohorts.map(r => r.source))].sort() };
  },
  deptTable(D) {
    const H = D.headcount_start_of_month;
    const pp = H.Packaging.map((v, i) => v == null || H.Processing[i] == null ? null : v + H.Processing[i]);
    const sga = D.sga_separations_by_month;
    const mk = (name, seps, ret, hc) => { const avg = calc.avgHeadcount(hc); return { name, seps, ret, avg, ratio: avg ? seps / avg : null, monthly: avg ? seps / D.meta.months_elapsed_ytd / avg : null }; };
    const d = dept => calc.sum(D, r => r.department === dept);
    const dr = dept => calc.sum(D, r => r.department === dept && r.category === 'Retirement');
    return [
      mk('Packaging', d('Packaging'), dr('Packaging'), H.Packaging),
      mk('Processing', d('Processing'), dr('Processing'), H.Processing),
      mk('Packaging + Processing', d('Packaging') + d('Processing'), dr('Packaging') + dr('Processing'), pp),
      mk('All Nazdar MFG', calc.sum(D, () => true), calc.sum(D, r => r.category === 'Retirement'), H['Nazdar MFG']),
      mk('Nazdar SG&A (contrast)', sga.reduce((a, r) => a + r.count, 0), sga.filter(r => r.category === 'Retirement').reduce((a, r) => a + r.count, 0), H['Nazdar SG&A']),
    ];
  },
  shiftTable(D, s) {
    const R = D.roster_headcount_by_dept_shift;
    const reasonsFor = s.dept === 'Packaging' || s.dept === 'Processing' ? s.dept : null;
    return Object.keys(R).map(k => {
      const [dept, shift] = k.split('|');
      const f = r => r.department === dept && r.shift === shift;
      const avg = calc.avgHeadcount(R[k]);
      const row = { label: `${dept} ${shift}`, dept, shift, seps: calc.sum(D, f), vol: calc.sum(D, r => f(r) && r.category === 'Voluntary'), avg, ratio: avg ? calc.sum(D, f) / avg : null, left90: calc.sum(D, r => f(r) && (r.tenure_bucket === '0-30 days' || r.tenure_bucket === '31-90 days')) };
      if (reasonsFor === dept) {
        row.attendance = D.separation_reasons.filter(r => r.department === dept && r.reason === 'Poor Attendance').reduce((a, r) => a + r.count, 0);
        row.abandon = D.separation_reasons.filter(r => r.department === dept && r.reason === 'Job Abandonment').reduce((a, r) => a + r.count, 0);
      }
      return row;
    });
  },
  bridge(D, key) {
    const hc = key === 'Nazdar MFG' ? D.headcount_start_of_month['Nazdar MFG'] : D.headcount_start_of_month.Packaging.map((v, i) => v == null ? null : v + D.headcount_start_of_month.Processing[i]);
    const hires = D.hires_by_month[key];
    const inDept = key === 'Nazdar MFG' ? () => true : r => r.department === 'Packaging' || r.department === 'Processing';
    return D.meta.months.map((label, i) => {
      const seps = calc.sum(D, r => inDept(r) && r.month === i + 1);
      const start = hc[i], next = hc[i + 1] ?? null, net = hires[i] - seps;
      const implied = start == null ? null : start + net;
      return { label, start, hires: hires[i], seps, net, implied, next, diff: implied == null || next == null ? null : next - implied };
    });
  },
  // The acceptance checks from the handover (section 6), all filters at default.
  selfCheck(D) {
    const E = D.expected_totals_for_validation, s = { ...DEFAULT_STATE }, out = [];
    const eq = (name, got, want) => out.push({ name, got, want, ok: JSON.stringify(got) === JSON.stringify(want) });
    const m = calc.monthly(D, s), y = calc.ytd(D, s), t = calc.tenure(D, s), r = calc.reasons(D, s), c = calc.cohorts(D, 'all', 'All');
    eq('MFG separations YTD', y.seps, E.mfg_separations_ytd);
    CATS.forEach(cat => eq(cat, calc.sum(D, x => x.category === cat), E['mfg_' + cat.toLowerCase().replace('retirement', 'retirements')]));
    eq('Packaging', calc.sum(D, x => x.department === 'Packaging'), E.packaging);
    eq('Processing', calc.sum(D, x => x.department === 'Processing'), E.processing);
    eq('August MFG', m[7].total, E.august_mfg);
    eq('July MFG', m[6].total, 3);
    eq('Left within 30 days', t[0].n, E.left_within_30_days);
    eq('Left within 30 days share', Math.round(t[0].share * 100), 38);
    eq('Left within 180 days', t[0].n + t[1].n + t[2].n, E.left_within_180_days);
    eq('Left within 180 days share', Math.round((t[0].n + t[1].n + t[2].n) / y.seps * 100), 64);
    eq('Packaging + Processing exits', r.total, E.frontline_total);
    eq('Poor Attendance + Job Abandonment', r.attn, E.frontline_attendance_plus_abandonment);
    eq('Attendance + abandonment share', Math.round(r.attnShare * 100), 54);
    eq('2026 MFG hires', c.total.hires, E.mfg_hires_2026);
    eq('Still employed', c.total.still_employed, E.mfg_hires_still_employed);
    eq('Still employed share', Math.round(c.total.still_employed / c.total.hires * 100), 46);
    eq('Retention 30', [c.total.retained_30, c.total.eligible_30], E.retention_30);
    eq('Retention 90', [c.total.retained_90, c.total.eligible_90], E.retention_90);
    eq('Retention 180', [c.total.retained_180, c.total.eligible_180], E.retention_180);
    eq('Retention rates %', [c.total.r30, c.total.r90, c.total.r180].map(v => Math.round(v * 100)), [65, 52, 22]);
    eq('Processing mid-shift', calc.shiftTable(D, s).find(x => x.label === 'Processing Mid-Shift').seps, E.processing_mid_shift_separations);
    const sga = calc.deptTable(D)[4];
    eq('SG&A separations', sga.seps, E.sga_separations_ytd);
    eq('SG&A retirements', sga.ret, E.sga_retirements);
    eq('Monthly MFG turnover %', m.map(x => x.rate == null ? 'n/a' : +(x.rate * 100).toFixed(1)), [2.7, 0.7, 2.7, 2.7, 4.1, 5.4, 2.0, 7.7, 'n/a']);
    eq('YTD rate % / avg headcount', [Math.round(y.rate * 100), y.avg], [34, 148.75]);
    const ft = { ...s, dept: 'Processing', tenure: '0-30 days' };
    eq('Filter test Processing 0-30', [calc.sum(D, calc.pred(ft)), calc.sum(D, x => calc.pred(ft)(x) && x.category === 'Voluntary'), calc.sum(D, x => calc.pred(ft)(x) && x.category === 'Involuntary')], [7, 3, 4]);
    return out;
  },
};

if (typeof module !== 'undefined') module.exports = { calc, DEFAULT_STATE };
// Everything below touches the DOM, so it is skipped when app.js is loaded by tools/check.js under Node.
function ui() {

// ---------- formatting helpers ----------
const pct = (v, d = 1) => v == null ? null : (v * 100).toFixed(d) + '%';
const num = v => v == null ? null : String(+v.toFixed(2));
const FULL = { Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April', May: 'May', Jun: 'June', Jul: 'July', Aug: 'August', Sep: 'September', Oct: 'October', Nov: 'November', Dec: 'December' };
const full = m => FULL[m] || m;
const na = why => `<span class="na" title="${why}" aria-label="not available: ${why}">n/a</span>`;
const NA_HC = 'No start-of-month headcount reported for this month yet';
const NA_COHORT = 'Cohort too recent: no hires have reached this many days of service';
const NA_DEPT = 'No headcount is reported for Other MFG';
const cell = (v, why) => v == null ? na(why) : v;
const WORDS = ['', '', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const timesWord = r => WORDS[Math.round(r)] ? `${WORDS[Math.round(r)]} times` : `${Math.round(r)} times`;
const el = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function table(headers, rows, opts = {}) {
  const th = headers.map(h => `<th scope="col">${h}</th>`).join('');
  const body = rows.map((r, i) => `<tr${opts.totalLast && i === rows.length - 1 ? ' class="total"' : ''}>${r.map((c, j) => j === 0 ? `<th scope="row">${c}</th>` : `<td>${c ?? ''}</td>`).join('')}</tr>`).join('');
  return `<div class="table-scroll"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// Data labels on bars / points. ponytail: 25 lines instead of a second vendored plugin.
const dataLabels = {
  id: 'dataLabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    chart.data.datasets.forEach((ds, i) => {
      const meta = chart.getDatasetMeta(i);
      if (meta.hidden || ds.noLabels) return;
      const fmt = ds.labelFmt || (v => v);
      const stacked = chart.options.scales?.y?.stacked && meta.type === 'bar';
      const horizontal = chart.options.indexAxis === 'y';
      meta.data.forEach((elm, j) => {
        const v = ds.data[j];
        if (v == null || v === 0) return;
        ctx.save();
        ctx.font = '500 11px Campton, Arial, Helvetica, sans-serif';
        if (stacked) {
          const { x, y } = elm.getCenterPoint();
          if (Math.abs(elm.base - elm.y) < 14) { ctx.restore(); return; }
          ctx.fillStyle = ds.backgroundColor === COLORS.light || String(ds.backgroundColor).length > 7 ? COLORS.text : '#fff';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(fmt(v), x, y);
        } else if (horizontal) {
          ctx.fillStyle = COLORS.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillText(fmt(v), elm.x + 5, elm.y);
        } else {
          ctx.fillStyle = COLORS.text; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          ctx.fillText(fmt(v), elm.x, elm.y - 4);
        }
        ctx.restore();
      });
    });
  },
};
Chart.register(dataLabels);
Chart.defaults.font.family = 'Campton, Arial, Helvetica, sans-serif';
Chart.defaults.font.size = 13;
Chart.defaults.color = COLORS.text;

const charts = {};
function figure(id, { takeaway, caption, config, tall }) {
  const host = el(id);
  const cid = id + '-canvas';
  host.innerHTML = `<figcaption><p class="takeaway">${takeaway}</p><p class="caption">${caption}</p></figcaption>
    <div class="chartbox${tall ? ' tall' : ''}"><canvas id="${cid}" role="img" aria-label="${esc(takeaway)}"></canvas></div>
    <button type="button" class="btn tbl-toggle" aria-expanded="false">Show as table</button><div class="chart-table"></div>`;
  if (charts[id]) charts[id].destroy();
  config.options = Object.assign({ responsive: true, maintainAspectRatio: false, animation: false, layout: { padding: { top: 16, right: 24 } } }, config.options);
  charts[id] = new Chart(el(cid), config);
  const fmtOf = ds => ds.labelFmt || (v => v);
  const rows = config.data.labels.map((l, j) => [l, ...config.data.datasets.map(ds => ds.data[j] == null ? na(ds.naWhy || NA_HC) : fmtOf(ds)(ds.data[j]))]);
  host.querySelector('.chart-table').innerHTML = table(['', ...config.data.datasets.map(ds => ds.label)], rows);
  const btn = host.querySelector('.tbl-toggle'), tbl = host.querySelector('.chart-table');
  btn.onclick = () => { const open = tbl.classList.toggle('open'); btn.setAttribute('aria-expanded', open); btn.textContent = open ? 'Hide table' : 'Show as table'; };
}
function tableFigure(id, { takeaway, caption, html, callout }) {
  el(id).innerHTML = `<figcaption><p class="takeaway">${takeaway}</p><p class="caption">${caption}</p></figcaption>${html}${callout ? `<p class="callout">${callout}</p>` : ''}`;
}
const catColor = (cat, s) => s.cat === 'All' || s.cat === cat ? COLORS[cat] : COLORS[cat] + '55';

// ---------- rendering ----------
let D, state = { ...DEFAULT_STATE };

function deptName(s) { return s.dept === 'All MFG' ? 'manufacturing' : s.dept; }
function monthsLabel(s) { return s.m0 === s.m1 ? `${D.meta.months[s.m0 - 1]} 2026` : `${D.meta.months[s.m0 - 1]} to ${D.meta.months[s.m1 - 1]} 2026`; }

function renderSelection(s) {
  const cat = s.cat === 'All' ? 'all separations' : `${s.cat.toLowerCase()} separations`;
  const ten = s.tenure === 'All' ? '' : s.tenure === 'Over 180 days' ? ', leaving after 180 days' : `, leaving within ${s.tenure}`;
  el('selection').textContent = `Showing ${cat}, ${s.dept}${ten}, ${monthsLabel(s)}.`;
}

function renderKpis(s) {
  const y = calc.ytd(D, s);
  const t30 = calc.sum(D, r => calc.pred(s, ['tenure'])(r) && r.tenure_bucket === '0-30 days');
  const all = calc.sum(D, calc.pred(s, ['tenure']));
  const c = calc.cohorts(D, 'all', 'All');
  const k = (v, l) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  el('kpis').innerHTML =
    k(y.seps, 'Separations (current filter)') +
    k(all ? pct(t30 / all, 0) : na('No separations in this selection'), `Share gone within 30 days (${s.dept}, ${monthsLabel(s)})`) +
    k(y.rate == null ? na(s.dept === 'Other MFG' ? NA_DEPT : NA_HC) : pct(y.rate, 0), `Separations ÷ average headcount, ${monthsLabel(s)} (${s.dept})`) +
    k(`${c.total.still_employed} <span style="font-size:18px">(${pct(c.total.still_employed / c.total.hires, 0)})</span>`, '2026 MFG hires still employed (not filtered)') +
    k(c.total.hires, 'Hired this year, Nazdar MFG (not filtered)');
}

function renderSection1(s) {
  const m = calc.monthly(D, s), y = calc.ytd(D, s), labels = m.map(x => x.label);
  const scopeTxt = `${s.dept}, ${s.tenure === 'All' ? 'all tenures' : 'tenure ' + s.tenure}, ${monthsLabel(s)}`;

  // 1.1 stacked columns
  const peak = m.reduce((a, b) => (b.total > a.total ? b : a), m[0]);
  const prev = m[m.indexOf(peak) - 1];
  let t11 = `${full(peak.label)} had the most separations (${peak.total})`;
  if (prev && prev.total > 0 && peak.total / prev.total >= 1.95) t11 = `${full(peak.label)} separations (${peak.total}) were ${timesWord(peak.total / prev.total)} ${full(prev.label)} (${prev.total})`;
  else if (prev && peak.total > prev.total) t11 = `${full(peak.label)} separations (${peak.total}) were up from ${prev.total} in ${full(prev.label)}`;
  if (y.seps === 0) t11 = 'No separations match the current filter';
  figure('c11', {
    takeaway: t11 + '.',
    caption: `Separations by month and category. ${scopeTxt}. Source: HR separations log.`,
    config: { type: 'bar', data: { labels, datasets: CATS.map(c => ({ label: c, data: m.map(x => x[c]), backgroundColor: catColor(c, s), stack: 'a' })) },
      options: { scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } }, plugins: { legend: { position: 'top' } } } },
  });

  // 1.2 turnover % line
  const rated = m.filter(x => x.rate != null);
  const avgMonthly = rated.length ? rated.reduce((a, x) => a + x.rate, 0) / rated.length : null;
  const peakR = rated.length ? rated.reduce((a, b) => (b.rate > a.rate ? b : a)) : null;
  const t12 = s.dept === 'Other MFG' ? 'Turnover % is not available for Other MFG (no headcount reported)'
    : peakR ? `Turnover peaked at ${pct(peakR.rate)} in ${full(peakR.label)}; ${monthsLabel(s)} total is ${pct(y.rate, 0)} of average headcount (${num(y.avg)}), an average of ${pct(avgMonthly)} a month` : 'No turnover % available for this selection';
  figure('c12', {
    takeaway: t12 + '.',
    caption: `Monthly turnover % = separations ÷ start-of-month headcount (${HC_KEY[s.dept] || 'n/a'}). ${scopeTxt}. Gaps = no headcount reported. Dashed line = average monthly rate for ${monthsLabel(s)}; the year-to-date total (${pct(y.rate, 0)}) is in the title.`,
    config: { type: 'line', data: { labels, datasets: [
      { label: 'Turnover %', data: m.map(x => x.rate == null ? null : +(x.rate * 100).toFixed(1)), borderColor: COLORS.red, backgroundColor: COLORS.red, pointRadius: 5, spanGaps: false, labelFmt: v => v.toFixed(1) + '%', naWhy: NA_HC },
      { label: `Average monthly rate, ${monthsLabel(s)}`, data: m.map(() => avgMonthly == null ? null : +(avgMonthly * 100).toFixed(1)), borderColor: COLORS.gray, borderDash: [6, 4], pointRadius: 0, noLabels: true, labelFmt: v => v.toFixed(1) + '%', naWhy: NA_HC },
    ] }, options: { scales: { y: { beginAtZero: true, ticks: { callback: v => v + '%' } }, x: { grid: { display: false } } }, plugins: { legend: { position: 'top' }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y == null ? 'n/a' : c.parsed.y.toFixed(1) + '%'}` } } } } },
  });

  // 1.3 tenure at exit
  const t = calc.tenure(D, s), tot = t.reduce((a, b) => a + b.n, 0);
  const within180 = t[0].n + t[1].n + t[2].n;
  figure('c13', {
    takeaway: tot ? `${pct(within180 / tot, 0)} of ${deptName(s)} leavers were gone within 180 days (${within180} of ${tot}); ${pct(t[0].share, 0)} within 30 days.` : 'No separations match the current filter.',
    caption: `Tenure at exit, share of separations. ${s.cat === 'All' ? 'All categories' : s.cat}, ${s.dept}, ${monthsLabel(s)}. Tenure filter does not apply here.`,
    tall: true,
    config: { type: 'bar', data: { labels: TENURES, datasets: [{ label: 'Separations', data: t.map(x => x.n), backgroundColor: COLORS.dark, labelFmt: v => `${v} (${Math.round(v / tot * 100)}%)` }] },
      options: { indexAxis: 'y', scales: { x: { beginAtZero: true, ticks: { precision: 0 }, suggestedMax: Math.max(...t.map(x => x.n)) * 1.25 || 1 }, y: { grid: { display: false } } }, plugins: { legend: { display: false } } } },
  });

  // 1.4 reasons
  const r = calc.reasons(D, s);
  const scopeR = r.depts.join(' + ');
  tableFigure('t14', {
    takeaway: r.total ? `${r.list[0].reason} is the most common coded reason in ${scopeR} (${r.list[0].n} of ${r.total}).` : `No separation reasons recorded for ${scopeR}.`,
    caption: `Separation reasons as coded in the HR log, ${scopeR}, year to date. Not affected by Category, Tenure or Month filters. Coding quirks (e.g. one Job Abandonment coded Involuntary) are preserved as recorded.`,
    html: table(['Reason', 'Count', 'Share', 'Coded as'], r.list.map(x => [x.reason, x.n, pct(x.share), `<span class="swatch" style="background:${COLORS[x.category]}"></span>${x.category}`]).concat([['Total', r.total, '100.0%', '']]), { totalLast: true }),
    callout: `Poor Attendance + Job Abandonment: ${r.attn} of ${r.total} ${scopeR} exits (${pct(r.attnShare, 0)}).`,
  });
}

function renderSection2() {
  const scope = el('f2-scope').value, source = el('f2-source').value;
  const c = calc.cohorts(D, scope, source);
  if (el('f2-source').options.length === 1) c.sources.forEach(src => el('f2-source').add(new Option(src)));
  const scopeTxt = `${scope === 'all' ? 'All Nazdar MFG' : 'Packaging + Processing'} 2026 hires${source === 'All' ? '' : ', source: ' + source}`;
  const rateCell = (v, elig) => elig ? pct(v) : na(NA_COHORT);
  const T = c.total;
  tableFigure('t21', {
    takeaway: T.hires ? `${T.still_employed} of ${T.hires} hires (${pct(T.still_employed / T.hires, 0)}) are still employed; 30-day retention ${T.eligible_30 ? pct(T.r30, 0) : 'n/a'}, 90-day ${T.eligible_90 ? pct(T.r90, 0) : 'n/a'}, 180-day ${T.eligible_180 ? pct(T.r180, 0) : 'n/a'}.` : 'No hires match this selection.',
    caption: `${scopeTxt}, by hire month. Rate = retained ÷ eligible; n/a means no hire in that cohort has reached that many days yet.`,
    html: table(['Hire month', 'Hires', 'Eligible 30', 'Retained 30', 'Rate 30', 'Eligible 90', 'Retained 90', 'Rate 90', 'Eligible 180', 'Retained 180', 'Rate 180', 'Still employed', '% still employed'],
      c.byMonth.map(x => [x.label, x.hires, x.eligible_30, x.retained_30, rateCell(x.r30, x.eligible_30), x.eligible_90, x.retained_90, rateCell(x.r90, x.eligible_90), x.eligible_180, x.retained_180, rateCell(x.r180, x.eligible_180), x.still_employed, pct(x.still_employed / x.hires)])
        .concat([['Total', T.hires, T.eligible_30, T.retained_30, rateCell(T.r30, T.eligible_30), T.eligible_90, T.retained_90, rateCell(T.r90, T.eligible_90), T.eligible_180, T.retained_180, rateCell(T.r180, T.eligible_180), T.still_employed, T.hires ? pct(T.still_employed / T.hires) : na('No hires')]]), { totalLast: true }),
  });
  const rows = c.byMonth.filter(x => x.eligible_30);
  const pctFmt = v => Math.round(v) + '%';
  const best = rows.filter(x => x.eligible_90).sort((a, b) => b.r90 - a.r90)[0];
  figure('c22', {
    takeaway: best ? `${full(best.label)} hires have the strongest 90-day retention so far (${pct(best.r90, 0)}); cohorts with no eligible hires are omitted.` : 'No cohort has reached 30 days yet.',
    caption: `${scopeTxt}. Retention rate at 30, 90 and 180 days by hire month; bars missing = cohort too recent.`,
    config: { type: 'bar', data: { labels: rows.map(x => x.label), datasets: [
      { label: '30-day retention', data: rows.map(x => x.eligible_30 ? Math.round(x.r30 * 100) : null), backgroundColor: COLORS.light, labelFmt: pctFmt, naWhy: NA_COHORT },
      { label: '90-day retention', data: rows.map(x => x.eligible_90 ? Math.round(x.r90 * 100) : null), backgroundColor: COLORS.dark, labelFmt: pctFmt, naWhy: NA_COHORT },
      { label: '180-day retention', data: rows.map(x => x.eligible_180 ? Math.round(x.r180 * 100) : null), backgroundColor: COLORS.red, labelFmt: pctFmt, naWhy: NA_COHORT },
    ] }, options: { scales: { y: { beginAtZero: true, max: 110, ticks: { callback: v => v > 100 ? '' : v + '%' } }, x: { grid: { display: false } } }, plugins: { legend: { position: 'top' } } } },
  });
  const bs = c.bySource, worst = bs.filter(x => x.hires >= 2).sort((a, b) => b.left30Share - a.left30Share)[0];
  figure('c23', {
    takeaway: worst ? `${worst.label} hires leave earliest: ${worst.left_within_30} of ${worst.hires} (${pct(worst.left30Share, 0)}) gone within 30 days.` : 'Too few hires to compare sources.',
    caption: `${scopeTxt}, by hire source. Left axis: people. Right axis: % of that source's hires who left within 30 days.`,
    config: { type: 'bar', data: { labels: bs.map(x => x.label), datasets: [
      { label: 'Hires', data: bs.map(x => x.hires), backgroundColor: COLORS.dark, yAxisID: 'y' },
      { label: 'Still employed', data: bs.map(x => x.still_employed), backgroundColor: COLORS.light, yAxisID: 'y' },
      { label: '% left within 30 days', data: bs.map(x => Math.round(x.left30Share * 100)), backgroundColor: COLORS.red, yAxisID: 'y2', labelFmt: pctFmt },
    ] }, options: { scales: { y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'People' } }, y2: { beginAtZero: true, max: 100, position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: v => v + '%' } }, x: { grid: { display: false } } }, plugins: { legend: { position: 'top' } } } },
  });
}

function renderSection3(s) {
  const dt = calc.deptTable(D);
  const pp = dt[2], mfg = dt[3];
  tableFigure('t31', {
    takeaway: `Packaging + Processing account for ${pp.seps} of ${mfg.seps} MFG separations (${pct(pp.seps / mfg.seps, 0)}) with ${pct(pp.avg / mfg.avg, 0)} of the headcount.`,
    caption: `Year to date, all categories. Average headcount = mean of reported start-of-month headcounts (Jan to Aug). Average monthly rate = separations ÷ ${D.meta.months_elapsed_ytd} months elapsed ÷ average headcount.`,
    html: table(['Department', 'Separations YTD', 'of which retirements', 'Average headcount', 'Separations ÷ avg headcount', 'Average monthly rate'],
      dt.map(x => [x.name, x.seps, x.ret, num(x.avg), cell(pct(x.ratio), NA_HC), cell(pct(x.monthly), NA_HC)])),
  });
  const st = calc.shiftTable(D, s);
  const showReasons = st.some(x => x.attendance != null);
  const top = [...st].sort((a, b) => b.ratio - a.ratio)[0];
  const hdr = ['Department / shift', 'Separations', 'Voluntary', 'Avg roster headcount (Jan to Aug)', 'Separations ÷ headcount', 'Left within 90 days'].concat(showReasons ? ['Poor Attendance*', 'Job Abandonment*'] : []);
  tableFigure('t32', {
    takeaway: `${top.label} has the highest separations relative to team size: ${top.seps} separations against an average roster of ${num(top.avg)} (${pct(top.ratio, 0)}).`,
    caption: `Year to date, all categories. Roster headcount from the monthly roster tabs. ${showReasons ? `*Reason counts are ${s.dept} department totals, not by shift (the log does not code reasons by shift).` : 'Set the Department filter to Packaging or Processing to add attendance / abandonment counts (department totals; the log does not code reasons by shift).'}`,
    html: table(hdr, st.map(x => [x.label, x.seps, x.vol, num(x.avg), pct(x.ratio), x.left90].concat(showReasons ? [x.attendance ?? '', x.abandon ?? ''] : []))),
  });
  figure('c32', {
    takeaway: `Mid-shift teams lose more people per head: ${st.filter(x => x.shift === 'Mid-Shift').map(x => `${x.dept} ${pct(x.ratio, 0)}`).join(', ')} vs day shift ${st.filter(x => x.shift === 'Day Shift').map(x => `${x.dept} ${pct(x.ratio, 0)}`).join(', ')}.`,
    caption: 'Separations YTD ÷ average roster headcount (Jan to Aug), by department and shift. All categories.',
    tall: true,
    config: { type: 'bar', data: { labels: st.map(x => x.label), datasets: [{ label: 'Separations ÷ average headcount', data: st.map(x => Math.round(x.ratio * 100)), backgroundColor: st.map(x => x.shift === 'Mid-Shift' ? COLORS.red : COLORS.dark), labelFmt: v => v + '%' }] },
      options: { indexAxis: 'y', scales: { x: { beginAtZero: true, ticks: { callback: v => v + '%' }, suggestedMax: Math.max(...st.map(x => x.ratio * 100)) * 1.2 }, y: { grid: { display: false } } }, plugins: { legend: { display: false } } } },
  });
  const sup = D.supervisors_packaging_processing;
  el('t33').querySelector('.details-body').innerHTML = `<p class="caption">${esc(sup.note)}</p>` +
    table(['Supervisor', 'Department(s)', 'Shift(s)', 'Separations', 'Voluntary', 'Left within 90 days', 'Average team size (active months)', 'Months on roster', 'Separations ÷ avg team size'],
      sup.rows.map(r => [r.supervisor, r.departments || 'n/a', r.shifts || 'n/a', r.separations, r.voluntary, r.left_within_90_days, num(r.avg_team_size_active_months), r.months_on_roster, r.avg_team_size_active_months ? pct(r.separations / r.avg_team_size_active_months) : na('No roster months')]));
}

function renderSection4() {
  const r = calc.reasons(D, DEFAULT_STATE), t = calc.tenure(D, DEFAULT_STATE);
  el('s4-body').innerHTML = `
    <p><strong>What the exit codes already say.</strong> ${t[0].n} of ${t.reduce((a, b) => a + b.n, 0)} manufacturing leavers (${pct(t[0].share, 0)}) were gone within 30 days, and Poor Attendance plus Job Abandonment account for ${r.attn} of ${r.total} Packaging and Processing exits (${pct(r.attnShare, 0)}). The pattern points at the first month on the job and at the attendance policy.</p>
    <p><strong>Listening sessions.</strong> Frontline listening sessions started September 22, 2026: six day-shift sessions plus one mid-shift session, running through October 5. The guide covers schedule fit, job expectations, training, supervision, pay and the attendance policy.</p>
    <div class="placeholder"><strong>Findings: to be added</strong> when the sessions conclude (after October 5, 2026).</div>`;
}

function renderSection5() {
  const mk = (id, key, title) => {
    const b = calc.bridge(D, key);
    const gap = b.filter(x => x.diff != null && x.diff !== 0);
    tableFigure(id, {
      takeaway: `${title}: ${b.reduce((a, x) => a + x.hires, 0)} hires and ${b.reduce((a, x) => a + x.seps, 0)} separations year to date; ${gap.length ? `${gap.length} month${gap.length > 1 ? 's' : ''} do not reconcile to the reported headcount (transfers / timing)` : 'every month reconciles to the reported headcount'}.`,
      caption: `${title}. Implied end = start-of-month headcount + hires − separations. "Transfers / timing to reconcile" = next month's reported headcount − implied end.`,
      html: table(['Month', 'Start-of-month headcount (reported)', 'Hires', 'Separations', 'Net', 'Implied end', 'Next month reported', 'Transfers / timing to reconcile'],
        b.map(x => [x.label, cell(x.start, NA_HC), x.hires, x.seps, x.net > 0 ? '+' + x.net : x.net, cell(x.implied, NA_HC), cell(x.next, NA_HC), x.diff == null ? na(NA_HC) : (x.diff > 0 ? '+' + x.diff : x.diff)])),
    });
    return b;
  };
  const b = mk('t51a', 'Nazdar MFG', 'Nazdar MFG');
  mk('t51b', 'Packaging + Processing', 'Packaging + Processing');
  const peak = b.reduce((a, x) => (x.hires > a.hires ? x : a), b[0]);
  figure('c52', {
    takeaway: `Hiring peaked in ${full(peak.label)} (${peak.hires} hires) while ${peak.seps} people left; headcount went from ${b[0].start} in ${full(b[0].label)} to ${[...b].reverse().find(x => x.start != null).start} in ${full([...b].reverse().find(x => x.start != null).label)}.`,
    caption: 'Nazdar MFG. Left axis: hires and separations per month. Right axis: reported start-of-month headcount (gap = not yet reported).',
    config: { type: 'bar', data: { labels: b.map(x => x.label), datasets: [
      { label: 'Hires', data: b.map(x => x.hires), backgroundColor: COLORS.light, yAxisID: 'y' },
      { label: 'Separations', data: b.map(x => x.seps), backgroundColor: COLORS.red, yAxisID: 'y' },
      { label: 'Start-of-month headcount', type: 'line', data: b.map(x => x.start), borderColor: COLORS.dark, backgroundColor: COLORS.dark, yAxisID: 'y2', pointRadius: 4, spanGaps: false, noLabels: true, naWhy: NA_HC },
    ] }, options: { scales: { y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'People per month' } }, y2: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Headcount' } }, x: { grid: { display: false } } }, plugins: { legend: { position: 'top' } } } },
  });
}

function renderSection6() {
  const aug = calc.sum(D, r => r.month === 8), hc = D.headcount_start_of_month['Nazdar MFG'][7];
  el('s6-body').innerHTML = `This dashboard uses Nazdar US manufacturing only, separations through 9/18. On that basis August is ${aug} ÷ ${hc} = ${pct(aug / hc)}. The Hiring &amp; Retention Snapshot dated September 19 reported ${pct(D.meta.snapshot_reported_august_rate)} (15 terminations ÷ 155, data through 9/5, UK plant administration included). Both are correct on their own definitions.`;
}

function renderAll() {
  renderSelection(state);
  renderKpis(state);
  renderSection1(state);
  renderSection3(state);
}

function init(data) {
  D = data;
  el('basis').textContent = D.meta.basis;
  D.meta.months.forEach((m, i) => { el('f-m0').add(new Option(m, i + 1)); el('f-m1').add(new Option(m, i + 1)); });
  el('f-m1').value = D.meta.months.length;
  DEFAULT_STATE.m1 = D.meta.months.length; state.m1 = DEFAULT_STATE.m1;
  const read = () => {
    state = { cat: el('f-cat').value, dept: el('f-dept').value, tenure: el('f-tenure').value, m0: +el('f-m0').value, m1: +el('f-m1').value };
    if (state.m0 > state.m1) { [state.m0, state.m1] = [state.m1, state.m0]; el('f-m0').value = state.m0; el('f-m1').value = state.m1; }
    renderAll();
  };
  ['f-cat', 'f-dept', 'f-tenure', 'f-m0', 'f-m1'].forEach(id => el(id).addEventListener('change', read));
  ['f2-scope', 'f2-source'].forEach(id => el(id).addEventListener('change', renderSection2));
  el('btn-reset').onclick = () => { el('f-cat').value = 'All'; el('f-dept').value = 'All MFG'; el('f-tenure').value = 'All'; el('f-m0').value = 1; el('f-m1').value = DEFAULT_STATE.m1; read(); };
  el('btn-print').onclick = () => {
    document.querySelectorAll('details').forEach(d => { d.open = true; });
    document.querySelectorAll('.chart-table').forEach(t => t.classList.add('open'));
    window.print();
  };
  el('notes').innerHTML = D.meta.notes.map(n => `<li>${esc(n)}</li>`).join('');
  el('footer-line').textContent = `As of ${D.meta.as_of}. Source: HR separations and hires log, aggregated ${D.meta.as_of}.`;
  renderAll();
  renderSection2();
  renderSection4();
  renderSection5();
  renderSection6();
  const checks = calc.selfCheck(D), bad = checks.filter(c => !c.ok);
  window.__checks = checks;
  console[bad.length ? 'error' : 'info'](`Acceptance checks: ${checks.length - bad.length}/${checks.length} passed`, bad);
}

// Prefer the JSON file (GitHub Pages); fall back to the inlined copy when fetch is blocked (file://).
fetch('data/turnover-data.json').then(r => (r.ok ? r.json() : Promise.reject(r.status))).then(init).catch(() => init(window.TURNOVER_DATA));
}
if (typeof document !== 'undefined') ui();
