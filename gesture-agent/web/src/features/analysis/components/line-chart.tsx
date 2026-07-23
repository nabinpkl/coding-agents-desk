"use client";

/**
 * Minimal, dependency-free line chart rendered as inline SVG. One numeric series
 * over time. Theme-aware: axes, gridlines and labels use `currentColor` (driven
 * by the surrounding text color token), while the trace uses an explicit,
 * accessible hue passed by the caller. Scales to its container via a fixed
 * viewBox and non-scaling strokes so line weight stays constant.
 */

import { useId } from "react";

import { cn } from "@/lib/utils";

export interface ChartPoint {
  x: number;
  y: number;
}

export interface LineChartProps {
  points: ChartPoint[];
  color: string;
  yLabel: string;
  formatX?: (value: number) => string;
  formatY?: (value: number) => string;
  className?: string;
}

const VIEW_WIDTH = 640;
const VIEW_HEIGHT = 200;
const PAD_LEFT = 56;
const PAD_RIGHT = 16;
const PAD_TOP = 16;
const PAD_BOTTOM = 30;
const PLOT_WIDTH = VIEW_WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM;
const Y_TICKS = 4;

const defaultFormat = (value: number) => value.toFixed(2);

export function LineChart({
  points,
  color,
  yLabel,
  formatX = defaultFormat,
  formatY = defaultFormat,
  className,
}: LineChartProps) {
  const gradientId = useId();

  if (points.length === 0) {
    return (
      <div
        className={cn(
          "flex h-[200px] items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground",
          className,
        )}
      >
        No frames to plot
      </div>
    );
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMinRaw = Math.min(...ys);
  const yMaxRaw = Math.max(...ys);
  // Pad the y-range so a flat series still renders and peaks are not clipped.
  const yMin = yMinRaw === yMaxRaw ? yMinRaw - 1 : yMinRaw;
  const yMax = yMinRaw === yMaxRaw ? yMaxRaw + 1 : yMaxRaw;
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  const toX = (value: number) =>
    PAD_LEFT + ((value - xMin) / xSpan) * PLOT_WIDTH;
  const toY = (value: number) =>
    PAD_TOP + (1 - (value - yMin) / ySpan) * PLOT_HEIGHT;

  const linePath = points
    .map((point, index) => {
      const command = index === 0 ? "M" : "L";
      return `${command}${toX(point.x).toFixed(2)},${toY(point.y).toFixed(2)}`;
    })
    .join(" ");

  const areaPath = `${linePath} L${toX(xMax).toFixed(2)},${(
    PAD_TOP + PLOT_HEIGHT
  ).toFixed(2)} L${toX(xMin).toFixed(2)},${(PAD_TOP + PLOT_HEIGHT).toFixed(
    2,
  )} Z`;

  const yTicks = Array.from({ length: Y_TICKS + 1 }, (_, index) => {
    const value = yMin + (ySpan * index) / Y_TICKS;
    return { value, y: toY(value) };
  });

  const xTickValues = [xMin, xMin + xSpan / 2, xMax];

  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${yLabel} over time, ${points.length} frames, ranging ${formatY(
        yMinRaw,
      )} to ${formatY(yMaxRaw)}`}
      className={cn("h-[200px] w-full text-muted-foreground", className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* Horizontal gridlines + y-axis tick labels */}
      {yTicks.map((tick) => (
        <g key={`y-${tick.value}`}>
          <line
            x1={PAD_LEFT}
            y1={tick.y}
            x2={VIEW_WIDTH - PAD_RIGHT}
            y2={tick.y}
            stroke="currentColor"
            strokeOpacity={0.14}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          <text
            x={PAD_LEFT - 8}
            y={tick.y}
            textAnchor="end"
            dominantBaseline="middle"
            fill="currentColor"
            fontSize={11}
          >
            {formatY(tick.value)}
          </text>
        </g>
      ))}

      {/* X-axis tick labels */}
      {xTickValues.map((value, index) => (
        <text
          key={`x-${value}-${index}`}
          x={toX(value)}
          y={VIEW_HEIGHT - 8}
          textAnchor={index === 0 ? "start" : index === 2 ? "end" : "middle"}
          fill="currentColor"
          fontSize={11}
        >
          {formatX(value)}
        </text>
      ))}

      <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
