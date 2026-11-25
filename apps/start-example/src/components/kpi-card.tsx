// One key figure on the overview, ported from Fuse's app-shell block (kpi-card.tsx at Fuse 9be80460): a label, the
// value in its unit, how it changed and a Sparkline of how it got there. It uses no hook: Fuse's `formatChartValue`
// writes the value as the charts write theirs, in the locale it is handed, and the page hands it the sentence that
// says how the value changed, translated and formatted by intl.
import type { ReactNode } from "react";

import { Card } from "@elmeragroup/fuse/card";
import { formatChartValue, Sparkline } from "@elmeragroup/fuse/chart";
import type { ValueFormat } from "@elmeragroup/fuse/chart";
import { TrendDown, TrendUp } from "@elmeragroup/fuse/icons";
import type { SupportedLocale } from "@elmeragroup/fuse/theme";

/** One key figure's content. */
export type KpiCardProps = {
  /** The id of the card's change sentence, unique on the page. */
  readonly id: string;
  /** What the figure is, such as "Consumption, March 1–28". */
  readonly label: string;
  readonly value: number;
  /** The value's unit, as the charts take it, which names the value for screen readers. */
  readonly format: ValueFormat;
  /** Fuse's locale for the request's. */
  readonly locale: SupportedLocale;
  /**
   * A shorter visible figure for a unit whose full label is long, such as "41.9 øre/kWh": one message the page
   * translates and formats whole, so a translator places the number and its unit.
   */
  readonly figure?: string;
  /** A badge at the card's end, such as the price level. */
  readonly badge?: ReactNode;
  /** The change as a fraction, such as -0.031, and the sentence that says it, such as "−3.1% against last year". */
  readonly change?: { readonly value: number; readonly text: string };
  /** A line under the value for a figure with no change to show, such as how it was estimated. */
  readonly note?: string;
  /** The values behind the figure, oldest first; `null` is a gap. */
  readonly trend: ReadonlyArray<number | null>;
  /** The Sparkline's accessible name. */
  readonly trendLabel: string;
  /** How the Sparkline draws: a line by default, bars for daily totals. */
  readonly trendVariant?: "line" | "bar" | "area";
};

/**
 * One key figure.
 *
 * @param props - The figure, its change and its trend.
 */
export function KpiCard({
  id,
  label,
  value,
  format,
  locale,
  figure,
  badge,
  change,
  note,
  trend,
  trendLabel,
  trendVariant = "line",
}: KpiCardProps) {
  const formatted = formatChartValue(value, format, { locale });
  const text = figure ?? formatted.text;
  const Trend = change !== undefined && change.value < 0 ? TrendDown : TrendUp;

  return (
    <Card.Root>
      <Card.Header>
        <Card.Description>{label}</Card.Description>
        {badge === undefined ? null : <Card.Action>{badge}</Card.Action>}
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-2xl font-semibold leading-tight tracking-tight tabular-nums">
            <span aria-hidden>{text}</span>
            <span className="sr-only">{formatted.spoken}</span>
          </p>
          {change === undefined ? null : (
            <p className="text-xs flex items-start gap-1 text-muted-foreground tabular-nums">
              <Trend aria-hidden className="mt-px size-3.5 shrink-0" />
              {/* One text run beside the icon, so a narrow card wraps the sentence, not its parts. */}
              <span id={id}>{change.text}</span>
            </p>
          )}
          {note === undefined ? null : <p className="text-xs text-muted-foreground">{note}</p>}
        </div>
        <Sparkline
          aria-label={trendLabel}
          data={trend}
          format={format}
          locale={locale}
          variant={trendVariant}
          emphasis="last"
          className="h-10 w-full"
        />
      </Card.Content>
    </Card.Root>
  );
}
