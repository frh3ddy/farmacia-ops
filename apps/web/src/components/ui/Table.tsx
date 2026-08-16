import type { ReactNode } from "react";

export type Column<T> = {
  key: keyof T;
  header: string;
  align?: "left" | "right";
  render?: (value: T[keyof T], item: T) => ReactNode;
};

type TableProps<T> = {
  data: T[];
  columns: Column<T>[];
  keyExtractor: (item: T, index: number) => string;
  emptyMessage?: string;
  onRowClick?: (item: T) => void;
  isRowSelected?: (item: T) => boolean;
};

export function Table<T>({
  data,
  columns,
  keyExtractor,
  emptyMessage = "No records.",
  onRowClick,
  isRowSelected,
}: TableProps<T>) {
  if (data.length === 0) {
    return <p className="py-6 text-sm text-(--color-ink-tertiary)">{emptyMessage}</p>;
  }

  return (
    <div className="overflow-x-auto rounded-md border border-(--color-border-standard)">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-(--color-border-standard) bg-(--color-surface)">
            {columns.map((col, i) => (
              <th
                key={i}
                className={`px-3 py-2 font-medium text-(--color-ink-secondary) ${col.align === "right" ? "text-right" : "text-left"}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((item, rowIndex) => {
            const selected = isRowSelected?.(item) ?? false;
            return (
              <tr
                key={keyExtractor(item, rowIndex)}
                onClick={onRowClick ? () => onRowClick(item) : undefined}
                className={`border-b border-(--color-border-subtle) last:border-b-0 hover:bg-(--color-surface) ${
                  onRowClick ? "cursor-pointer" : ""
                } ${selected ? "bg-(--color-accent)/5" : ""}`}
              >
                {columns.map((col, i) => (
                  <td
                    key={i}
                    className={`px-3 py-2 text-(--color-ink) ${col.align === "right" ? "text-right" : "text-left"}`}
                  >
                    {col.render ? col.render(item[col.key], item) : String(item[col.key] ?? "-")}
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
