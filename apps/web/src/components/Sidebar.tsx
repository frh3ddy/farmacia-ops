import { NAV_SECTIONS } from "../lib/navigation";

type SidebarProps = {
  activeItem: string;
  onSelect: (itemId: string) => void;
};

export function Sidebar({ activeItem, onSelect }: SidebarProps) {
  return (
    <nav className="sticky top-0 h-screen w-60 shrink-0 overflow-y-auto border-r border-(--color-border-standard) bg-(--color-canvas) py-4">
      <div className="px-4 pb-4">
        <span className="text-sm font-semibold tracking-tight text-(--color-ink)">Farmacia Ops</span>
      </div>
      {NAV_SECTIONS.map(section => {
        const isDevTools = section.id === "dev-tools";
        return (
          <div
            key={section.id}
            className={`mb-5 px-2 ${isDevTools ? "border-t border-dashed border-(--color-border-standard) pt-4" : ""}`}
          >
            <div
              className={`flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide ${
                isDevTools ? "text-(--color-warning)" : "text-(--color-ink-muted)"
              }`}
            >
              {isDevTools && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
              {section.label}
            </div>
            <ul>
              {section.items.map(item => {
                const isActive = item.id === activeItem;
                return (
                  <li key={item.id}>
                    <button
                      onClick={() => onSelect(item.id)}
                      className={`w-full rounded-sm px-2 py-1.5 text-left text-sm transition-colors ${
                        isActive
                          ? isDevTools
                            ? "bg-(--color-warning) text-(--color-accent-contrast)"
                            : "bg-(--color-accent) text-(--color-accent-contrast)"
                          : "text-(--color-ink-secondary) hover:bg-(--color-surface)"
                      }`}
                    >
                      {item.label}
                      {item.status === "planned" && !isActive && (
                        <span className="ml-1.5 text-[10px] text-(--color-ink-muted)">soon</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
