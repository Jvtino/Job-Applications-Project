import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Centered modal dialog. Portaled to <body> (same containing-block reason as Drawer). Escape + scrim
 * close, scroll lock, focus to the panel. Used for focused confirm/detail flows.
 */
export function Modal({
  open,
  onClose,
  title,
  eyebrow,
  actions,
  width = 480,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  eyebrow?: string;
  actions?: ReactNode;
  width?: number;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => panelRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="apx">
      <div
        className="apx-overlay is-modal"
        role="presentation"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          ref={panelRef}
          className="apx-modal"
          style={{ width: `min(${width}px, 94vw)` }}
          role="dialog"
          aria-modal="true"
          aria-label={typeof title === "string" ? title : "Dialog"}
          tabIndex={-1}
        >
          {(title || eyebrow) && (
            <header className="apx-modal-head">
              {eyebrow ? <p className="apx-eyebrow">{eyebrow}</p> : null}
              {title ? <h2 className="apx-modal-title">{title}</h2> : null}
            </header>
          )}
          <div className="apx-modal-body">{children}</div>
          {actions ? <div className="apx-modal-actions">{actions}</div> : null}
        </div>
      </div>
    </div>,
    document.body
  );
}
