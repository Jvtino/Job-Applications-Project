import { useMemo, useState, type ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Return a comparable value to make the column sortable. Omit for a non-sortable column. */
  sortValue?: (row: T) => string | number;
  render: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  width?: string;
  /** Extra class on the <td>, e.g. for truncation. */
  cellClassName?: string;
}

function cmp(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Generic table with sortable headers (keyboard accessible), optional row click to a detail view,
 * and a sticky header that survives 100+ rows inside a scroll container. Long values truncate via the
 * column's cellClassName (use "apx-td-ellipsis"). Read-only: clicking a row opens detail, never acts.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  onRowClick,
  initialSort,
  empty,
  dense,
  maxHeight,
  rowClassName,
}: {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  initialSort?: { key: string; dir: "asc" | "desc" };
  empty?: ReactNode;
  dense?: boolean;
  maxHeight?: number;
  rowClassName?: (row: T) => string | undefined;
}) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(initialSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    const getVal = col.sortValue;
    return [...rows].sort((a, b) => cmp(getVal(a), getVal(b)) * dir);
  }, [rows, sort, columns]);

  if (!rows.length && empty) return <>{empty}</>;

  const toggleSort = (key: string) =>
    setSort((cur) => (cur?.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  return (
    <div className="apx-table-wrap" style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}>
      <table className={`apx-table${dense ? " is-dense" : ""}`}>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const ariaSort: "ascending" | "descending" | undefined = active
                ? sort!.dir === "asc"
                  ? "ascending"
                  : "descending"
                : undefined;
              return (
                <th
                  key={c.key}
                  style={c.width ? { width: c.width } : undefined}
                  className={c.align ? `is-${c.align}` : undefined}
                  aria-sort={ariaSort}
                >
                  {c.sortValue ? (
                    <button type="button" className="apx-th-sort" onClick={() => toggleSort(c.key)}>
                      {c.header}
                      <span className={`apx-sort-ind${active ? " is-active" : ""}`} aria-hidden="true">
                        {active ? (sort!.dir === "asc" ? "↑" : "↓") : "↕"}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => {
            const clickable = Boolean(onRowClick);
            return (
              <tr
                key={getRowKey(row, i)}
                className={[clickable ? "is-row-clickable" : "", rowClassName?.(row) ?? ""].filter(Boolean).join(" ") || undefined}
                tabIndex={clickable ? 0 : undefined}
                role={clickable ? "button" : undefined}
                onClick={clickable ? () => onRowClick!(row) : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRowClick!(row);
                        }
                      }
                    : undefined
                }
              >
                {columns.map((c) => (
                  <td key={c.key} className={[c.align ? `is-${c.align}` : "", c.cellClassName ?? ""].filter(Boolean).join(" ") || undefined}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
