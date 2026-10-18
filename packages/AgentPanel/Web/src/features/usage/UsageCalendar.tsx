"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { UsageDay } from "@agentdesk/agent-feed-wire";
import {
  buildUsageGrid,
  monthLabels,
  type UsageCell,
  type UsageLevel,
} from "@/features/usage/usageGrid";
import { useDomSync } from "@/hooks/dom/useDomSync";

/**
 * How dark a cell is, as a monochrome ramp.
 *
 * The panel's palette is achromatic -- every token in `styles.css` is `oklch(... 0 0)` apart from
 * `--destructive` -- so a contribution-graph green would be the only chromatic surface in the
 * product. Lightness separates the levels less sharply than hue would; that is the accepted cost
 * of the grid belonging to the panel it sits in.
 */
const LEVEL_CLASS: Record<UsageLevel, string> = {
  0: "bg-muted",
  1: "bg-foreground/15",
  2: "bg-foreground/35",
  3: "bg-foreground/60",
  4: "bg-foreground/90",
};

/** Monday first, matching the grid's own row order. */
const WEEKDAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""];

export interface UsageCalendarProps {
  days: UsageDay[];
  coverageFrom: string | null;
  weeks: number;
  today: Date;
  /** The date whose numbers are on show, from hover, focus, or selection. */
  activeDate: string | null;
  onActivate: (date: string | null) => void;
  /** Reads a cell for assistive technology; the same numbers the readout shows. */
  describeCell: (cell: UsageCell) => string;
}

export function UsageCalendar({
  days,
  coverageFrom,
  weeks,
  today,
  activeDate,
  onActivate,
  describeCell,
}: UsageCalendarProps) {
  const grid = useMemo(
    () => buildUsageGrid(days, { weeks, today, coverageFrom }),
    [coverageFrom, days, today, weeks],
  );
  const months = useMemo(() => monthLabels(grid.weeks), [grid.weeks]);
  const container = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Which cell holds the grid's single tab stop. A grid of 182 focusable buttons would put 182
  // stops between the range control and the close button.
  const [cursor, setCursor] = useState<{ week: number; weekday: number }>(() => ({
    week: grid.weeks.length - 1,
    weekday: 6,
  }));

  const focusCell = useCallback((week: number, weekday: number) => {
    const next = container.current?.querySelector<HTMLElement>(
      `[data-week="${week}"][data-weekday="${weekday}"]`,
    );
    next?.focus();
  }, []);

  const move = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>, week: number, weekday: number) => {
      let nextWeek = week;
      let nextWeekday = weekday;
      switch (event.key) {
        case "ArrowLeft": nextWeek = week - 1; break;
        case "ArrowRight": nextWeek = week + 1; break;
        case "ArrowUp": nextWeekday = weekday - 1; break;
        case "ArrowDown": nextWeekday = weekday + 1; break;
        case "Home": nextWeek = 0; break;
        case "End": nextWeek = grid.weeks.length - 1; break;
        default: return;
      }
      event.preventDefault();
      if (nextWeekday < 0) {
        nextWeekday = 6;
        nextWeek -= 1;
      } else if (nextWeekday > 6) {
        nextWeekday = 0;
        nextWeek += 1;
      }
      if (nextWeek < 0 || nextWeek >= grid.weeks.length) return;
      setCursor({ week: nextWeek, weekday: nextWeekday });
      onActivate(grid.weeks[nextWeek]![nextWeekday]!.date);
      focusCell(nextWeek, nextWeekday);
    },
    [focusCell, grid.weeks, onActivate],
  );

  // Pinned to the most recent week, on first paint AND whenever the range changes.
  //
  // The second half is not a nicety. Widening from 26 weeks to the whole history keeps the same
  // scroller node, so a one-shot ref callback would leave it parked at the left edge -- opening
  // the wider view on the OLDEST weeks, which is the opposite of what asking for more history
  // means. The rightmost column is always "this week", and that is what the grid should show.
  useDomSync(() => {
    const node = scroller.current;
    if (node) node.scrollLeft = node.scrollWidth;
  }, [weeks, grid.weeks.length]);

  return (
    <div ref={container} className="flex gap-1.5">
      <div className="flex shrink-0 flex-col gap-[3px] pt-3.5" aria-hidden>
        {WEEKDAY_LABELS.map((label, index) => (
          <div
            key={index}
            className="flex h-3 w-7 items-center text-[9px] leading-none text-muted-foreground"
          >
            {label}
          </div>
        ))}
      </div>
      {/* Scrolls inside its own box: half a year of weeks is wider than a phone, and the page
          itself must never scroll sideways. */}
      <div ref={scroller} className="min-w-0 flex-1 overflow-x-auto pb-1">
        <div
          role="grid"
          aria-label="Token usage by day"
          className="flex w-max gap-[3px]"
          onMouseLeave={() => onActivate(null)}
        >
          {grid.weeks.map((week, weekIndex) => (
            <div key={week[0]!.date} role="row" className="flex flex-col gap-[3px]">
              <div className="h-3.5 text-[9px] leading-none text-muted-foreground">
                {months[weekIndex] ?? ""}
              </div>
              {week.map((cell, weekday) => (
                <div
                  key={cell.date}
                  role="gridcell"
                  data-week={weekIndex}
                  data-weekday={weekday}
                  data-date={cell.date}
                  data-level={cell.level}
                  aria-label={describeCell(cell)}
                  aria-selected={activeDate === cell.date}
                  tabIndex={cursor.week === weekIndex && cursor.weekday === weekday ? 0 : -1}
                  onMouseEnter={() => onActivate(cell.date)}
                  onFocus={() => onActivate(cell.date)}
                  onClick={() => {
                    setCursor({ week: weekIndex, weekday });
                    onActivate(cell.date);
                  }}
                  onKeyDown={(event) => move(event, weekIndex, weekday)}
                  className={cellClass(cell, activeDate === cell.date)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function cellClass(cell: UsageCell, active: boolean): string {
  const base = "size-3 rounded-[2px] outline-none transition-[box-shadow,background-color] "
    + "duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-primary";
  // A future date is a hole, and a date the scan does not reach is an outline. Neither is an
  // empty day, which is a real observation and gets the flat fill.
  if (cell.future) return `${base} bg-transparent`;
  if (!cell.covered) return `${base} border border-dashed border-border bg-transparent`;
  const fill = LEVEL_CLASS[cell.level];
  const emphasis = active ? " ring-2 ring-primary ring-offset-1 ring-offset-card" : "";
  return `${base} ${fill} cursor-pointer hover:ring-1 hover:ring-ring${emphasis}`;
}

export function UsageLegend({ thresholds }: { thresholds: number[] }) {
  return (
    <div className="flex items-center gap-1 text-[10px] text-muted-foreground" aria-hidden>
      <span>less</span>
      {([0, 1, 2, 3, 4] as UsageLevel[]).map((level) => (
        <span key={level} className={`size-3 rounded-[2px] ${LEVEL_CLASS[level]}`} />
      ))}
      <span>more</span>
      {thresholds[2] ? <span className="sr-only">{`top quartile from ${thresholds[2]}`}</span> : null}
    </div>
  );
}
