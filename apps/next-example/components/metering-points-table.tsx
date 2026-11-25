"use client";
// Metering points, ported from Fuse's app-shell block (metering-points-page.tsx at Fuse 9be80460): a DataTable of all
// 480 points with a search box, a DataTableFilter bar over price area, status, contract and annual use, sortable
// columns, pages, and row selection with a bulk action. Each row carries a Sparkline of its last 30 days.
//
// A client component: it translates (`useT`, `t.from`) and formats (`useFormat`) in the browser, again on every search
// and selection, and its counts are ICU plurals.
//
// The search is the table's global filter and the bar sets its column filters, so both narrow the same rows and the
// bar's counts follow the search. The bulk actions act on the selected points that pass the current filters; a
// selected point a filter hides stays selected until a filter change shows it again.
import { useDeferredValue, useMemo, useRef, useState } from "react";

import {
  columnFacetingFeature,
  columnFilteringFeature,
  createFacetedMinMaxValues,
  createFacetedRowModel,
  createFacetedUniqueValues,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_alphanumericCaseSensitive,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  sortFn_textCaseSensitive,
  tableFeatures,
} from "@tanstack/react-table";

import { Badge } from "@elmeragroup/fuse/badge";
import { Button } from "@elmeragroup/fuse/button";
import { Sparkline } from "@elmeragroup/fuse/chart";
import { createFuseTableHook, selectColumn } from "@elmeragroup/fuse/data-table";
import {
  createDataTableFilterFn,
  DataTableFilter,
  defineFilterFields,
} from "@elmeragroup/fuse/data-table-filter";
import { Empty } from "@elmeragroup/fuse/empty";
import {
  Circle,
  Contract,
  Download,
  Lightning,
  MagnifyingGlass,
  MapPin,
  PaperPlaneTilt,
  X,
} from "@elmeragroup/fuse/icons";
import { InputGroup } from "@elmeragroup/fuse/input-group";
import { Toast } from "@elmeragroup/fuse/toast";
import { Plural, T, useFormat, useIntl, useT } from "@elmeragroup/intl/react";

import { CONTRACT_TYPES, PRICE_AREAS, TIME_ZONE } from "../data/market";
import { last30Days, METERING_POINT_STATUSES, METERING_POINTS } from "../data/metering-points";
import type { MeteringPoint, MeteringPointStatus } from "../data/metering-points";
import { fuseLocale } from "../intl/locale";
import { CONTRACT_LABELS, PRICE_AREA_NAMES, STATUS_LABELS } from "../intl/messages";
import { APP_PAGE_BY_ID } from "./app-config";
import { PageHeader } from "./page-header";
import { useHydrated } from "./use-hydrated";

// One time zone for every comparison, the market's, as a server would use.
const dataTableFilter = createDataTableFilterFn({ timeZone: TIME_ZONE });

const { useAppTable, createAppColumnHelper } = createFuseTableHook({
  features: tableFeatures({
    columnFilteringFeature,
    columnFacetingFeature,
    globalFilteringFeature,
    rowSortingFeature,
    rowSelectionFeature,
    rowPaginationFeature,
    filteredRowModel: createFilteredRowModel(),
    facetedRowModel: createFacetedRowModel(),
    facetedUniqueValues: createFacetedUniqueValues(),
    facetedMinMaxValues: createFacetedMinMaxValues(),
    sortedRowModel: createSortedRowModel(),
    paginatedRowModel: createPaginatedRowModel(),
    filterFns: { dataTableFilter },
    // The built-in sorts, registered by name: `sortFn: "datetime"` and the columns' automatic sort pick from these.
    sortFns: {
      alphanumeric: sortFn_alphanumeric,
      alphanumericCaseSensitive: sortFn_alphanumericCaseSensitive,
      basic: sortFn_basic,
      datetime: sortFn_datetime,
      text: sortFn_text,
      textCaseSensitive: sortFn_textCaseSensitive,
    },
  }),
  defaultColumn: { filterFn: "dataTableFilter" },
  getRowId: (point: MeteringPoint) => point.id,
});

// Each status's badge tone.
const STATUS_BADGES = {
  active: "soft-success",
  onboarding: "soft-info",
  "moving-out": "soft-warning",
  disconnected: "muted",
} as const satisfies Readonly<Record<MeteringPointStatus, string>>;

const KWH = { preset: "energy", unit: "kWh", maximumFractionDigits: 1 } as const;

const columns = createAppColumnHelper<MeteringPoint>();

// The customer and where the point is: one message, so a translator orders the address and the translated price area.
function CustomerCell({ point }: { readonly point: MeteringPoint }) {
  const t = useT();

  return (
    <span className="flex min-w-0 flex-col">
      <span className="font-medium truncate">{point.customer}</span>
      <span className="text-xs truncate text-muted-foreground">
        {t("{address}, {city} · {area}", {
          address: point.address,
          city: point.city,
          area: t.from(PRICE_AREA_NAMES[point.priceArea]),
        })}
      </span>
    </span>
  );
}

function StatusBadge({ status }: { readonly status: MeteringPointStatus }) {
  const t = useT();

  return (
    <Badge size="sm" variant={STATUS_BADGES[status]}>
      {t.from(STATUS_LABELS[status])}
    </Badge>
  );
}

function ContractText({ point }: { readonly point: MeteringPoint }) {
  return useT().from(CONTRACT_LABELS[point.contract]);
}

// A row's history is drawn when the row renders, not for every point the page holds.
function Last30Days({ point }: { readonly point: MeteringPoint }) {
  const t = useT();
  const readings = useMemo(() => last30Days(point), [point]);

  return (
    <Sparkline
      aria-label={t("Consumption per day, last 30 days, {customer}", { customer: point.customer })}
      data={readings}
      format={KWH}
      locale={fuseLocale(useIntl().locale)}
      emphasis="last"
      data-hover="none"
      data-intro="none"
      className="h-7 w-28"
    />
  );
}

// Every column but the selection's, whose checkbox labels need the translator.
const DATA_COLUMNS = [
  columns.accessor("customer", {
    header: ({ header }) => (
      <header.SortButton>
        <T>Customer</T>
      </header.SortButton>
    ),
    enableColumnFilter: false,
    cell: ({ row }) => <CustomerCell point={row.original} />,
  }),
  columns.accessor("id", {
    header: () => <T>Metering point</T>,
    enableColumnFilter: false,
    cell: ({ row }) => (
      <span className="text-xs font-mono text-muted-foreground tabular-nums">{row.original.id}</span>
    ),
  }),
  columns.accessor("priceArea", {
    header: ({ header }) => (
      <header.SortButton>
        <T>Area</T>
      </header.SortButton>
    ),
    cell: ({ cell }) => <cell.TextCell />,
  }),
  columns.accessor("status", {
    header: () => <T>Status</T>,
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  }),
  columns.accessor("contract", {
    header: () => <T>Contract</T>,
    cell: ({ row }) => <ContractText point={row.original} />,
  }),
  columns.accessor("annualKwh", {
    // Amounts line up on their last digit, so the header and the figures sit at the end.
    header: ({ header }) => (
      <span className="flex justify-end">
        <header.SortButton>
          <T>Annual use (kWh)</T>
        </header.SortButton>
      </span>
    ),
    cell: ({ cell }) => (
      <span className="block text-right">
        <cell.NumberCell maximumFractionDigits={0} />
      </span>
    ),
  }),
  columns.display({
    id: "last30Days",
    header: () => <T>Last 30 days</T>,
    cell: ({ row }) => <Last30Days point={row.original} />,
  }),
] as const;

// The search's words, lowercased in the page's language.
function searchWords(query: string, locale: string): ReadonlyArray<string> {
  return query
    .trim()
    .toLocaleLowerCase(locale)
    .split(/\s+/u)
    .filter((word) => word !== "");
}

// Whether a point's name, address, city or id holds every word of the search.
function matchesSearch(point: MeteringPoint, words: ReadonlyArray<string>, locale: string): boolean {
  const haystack = `${point.customer} ${point.address} ${point.city} ${point.id}`.toLocaleLowerCase(locale);

  return words.every((word) => haystack.includes(word));
}

// What sending reading reminders to `count` customers says. Nodes, not strings: a toast outlives a language switch,
// and `<T>` renders in the language the provider has now.
function readingRemindersToast(count: number) {
  return {
    type: "success",
    title: <T>Reading reminders sent</T>,
    description: (
      <T>
        <Plural count={count} one="# customer gets a reminder" other="# customers get a reminder" /> to read
        their meter.
      </T>
    ),
  } as const;
}

// One CSV field, quoted.
function quote(value: string | number): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

// A CSV file of the rows, downloaded under `name`.
function downloadCsv(rows: ReadonlyArray<ReadonlyArray<string | number>>, name: string): void {
  const csv = rows.map((row) => row.map((value) => quote(value)).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // The download has started once the click returns; the next task can let the file go.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

// The table's rows: one stable array, so TanStack never rebuilds its row models for a search.
const POINTS = [...METERING_POINTS];

/** The metering points page: its header, the search, the filters, the table and the bulk actions. */
export function MeteringPointsTable() {
  const t = useT();
  const format = useFormat();
  const { locale } = useIntl();
  // The search takes input once React has hydrated the page: text typed into the server's HTML before then would be
  // lost when React takes the input over.
  const hydrated = useHydrated();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  // The search's words, once per query and language, not once per row.
  const words = useMemo(() => searchWords(deferredQuery, locale), [deferredQuery, locale]);
  const toasts = Toast.useToastManager();
  const list = useRef<HTMLDivElement>(null);
  const page = APP_PAGE_BY_ID["metering-points"];

  // The filter bar's fields, in the visitor's language.
  const filters = useMemo(
    () =>
      defineFilterFields<MeteringPoint>()({
        priceArea: {
          kind: "option",
          label: t("Price area"),
          icon: <MapPin />,
          options: PRICE_AREAS.map((area) => ({
            value: area,
            label: t("{area} {name}", { area, name: t.from(PRICE_AREA_NAMES[area]) }),
          })),
        },
        status: {
          kind: "option",
          label: t("Status"),
          icon: <Circle />,
          options: METERING_POINT_STATUSES.map((status) => ({
            value: status,
            label: t.from(STATUS_LABELS[status]),
          })),
          order: "count",
        },
        contract: {
          kind: "option",
          label: t("Contract"),
          icon: <Contract />,
          options: CONTRACT_TYPES.map((contract) => ({
            value: contract,
            label: t.from(CONTRACT_LABELS[contract]),
          })),
        },
        annualKwh: {
          kind: "number",
          label: t("Annual use, kWh"),
          icon: <Lightning />,
          format: { maximumFractionDigits: 0 },
          step: 500,
        },
      }),
    [t]
  );

  // The CSV's header row and one row per point, in the visitor's language.
  function csvRows(points: ReadonlyArray<MeteringPoint>): ReadonlyArray<ReadonlyArray<string | number>> {
    return [
      [
        t("Metering point"),
        t("Customer"),
        t("Address"),
        t("City"),
        t("Price area"),
        t("Status"),
        t("Contract"),
        t("Annual use (kWh)"),
      ],
      ...points.map((point) => [
        point.id,
        point.customer,
        point.address,
        point.city,
        point.priceArea,
        t.from(STATUS_LABELS[point.status]),
        t.from(CONTRACT_LABELS[point.contract]),
        point.annualKwh,
      ]),
    ];
  }

  // Both bulk actions empty the visible selection, which takes the toolbar, or its enabled buttons, away from under the
  // focus. Focus moves first to the table's select-all checkbox, which stays.
  function focusSelectAll(): void {
    list.current?.querySelector<HTMLElement>('[data-slot="data-table-select-all"]')?.focus();
  }

  const tableColumns = useMemo(
    () =>
      columns.columns([
        selectColumn(columns, {
          getRowLabel: (point) =>
            t("Select {customer}, {address}", { customer: point.customer, address: point.address }),
        }),
        ...DATA_COLUMNS,
      ]),
    [t]
  );
  const table = useAppTable({
    columns: tableColumns,
    // The whole portfolio, always: search and the bar filter it, so every point keeps its row and its selection
    // whatever hides it.
    data: POINTS,
    state: { globalFilter: deferredQuery },
    // One search over each row's name, address, city and GSRN. The table runs the global filter once per column it
    // allows, and this one reads the whole row, so it runs on one column only: once per row, not once per row and
    // column.
    getColumnCanGlobalFilter: (column) => column.id === "customer",
    globalFilterFn: (row) => matchesSearch(row.original, words, locale),
    initialState: {
      pagination: { pageIndex: 0, pageSize: 25 },
      sorting: [{ id: "customer", desc: false }],
    },
  });
  const shown = table.getFilteredRowModel().rows.map((row) => row.original);
  // What the bulk actions act on: the selected points that pass the search and the bar's filters.
  const selected = table.getFilteredSelectedRowModel().rows.map((row) => row.original);
  const hidden = table.getSelectedRowModel().rows.length - selected.length;
  const annualKwh = shown.reduce((total, point) => total + point.annualKwh, 0);

  return (
    <>
      <PageHeader title={t.from(page.label)} description={t.from(page.description)}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            downloadCsv(csvRows(shown), "metering-points.csv");
          }}>
          <Download data-icon="inline-start" />
          {t("Export {count, plural, one {# point} other {# points}}", { count: shown.length })}
        </Button>
      </PageHeader>
      <table.AppTable>
        <DataTableFilter.Root table={table} fields={filters} timeZone={TIME_ZONE}>
          <div ref={list} className="md:px-6 flex min-w-0 flex-col gap-3 px-4 pt-2 pb-8">
            {/* One row at every width: the search takes the room on a phone, the chips on desktop. */}
            <div className="flex items-center gap-2">
              <InputGroup.Root className="min-w-0 flex-2 min-[48rem]:w-72 min-[48rem]:flex-none">
                <InputGroup.Addon>
                  <MagnifyingGlass aria-hidden />
                </InputGroup.Addon>
                <InputGroup.Input
                  type="search"
                  aria-label={t("Search metering points")}
                  placeholder={t("Name, address or metering point")}
                  disabled={!hydrated}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                />
              </InputGroup.Root>
              <DataTableFilter.Bar aria-label={t("Metering point filters")} className="min-w-0 flex-1" />
            </div>
            <DataTableFilter.Content />
            <DataTableFilter.ValueContent />

            <p role="status" id="points-count" className="text-sm text-muted-foreground tabular-nums">
              {shown.length === METERING_POINTS.length
                ? t("{count, plural, one {# metering point} other {# metering points}}", {
                    count: shown.length,
                  })
                : t("{count, plural, one {# metering point} other {# metering points}} of {total, number}", {
                    count: shown.length,
                    total: METERING_POINTS.length,
                  })}{" "}
              <span id="points-annual">
                {t("· {annual} kWh a year", {
                  annual: format.number(annualKwh, { maximumFractionDigits: 0 }),
                })}
              </span>
            </p>

            <table.Content
              aria-label={t.from(page.label)}
              empty={
                <Empty.Root>
                  <Empty.Header>
                    <Empty.Media variant="icon">
                      <MagnifyingGlass />
                    </Empty.Media>
                    <Empty.Title>
                      <T>No metering points match</T>
                    </Empty.Title>
                    <Empty.Description>
                      <T>Try another name or address, or take a filter away.</T>
                    </Empty.Description>
                  </Empty.Header>
                  <Empty.Content>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setQuery("");
                        table.resetColumnFilters();
                      }}>
                      <T>Clear search and filters</T>
                    </Button>
                  </Empty.Content>
                </Empty.Root>
              }
            />
            {/* The bulk actions float at the foot of the table while rows are selected, so they stay in reach however
                far the list has scrolled. */}
            {selected.length + hidden === 0 ? null : (
              <div
                role="toolbar"
                aria-label={t("Selected metering points")}
                className="text-sm shadow-lg sticky bottom-4 z-10 flex max-w-full flex-wrap items-center gap-2 self-center rounded-xl bg-popover py-2 ps-4 pe-2 text-popover-foreground ring-1 ring-border">
                <span role="status" id="points-selected" className="me-2 tabular-nums">
                  <span className="font-medium">
                    {t("{count, plural, one {# point selected} other {# points selected}}", {
                      count: selected.length,
                    })}
                  </span>
                  {hidden === 0 ? null : (
                    <span className="text-muted-foreground">
                      {" "}
                      {t(
                        "· {count, plural, one {# more hidden by filters} other {# more hidden by filters}}",
                        {
                          count: hidden,
                        }
                      )}
                    </span>
                  )}
                </span>
                <Button
                  size="sm"
                  disabled={selected.length === 0}
                  onClick={() => {
                    toasts.add(readingRemindersToast(selected.length));
                    // The points the action reached leave the selection; hidden ones stay for later.
                    const reached = new Set(selected.map((point) => point.id));
                    focusSelectAll();
                    table.setRowSelection((current) =>
                      Object.fromEntries(Object.entries(current).filter(([id]) => !reached.has(id)))
                    );
                  }}>
                  <PaperPlaneTilt data-icon="inline-start" />
                  <T>Send reading reminder</T>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={selected.length === 0}
                  onClick={() => {
                    downloadCsv(csvRows(selected), "selected-metering-points.csv");
                  }}>
                  <Download data-icon="inline-start" />
                  <T>Export</T>
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("Clear selection")}
                  onClick={() => {
                    focusSelectAll();
                    table.resetRowSelection();
                  }}>
                  <X />
                </Button>
              </div>
            )}
            <table.Pagination pageSizes={[10, 25, 50, 100]} />
          </div>
        </DataTableFilter.Root>
      </table.AppTable>
    </>
  );
}
