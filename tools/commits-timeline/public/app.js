// Renders /data.json into the timeline. No framework, no network beyond the one file, and no state
// that lives anywhere but this module: filters are transient by design, so a reload shows the whole
// history rather than whatever the last reader was looking at.

const CHUNK = 150;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY = 86_400_000;
const KIND_COLOR = new Set(["feat", "fix", "docs", "refactor", "perf"]);
const number = new Intl.NumberFormat("en");

const els = {
  repo: document.getElementById("repo"),
  range: document.getElementById("range"),
  figures: document.getElementById("figures"),
  theme: document.getElementById("theme"),
  chartFigure: document.getElementById("chart-figure"),
  chartLabel: document.getElementById("chart-label"),
  granularity: document.getElementById("granularity"),
  wrap: document.getElementById("chart-wrap"),
  chart: document.getElementById("chart"),
  calendarLayout: document.getElementById("calendar-layout"),
  calendar: document.getElementById("calendar"),
  calendarFacts: document.getElementById("calendar-facts"),
  months: document.getElementById("chart-months"),
  readout: document.getElementById("chart-readout"),
  clearRange: document.getElementById("clear-range"),
  q: document.getElementById("q"),
  kinds: document.getElementById("kinds"),
  status: document.getElementById("status"),
  timeline: document.getElementById("timeline"),
  sentinel: document.getElementById("sentinel"),
  foot: document.getElementById("foot"),
  flash: document.getElementById("flash"),
};

const state = { query: "", kinds: new Set(), unit: "day", range: null };
let commits = [];
let buckets = { day: [], week: [] };
let groups = [];
let groupCursor = 0;

/* --- formatting --------------------------------------------------------- */

const escapeHtml = (value) =>
  value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);

const dayOf = (isoDate) => isoDate.slice(0, 10);
const timeOf = (isoDate) => isoDate.slice(11, 16);

function utcDay(day) {
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date);
}

function formatDay(day) {
  const stamp = utcDay(day);
  const date = new Date(stamp);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function weekStartOf(day) {
  const stamp = utcDay(day);
  const offset = (new Date(stamp).getUTCDay() + 6) % 7;
  return new Date(stamp - offset * DAY).toISOString().slice(0, 10);
}

function shortDate(day) {
  const date = new Date(utcDay(day));
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

const monthOf = (day) => new Date(utcDay(day)).getUTCMonth();

/* --- filtering ---------------------------------------------------------- */

function applyFilters() {
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const range = state.range;
  const kinds = state.kinds;

  return commits.filter((commit) => {
    if (range) {
      if (range.unit === "day" ? commit.day !== range.key : commit.week !== range.key) return false;
    }
    if (kinds.size && !kinds.has(commit.family)) return false;
    if (!terms.length) return true;
    const haystack =
      `${commit.title} ${commit.subject} ${commit.body} ${commit.short} ${commit.scope} ${commit.kind}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/* --- masthead and chart ------------------------------------------------- */

function renderMast(data) {
  document.title = `${data.repo} · commit timeline`;
  els.repo.textContent = data.repo;
  const first = data.first ? formatDay(dayOf(data.first)) : "no commits";
  const last = data.last ? formatDay(dayOf(data.last)) : "";
  const span =
    data.first && data.last ? Math.round((utcDay(dayOf(data.last)) - utcDay(dayOf(data.first))) / DAY) + 1 : 0;
  els.range.textContent = data.total ? `${first} → ${last} · ${data.branch || "detached"} at ${data.head}` : first;

  const figures = [
    ["commits", number.format(data.total)],
    ["days", number.format(span)],
    ["per day", span ? (data.total / span).toFixed(1) : "0"],
  ];
  els.figures.replaceChildren(
    ...figures.map(([label, value]) => {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = `<dt>${label}</dt><dd>${value}</dd>`;
      return wrapper;
    }),
  );
}

// One bucket per day and one per week, gaps included: the chart's job is to show the quiet stretches
// as well as the busy ones, so a day with nothing is a one-pixel tick rather than a missing column.
function buildBuckets() {
  if (!commits.length) return { day: [], week: [] };

  const dayCounts = new Map();
  const weekCounts = new Map();
  for (const commit of commits) {
    dayCounts.set(commit.day, (dayCounts.get(commit.day) ?? 0) + 1);
    weekCounts.set(commit.week, (weekCounts.get(commit.week) ?? 0) + 1);
  }

  const dayKeys = commits.map((commit) => commit.day).sort();
  const days = [];
  for (let stamp = utcDay(dayKeys[0]); stamp <= utcDay(dayKeys.at(-1)); stamp += DAY) {
    const key = new Date(stamp).toISOString().slice(0, 10);
    const count = dayCounts.get(key) ?? 0;
    days.push({ key, count, tip: `${formatDay(key)} · ${count} commit${count === 1 ? "" : "s"}` });
  }

  const weekKeys = commits.map((commit) => commit.week).sort();
  const weeks = [];
  for (let stamp = utcDay(weekKeys[0]); stamp <= utcDay(weekKeys.at(-1)); stamp += 7 * DAY) {
    const key = new Date(stamp).toISOString().slice(0, 10);
    const count = weekCounts.get(key) ?? 0;
    weeks.push({ key, count, tip: `Week of ${shortDate(key)} · ${count} commit${count === 1 ? "" : "s"}` });
  }

  return { day: days, week: weeks };
}

const CHART_LABEL = { day: "Commits per day", week: "Commits per week", calendar: "Commit calendar" };

function renderChart() {
  const calendar = state.unit === "calendar";
  els.chart.hidden = calendar;
  els.calendarLayout.hidden = !calendar;
  els.months.hidden = calendar;
  els.chartFigure.classList.toggle("is-day", state.unit === "day");
  els.chartFigure.classList.toggle("is-week", state.unit === "week");
  els.chartFigure.classList.toggle("is-calendar", calendar);
  els.chartLabel.textContent = CHART_LABEL[state.unit];
  els.readout.hidden = true;
  els.clearRange.hidden = state.range === null;

  if (calendar) renderCalendar();
  else renderBars();

  requestAnimationFrame(() => {
    if (calendar) fitCalendar();
    markAllScrollables();
    if (!state.range) {
      const scroller = calendar ? els.calendar : els.chart;
      scroller.scrollLeft = scroller.scrollWidth;
    }
  });
}

function renderBars() {
  const list = buckets[state.unit];
  const max = Math.max(1, ...list.map((bucket) => bucket.count));
  const selected = state.range?.unit === state.unit ? state.range.key : null;

  const bars = list.map((bucket) => {
    const bar = document.createElement("button");
    bar.type = "button";
    bar.className = "chart-bar";
    bar.dataset.key = bucket.key;
    bar.dataset.tip = bucket.tip;
    const percent = Math.round((bucket.count / max) * 1000) / 10;
    // A quiet day still draws, and the percentage is not rounded up to match it, so one commit
    // never reads as tall as a dozen.
    bar.style.setProperty("--h", bucket.count ? `max(2px, ${percent}%)` : "1px");
    bar.setAttribute("aria-pressed", String(selected === bucket.key));
    bar.setAttribute("aria-label", bucket.tip);
    bar.tabIndex = -1;
    if (!bucket.count) {
      bar.classList.add("is-empty");
      bar.disabled = true;
    }
    return bar;
  });

  // One tab stop for the whole chart, arrows to walk it: a hundred and fifty buttons in the tab
  // order would be worse than none. The selected bucket takes the stop when there is one.
  const stop = bars.find((bar) => bar.dataset.key === selected && !bar.disabled) ?? bars.find((bar) => !bar.disabled);
  if (stop) stop.tabIndex = 0;

  els.chart.replaceChildren(...bars);
  renderMonths();
}

const addDays = (day, days) => new Date(utcDay(day) + days * DAY).toISOString().slice(0, 10);

// A GitHub-shaped calendar: one square per day, weeks as columns, weekdays as rows, and a month
// label over the week its month starts in. Squares are square, so the block stops growing at 16px
// and scrolls instead of turning the page into a wall of colour.
let calendarCells = new Map();

function renderCalendar() {
  const days = new Map(buckets.day.map((day) => [day.key, day]));
  const weeks = buckets.week.map((week) => week.key);
  const max = Math.max(1, ...buckets.day.map((day) => day.count));
  const selected = state.range?.unit === "day" ? state.range.key : null;
  els.calendar.style.setProperty("--weeks", String(weeks.length));

  const nodes = [];
  const months = [];
  let column = 1;
  for (const week of weeks) {
    const month = monthOf(week);
    const last = months.at(-1);
    if (last?.month === month) last.count += 1;
    else months.push({ month, count: 1, start: column });
    column += 1;
  }
  for (const { month, count, start } of months) {
    const label = document.createElement("span");
    label.className = "calendar-month";
    label.style.gridColumn = `${start + 1} / span ${count}`;
    label.textContent = MONTHS[month];
    nodes.push(label);
  }

  for (const [index, name] of ["Mon", "", "Wed", "", "Fri", "", ""].entries()) {
    if (!name) continue;
    const label = document.createElement("span");
    label.className = "calendar-label";
    label.style.gridRow = String(index + 2);
    label.textContent = name;
    nodes.push(label);
  }

  calendarCells = new Map();
  weeks.forEach((week, weekIndex) => {
    for (let weekday = 0; weekday < 7; weekday++) {
      const key = addDays(week, weekday);
      const day = days.get(key);
      const node = document.createElement(day ? "button" : "span");
      node.style.gridColumn = String(weekIndex + 2);
      node.style.gridRow = String(weekday + 2);
      if (!day) {
        // Before the first commit or after the last one: a hole in the calendar, not a zero day.
        node.className = "heat-outside";
        nodes.push(node);
        continue;
      }
      node.type = "button";
      node.className = "heat-cell";
      if (day.count) node.classList.add(`heat-${Math.min(4, Math.ceil((day.count / max) * 4))}`);
      node.dataset.key = key;
      node.dataset.tip = day.tip;
      node.setAttribute("aria-pressed", String(selected === key));
      node.setAttribute("aria-label", day.tip);
      node.tabIndex = -1;
      if (!day.count) node.disabled = true;
      calendarCells.set(key, node);
      nodes.push(node);
    }
  });

  const chosen = selected ? calendarCells.get(selected) : null;
  const stop =
    (chosen && !chosen.disabled ? chosen : null) ??
    [...calendarCells.values()].reverse().find((cell) => !cell.disabled);
  if (stop) stop.tabIndex = 0;

  els.calendar.replaceChildren(...nodes);
  renderCalendarFacts();
}

function renderCalendarFacts() {
  const active = buckets.day.filter((day) => day.count > 0);
  if (!active.length) {
    els.calendarFacts.replaceChildren();
    return;
  }
  const busiest = active.reduce((most, day) => (day.count > most.count ? day : most), active[0]);
  const swatches = [0, 1, 2, 3, 4].map((level) => `<i class="heat-swatch heat-${level}"></i>`).join("");
  els.calendarFacts.innerHTML = `
    <div class="heat-legend"><span>Less</span>${swatches}<span>More</span></div>
    <dl>
      <div><dt>Days with commits</dt><dd>${active.length} of ${buckets.day.length}</dd></div>
      <div><dt>Busiest day</dt><dd>${shortDate(busiest.key)} · ${number.format(busiest.count)}</dd></div>
    </dl>`;
}

function fitCalendar() {
  if (state.unit !== "calendar") return;
  const weeks = buckets.week.length || 1;
  const styles = getComputedStyle(els.calendar);
  const gutter = Number.parseFloat(styles.getPropertyValue("--gutter")) || 24;
  const gap = Number.parseFloat(styles.getPropertyValue("--gap")) || 3;
  // The facts sit beside the grid on a wide screen and under it on a narrow one, so their width
  // only comes off the grid when they are actually in the same row.
  const layout = getComputedStyle(els.calendarLayout);
  const beside = layout.flexDirection === "row" && els.calendarFacts.offsetWidth > 0;
  const reserved = beside ? els.calendarFacts.offsetWidth + (Number.parseFloat(layout.columnGap) || 0) : 0;
  const available = els.calendarLayout.clientWidth - reserved - gutter - weeks * gap;
  els.calendar.style.setProperty("--cell", `${Math.max(5, Math.min(20, Math.floor(available / weeks)))}px`);
}

// A scroller only gets the edge fade when it actually overflows: a mask on a row that fits just
// dims its ends.
function markScrollable(element) {
  element.classList.toggle("is-scrollable", element.scrollWidth > element.clientWidth + 1);
}

function markAllScrollables() {
  for (const element of [els.chart, els.calendar, els.kinds]) markScrollable(element);
}

function renderMonths() {
  const list = buckets[state.unit];
  const spans = [];
  let column = 1;
  for (const bucket of list) {
    const month = monthOf(bucket.key);
    const last = spans.at(-1);
    if (last?.month === month) last.count += 1;
    else spans.push({ month, count: 1, start: column });
    column += 1;
  }
  // One grid column per bar, and each label spans its own run of them, so the labels line up with
  // the chart above however many buckets the history has.
  els.months.style.gridTemplateColumns = `repeat(${list.length}, minmax(0, 1fr))`;
  els.months.replaceChildren(
    ...spans.map(({ month, count, start }) => {
      const span = document.createElement("span");
      span.style.gridColumn = `${start} / span ${count}`;
      span.textContent = MONTHS[month];
      return span;
    }),
  );
}

function showReadout(target) {
  const wrap = els.wrap.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  els.readout.textContent = target.dataset.tip;
  els.readout.hidden = false;
  const width = els.readout.offsetWidth;
  const center = rect.left - wrap.left + rect.width / 2;
  els.readout.style.left = `${Math.round(Math.min(Math.max(center, width / 2 + 1), wrap.width - width / 2 - 1))}px`;
}

function renderKinds() {
  const counts = new Map();
  for (const commit of commits) counts.set(commit.family, (counts.get(commit.family) ?? 0) + 1);
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  els.kinds.replaceChildren(
    ...ordered.map(([family, count]) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.dataset.kind = family;
      chip.setAttribute("aria-pressed", String(state.kinds.has(family)));
      if (KIND_COLOR.has(family)) chip.style.setProperty("--kind-color", `var(--kind-${family})`);
      chip.innerHTML = `<span>${escapeHtml(family)}</span><span class="chip-count">${number.format(count)}</span>`;
      return chip;
    }),
  );
  requestAnimationFrame(markAllScrollables);
}

function rangeLabel(range) {
  return `${range.unit} of ${shortDate(range.key)}`;
}

function renderStatus(shown) {
  const total = commits.length;
  const filtered = state.query !== "" || state.kinds.size > 0 || state.range !== null;
  if (!filtered) {
    // The masthead already carries the totals; saying them twice is noise.
    els.status.replaceChildren();
    return;
  }
  const parts = [`Showing ${number.format(shown)} of ${number.format(total)} commits`];
  if (state.range) parts.push(rangeLabel(state.range));
  els.status.innerHTML =
    `<span>${parts.join(" · ")}</span>` + `<button class="link-button" type="button" data-clear>Clear filters</button>`;
}

/* --- timeline ----------------------------------------------------------- */

function commitRow(commit) {
  const added = commit.additions ? `<b>+${number.format(commit.additions)}</b>` : "";
  const removed = commit.deletions ? `<i>−${number.format(commit.deletions)}</i>` : "";
  const stats = added || removed ? `<span class="stat">${[added, removed].filter(Boolean).join(" ")}</span>` : "";
  const scope = commit.scope ? `<span class="scope">${escapeHtml(commit.scope)}</span> ` : "";
  const refs = commit.refs.map((ref) => `<span class="ref">${escapeHtml(ref)}</span>`).join("");
  const fileLine = commit.files
    ? `${number.format(commit.files)} file${commit.files === 1 ? "" : "s"} · +${number.format(commit.additions)} −${number.format(commit.deletions)}`
    : "";

  const node = document.createElement("details");
  node.className = "commit";
  node.dataset.kind = commit.kind;
  if (KIND_COLOR.has(commit.kind)) node.style.setProperty("--kind-color", `var(--kind-${commit.kind})`);
  node.innerHTML = `
    <summary>
      <span class="time">${timeOf(commit.date)}</span>
      <span class="tag">${escapeHtml(commit.kind)}</span>
      <span class="subject">${scope}${escapeHtml(commit.title)}</span>
      <span class="meta">${stats}<span class="sha">${escapeHtml(commit.short)}</span></span>
      <span class="chev" aria-hidden="true"></span>
    </summary>
    <div class="commit-body">
      <p class="message">${escapeHtml(commit.body)}</p>
      <div class="facts">
        <button class="copy" type="button" data-hash="${escapeHtml(commit.hash)}">
          <svg class="glyph-copy" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
          <svg class="glyph-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="sha-full">${escapeHtml(commit.hash.slice(0, 12))}</span>
        </button>
        ${refs}
        ${fileLine ? `<span>${fileLine}</span>` : ""}
        <span>${escapeHtml(commit.author)}</span>
      </div>
    </div>`;
  return node;
}

function daySection(day, list) {
  const section = document.createElement("section");
  section.className = "day";
  const heading = document.createElement("h2");
  heading.innerHTML = `${formatDay(day)} <span class="day-count">${list.length}</span>`;
  const rows = document.createElement("div");
  rows.className = "day-commits";
  rows.append(...list.map(commitRow));
  section.append(heading, rows);
  return section;
}

function groupByDay(list) {
  const grouped = [];
  for (const commit of list) {
    const day = commit.day;
    const last = grouped.at(-1);
    if (last?.day === day) last.commits.push(commit);
    else grouped.push({ day, commits: [commit] });
  }
  return grouped;
}

function appendGroups() {
  let rendered = 0;
  const fragment = document.createDocumentFragment();
  while (groupCursor < groups.length && (rendered < CHUNK || rendered === 0)) {
    const group = groups[groupCursor++];
    fragment.append(daySection(group.day, group.commits));
    rendered += group.commits.length;
  }
  els.timeline.append(fragment);
  els.sentinel.hidden = groupCursor >= groups.length;
}

function renderTimeline() {
  const list = applyFilters();
  renderStatus(list.length);
  groups = groupByDay(list);
  groupCursor = 0;
  els.timeline.replaceChildren();

  if (!groups.length) {
    els.sentinel.hidden = true;
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.innerHTML = `<strong>No commit matches that.</strong> <button class="link-button" type="button" data-clear>Clear filters</button>`;
    els.timeline.append(empty);
    return;
  }
  appendGroups();
}

/* --- events ------------------------------------------------------------- */

let searchTimer = 0;

// The timer reads the field when it fires rather than the value it was handed: clearing the field
// in between (Escape, or "Clear filters") would otherwise re-apply the text that was just removed.
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = els.q.value.trim();
    renderTimeline();
  }, 90);
}

function clearFilters() {
  state.query = "";
  state.kinds.clear();
  state.range = null;
  els.q.value = "";
  for (const chip of els.kinds.querySelectorAll(".chip")) chip.setAttribute("aria-pressed", "false");
  renderChart();
  renderTimeline();
}

function setUnit(unit) {
  if (unit === state.unit) return;
  state.unit = unit;
  // A day selection still names a bucket in the calendar, but a week selection has nowhere to be
  // shown in it, so that one goes with the view it was made in.
  const shown = state.range && (state.range.unit === unit || (unit === "calendar" && state.range.unit === "day"));
  if (!shown) state.range = null;
  for (const button of els.granularity.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.unit === unit));
  }
  renderChart();
  renderTimeline();
}

function moveChartFocus(step) {
  const bars = [...els.chart.querySelectorAll(".chart-bar")].filter((bar) => !bar.disabled);
  if (!bars.length) return;
  const current = bars.indexOf(document.activeElement);
  const next = step === "home" ? 0 : step === "end" ? bars.length - 1 : (current + step + bars.length) % bars.length;
  for (const bar of bars) bar.tabIndex = -1;
  bars[next].tabIndex = 0;
  bars[next].focus();
}

// Arrow keys walk the calendar by day and by week; a day with nothing in it is stepped over rather
// than swallowing the key.
function moveCalendarFocus(key, days) {
  let target = addDays(key, days);
  for (let i = 0; i < 9; i++) {
    const cell = calendarCells.get(target);
    if (cell && !cell.disabled) {
      for (const other of calendarCells.values()) other.tabIndex = -1;
      cell.tabIndex = 0;
      cell.focus();
      return;
    }
    target = addDays(target, days > 0 ? 1 : -1);
  }
}

function bindEvents() {
  els.q.addEventListener("input", onSearch);

  els.kinds.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    const kind = chip.dataset.kind;
    if (state.kinds.has(kind)) state.kinds.delete(kind);
    else state.kinds.add(kind);
    chip.setAttribute("aria-pressed", String(state.kinds.has(kind)));
    renderTimeline();
  });

  els.granularity.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-unit]");
    if (button) setUnit(button.dataset.unit);
  });

  // Both charts are one surface to the pointer: a bar in the day or week view, a square in the
  // calendar. A calendar square always names a day, whichever view is up.
  els.wrap.addEventListener("click", (event) => {
    const bar = event.target.closest(".chart-bar");
    const cell = bar ? null : event.target.closest(".heat-cell");
    const target = bar ?? cell;
    if (!target || target.disabled) return;
    const unit = bar ? state.unit : "day";
    const key = target.dataset.key;
    const same = state.range?.unit === unit && state.range.key === key;
    state.range = same ? null : { unit, key };
    renderChart();
    renderTimeline();
  });

  els.wrap.addEventListener("pointerover", (event) => {
    const target = event.target.closest(".chart-bar, .heat-cell");
    if (target) showReadout(target);
  });
  els.wrap.addEventListener("pointerleave", () => {
    els.readout.hidden = true;
  });
  els.wrap.addEventListener("focusin", (event) => {
    const target = event.target.closest(".chart-bar, .heat-cell");
    if (target) showReadout(target);
  });
  els.wrap.addEventListener("focusout", () => {
    els.readout.hidden = true;
  });

  els.chart.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : null;
    if (step === null && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    moveChartFocus(step ?? (event.key === "Home" ? "home" : "end"));
  });

  els.calendar.addEventListener("keydown", (event) => {
    const cell = event.target.closest(".heat-cell");
    const days = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 }[event.key];
    if (!cell || days === undefined) return;
    event.preventDefault();
    moveCalendarFocus(cell.dataset.key, days);
  });

  els.clearRange.addEventListener("click", () => {
    state.range = null;
    renderChart();
    renderTimeline();
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest("[data-clear]")) return;
    clearFilters();
  });

  els.timeline.addEventListener("click", async (event) => {
    const button = event.target.closest(".copy");
    if (!button) return;
    try {
      await navigator.clipboard.writeText(button.dataset.hash);
      button.dataset.copied = "true";
      els.flash.textContent = "Commit sha copied";
      setTimeout(() => {
        delete button.dataset.copied;
      }, 1200);
    } catch {
      els.flash.textContent = "Could not copy the sha";
    }
  });

  document.addEventListener("keydown", (event) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "");
    if (event.key === "/" && !typing) {
      event.preventDefault();
      els.q.focus();
      els.q.select();
    }
    if (event.key === "Escape" && document.activeElement === els.q) {
      clearTimeout(searchTimer);
      els.q.value = "";
      state.query = "";
      renderTimeline();
      els.q.blur();
    }
  });

  new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) appendGroups();
    },
    { rootMargin: "800px" },
  ).observe(els.sentinel);

  addEventListener(
    "resize",
    () => {
      fitCalendar();
      markAllScrollables();
    },
    { passive: true },
  );
}

/* --- theme -------------------------------------------------------------- */

const THEME_KEY = "commit-timeline-theme";
const prefersDark = matchMedia("(prefers-color-scheme: dark)");

function effectiveTheme() {
  return document.documentElement.dataset.theme ?? (prefersDark.matches ? "dark" : "light");
}

// Only what the control says and shows. The colours come from `color-scheme` plus `light-dark()`,
// so with no `data-theme` the page follows the system without any script, and a reader who picks a
// side pins it.
function applyTheme() {
  const theme = effectiveTheme();
  const next = theme === "dark" ? "light" : "dark";
  els.theme.setAttribute("aria-label", `Switch to ${next} theme`);
  els.theme.title = `Switch to ${next} theme`;
  els.theme.innerHTML =
    theme === "dark"
      ? `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.2" fill="currentColor"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 1v1.8M8 13.2V15M1 8h1.8M13.2 8H15M3.05 3.05l1.27 1.27M11.68 11.68l1.27 1.27M12.95 3.05l-1.27 1.27M4.32 11.68l-1.27 1.27"/></g></svg>`
      : `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7Z" fill="currentColor"/></svg>`;
}

function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    // Storage can be denied; the page still follows the system preference.
  }
  if (stored === "light" || stored === "dark") document.documentElement.dataset.theme = stored;
  applyTheme();

  els.theme.addEventListener("click", () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    applyTheme();
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Not persisted; the toggle still works for this visit.
    }
  });

  prefersDark.addEventListener("change", () => {
    if (!document.documentElement.dataset.theme) applyTheme();
  });
}

/* --- boot --------------------------------------------------------------- */

async function boot() {
  initTheme();
  bindEvents();

  const response = await fetch("/data.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`data.json: ${response.status}`);
  const data = await response.json();

  commits = data.commits.map((commit) => ({
    ...commit,
    day: dayOf(commit.date),
    week: weekStartOf(dayOf(commit.date)),
  }));
  buckets = buildBuckets();

  renderMast(data);
  renderChart();
  renderKinds();
  renderTimeline();

  const generated = new Date(data.generatedAt);
  els.foot.textContent = `Generated ${generated.toLocaleString()} · data read from this checkout at run time and never committed`;
}

boot().catch((error) => {
  els.range.textContent = "Could not read the commit data.";
  els.status.innerHTML = `<span>${escapeHtml(error.message)}. Run <code>just commits-timeline</code> to regenerate it.</span>`;
  console.error(error);
});
