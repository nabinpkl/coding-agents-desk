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
  volume: document.getElementById("volume"),
  months: document.getElementById("volume-months"),
  clearWeek: document.getElementById("clear-week"),
  q: document.getElementById("q"),
  kinds: document.getElementById("kinds"),
  status: document.getElementById("status"),
  timeline: document.getElementById("timeline"),
  sentinel: document.getElementById("sentinel"),
  foot: document.getElementById("foot"),
  flash: document.getElementById("flash"),
};

const state = { query: "", kinds: new Set(), week: null };
let commits = [];
let weeks = [];
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

function shortWeek(day) {
  const date = new Date(utcDay(day));
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/* --- filtering ---------------------------------------------------------- */

function applyFilters() {
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const week = state.week;
  const kinds = state.kinds;

  return commits.filter((commit) => {
    if (week && commit.week !== week) return false;
    if (kinds.size && !kinds.has(commit.family)) return false;
    if (!terms.length) return true;
    const haystack =
      `${commit.title} ${commit.subject} ${commit.body} ${commit.short} ${commit.scope} ${commit.kind}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/* --- masthead and volume ------------------------------------------------ */

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

function computeWeeks() {
  if (!commits.length) return [];
  const counts = new Map();
  for (const commit of commits) counts.set(commit.week, (counts.get(commit.week) ?? 0) + 1);

  // From the week strings themselves, not from the array's ends: the strip should cover the whole
  // history whatever order the log arrives in.
  const starts = commits.map((commit) => commit.week).sort();
  const list = [];
  for (let stamp = utcDay(starts[0]); stamp <= utcDay(starts.at(-1)); stamp += 7 * DAY) {
    const week = new Date(stamp).toISOString().slice(0, 10);
    list.push({ week, count: counts.get(week) ?? 0 });
  }
  return list;
}

function renderVolume() {
  const max = Math.max(1, ...weeks.map((week) => week.count));
  els.volume.replaceChildren(
    ...weeks.map(({ week, count }) => {
      const bar = document.createElement("button");
      bar.type = "button";
      bar.className = "volume-bar";
      const percent = Math.round((count / max) * 1000) / 10;
      // A quiet week still gets two pixels, and the percentage is not rounded up to match it, so
      // one commit never reads as tall as a dozen.
      bar.style.setProperty("--h", `max(2px, ${percent}%)`);
      bar.setAttribute("aria-pressed", String(state.week === week));
      bar.setAttribute("aria-label", `Week of ${shortWeek(week)}: ${count} commit${count === 1 ? "" : "s"}`);
      bar.title = `Week of ${shortWeek(week)} · ${count} commit${count === 1 ? "" : "s"}`;
      if (!count) {
        bar.classList.add("is-empty");
        bar.disabled = true;
        bar.tabIndex = -1;
      }
      bar.dataset.week = week;
      return bar;
    }),
  );
  renderMonths();
  els.clearWeek.hidden = state.week === null;
  requestAnimationFrame(() => {
    markAllScrollables();
    if (state.week === null) els.volume.scrollLeft = els.volume.scrollWidth;
  });
}

// A scroller only gets the edge fade when it actually overflows: a mask on a row that fits just
// dims its ends.
function markScrollable(element) {
  element.classList.toggle("is-scrollable", element.scrollWidth > element.clientWidth + 1);
}

function markAllScrollables() {
  for (const element of [els.volume, els.kinds]) markScrollable(element);
}

function renderMonths() {
  const spans = [];
  let column = 1;
  for (const { week } of weeks) {
    const month = new Date(utcDay(week)).getUTCMonth();
    const last = spans.at(-1);
    if (last?.month === month) last.count += 1;
    else spans.push({ month, count: 1, start: column });
    column += 1;
  }
  // One grid column per bar, and each label spans its own run of them, so the labels line up with
  // the strip above however many weeks the history has.
  els.months.style.gridTemplateColumns = `repeat(${weeks.length}, minmax(0, 1fr))`;
  els.months.replaceChildren(
    ...spans.map(({ month, count, start }) => {
      const span = document.createElement("span");
      span.style.gridColumn = `${start} / span ${count}`;
      span.textContent = MONTHS[month];
      return span;
    }),
  );
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

function renderStatus(shown) {
  const total = commits.length;
  const filtered = state.query !== "" || state.kinds.size > 0 || state.week !== null;
  if (!filtered) {
    // The masthead already carries the totals; saying them twice is noise.
    els.status.replaceChildren();
    return;
  }
  const parts = [`Showing ${number.format(shown)} of ${number.format(total)} commits`];
  if (state.week) parts.push(`week of ${shortWeek(state.week)}`);
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
  state.week = null;
  els.q.value = "";
  for (const chip of els.kinds.querySelectorAll(".chip")) chip.setAttribute("aria-pressed", "false");
  renderVolume();
  renderTimeline();
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

  els.volume.addEventListener("click", (event) => {
    const bar = event.target.closest(".volume-bar");
    if (!bar || bar.disabled) return;
    state.week = state.week === bar.dataset.week ? null : bar.dataset.week;
    renderVolume();
    renderTimeline();
  });

  els.clearWeek.addEventListener("click", () => {
    state.week = null;
    renderVolume();
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

  addEventListener("resize", markAllScrollables, { passive: true });
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
  weeks = computeWeeks();

  renderMast(data);
  renderVolume();
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
