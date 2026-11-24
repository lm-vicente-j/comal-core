# Pagination

`lib/pagination` is the server-safe source of truth for list inputs, validation,
limits and metadata. `components/pagination` contains the shared client state,
request hook and responsive `DataPagination` control.

## Input and response

```ts
type PaginationOptions<Filters> = {
  page?: number;
  pageSize?: number;
  search?: string;
  filters?: Filters;
  sort?: string;
  order?: "asc" | "desc";
};

type PaginatedResult<Item> = {
  items: Item[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
};
```

Paginated actions return `ActionResult<PaginatedResult<Item>, PaginationError>`.
Domain metadata extends that payload: expenses have
`summary: { totalAmount, latestCategory }`; reports have `summary`, columns,
period, type, notices and generation time. `total` always means the number of
matching records or groups. Money remains a safe integer in cents; it never
occupies a pagination count field.

Use `createPaginationSchema` with a typed filters schema and an explicit list
of allowed sort fields. Unsupported nonempty searches or ordering must be
rejected instead of silently ignored. The default page is 1 and default size
is 10; the maximum size is 50, with UI choices 10, 20 and 50. A malformed or
nonpositive page becomes 1; a malformed or nonpositive size becomes 10; a size
above 50 becomes 50. Search is trimmed and limited to 100 characters. Invalid
search, domain filters or sort values return `INVALID_INPUT`.

Empty results have `page=1`, `total=0`, `totalPages=0` and `hasMore=false`.
Out-of-range pages clamp to the last existing page. Use `getPaginationMeta`
and `getPaginationOffset`, rather than repeating those calculations.

Authenticate and authorize every Server Action. Failures use
`UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_INPUT` or `QUERY_FAILED`; they never
become a successful empty page. Read the count, clamped page and related
aggregates in a `RepeatableRead` transaction. Apply the same search and filters
to rows and counts, and sort before applying `take`/`skip` or SQL
`LIMIT`/`OFFSET`. Always include a unique ID as a final ordering key. Preserve
the Spanish customer-name collation and null placement where applicable.
Deterministic ordering does not freeze a dataset between separate requests;
an intervening write can move rows, and refreshing reclamps the active page.

## POST transport and navigation

All list reads use Next.js Server Actions invoked by the client: parameters
travel in the POST body. Routes remain clean, such as `/debtors`,
`/admin/crm`, `/admin/savings`, `/admin/roster` and `/admin/reports`.
There are no pagination GET endpoints or query-string parsers. For example:

```ts
getSalaryHistory({ page: 2, pageSize: 10, filters: { userId: 17 } });
getReport({
  page: 2,
  pageSize: 20,
  filters: { type: "sales", from: "2026-11-01", to: "2026-11-24" },
});
```

`usePaginationState` stores route-local state in `history.state` and
`sessionStorage`, supporting reload and browser Back/Forward without encoding
filters in a URL. A copied link opens the destination's initial or locally
saved view; it does not transfer a filtered page to another browser. Contextual
statistics-to-report links use `preparePaginationNavigation` to transfer the
period and report type locally.

Changes to search, filters, sort, size or employee reset page 1. Search replaces
the current history entry and requests debounce for 300 ms. Other explicit
navigation pushes a history entry. CRM uses `customers`/`staff` tabs; Savings
uses `pool`/`goals`. Changing a tab clears list criteria and retains page size.

`usePaginatedResource` sends the action request, ignores obsolete responses,
handles page clamping and listens for application auto-refresh ticks. Mutation
success handlers must call its `refresh()` explicitly; `router.refresh()` alone
does not invalidate client-owned list data. Show `PaginationErrorState` on
failure and avoid presenting a loading or failed query as an empty dataset.
`DataPagination` owns desktop and mobile controls, sizes and accessible pending
states. TanStack tables consume server pagination and do not sort/filter a
single returned page as if it were the full dataset.

## Consumer inventory and exceptions

| Consumer | Pagination and aggregate policy |
| --- | --- |
| Debtors | Server pages of active debtors, with debt aggregation restricted to page IDs. Global debt summary remains independent of search and page. |
| CRM customers/staff | Server pages for the active tab; authenticated ADMIN DTOs and customer collation preserved. |
| Menu | Server product pages and POST-paginated supply picker; existing recipe choices persist across searches. |
| Inventory | Server pages of active supplies; stock filter is applied before counting and pagination. |
| Expenses | Server pages replace infinite scroll. `summary.totalAmount` and latest category retain their existing global meaning. |
| Payroll | Server pages filtered by employee; employee picker uses its own bounded server pages and keeps the selected employee independently. |
| Savings movements | Server pages replace infinite scroll; pool totals remain global. |
| Savings goals | Server pages filtered by `ACTIVE` (default), `inactive` or `all`; progress includes all contributions for each visible goal. |
| Reports | Server pages of records or groups, counted after grouping. Period-wide summaries and notices are calculated before limiting rows. |
| Statistics customers | Server pages of customer aggregates; other statistics remain full-period aggregates. |

POS and Jornada are explicitly outside this migration, including their complete
operational snapshots, account calculations and existing selector actions.
Complete debt-account and sale-item reads used to confirm an individual payment
are also operational detail snapshots, rather than independently navigable
record lists. Single-entity detail reads do not paginate.

The recipe picker keeps its pagination state local to the editor and reads
active supplies through the shared POST contract. Selected inactive supplies
remain available from the existing recipe details. Charts, bounded rankings and financial summaries are aggregates,
not independent paginated lists. Statistics still computes its full-period
charts from a consistent snapshot; the client table does not receive the full
customer list.

Report CSV/print uses `getReportExport({ from, to, type })` with a separate
unpaginated `ReportData` result. It includes every matching row and the full
totals, preserving CSV formula sanitization. Do not simulate an export by
increasing `pageSize` or attaching misleading pagination metadata.

New growing lists must use the shared contract, schema, request hook and UI.
Add any intentional exception to this inventory with its reason.
