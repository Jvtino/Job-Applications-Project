import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapTab(e: KeyboardEvent, container: HTMLElement | null) {
  if (!container) return;
  const nodes = container.querySelectorAll<HTMLElement>(FOCUSABLE);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Right-side detail drawer. Portaled to <body> so the .apx-fade transform ancestor never re-anchors
 * it (see redesign.css note). Handles Escape, scrim click, scroll lock, focus trap, and focus return.
 * Read-only by design: a drawer shows a record, it does not trigger pipeline actions.
 */
export function Drawer({
  open,
  onClose,
  title,
  eyebrow,
  subtitle,
  badge,
  actions,
  footer,
  width = 560,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  eyebrow?: string;
  subtitle?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
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
      } else if (e.key === "Tab") {
        trapTab(e, panelRef.current);
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
        className="apx-overlay is-drawer"
        role="presentation"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          ref={panelRef}
          className="apx-drawer"
          style={{ width: `min(${width}px, 94vw)` }}
          role="dialog"
          aria-modal="true"
          aria-label={typeof title === "string" ? title : "Detail"}
          tabIndex={-1}
        >
          <header className="apx-drawer-head">
            <div className="apx-drawer-titles">
              {eyebrow ? <p className="apx-eyebrow">{eyebrow}</p> : null}
              <div className="apx-drawer-titlerow">
                {title ? <h2 className="apx-drawer-title">{title}</h2> : null}
                {badge}
              </div>
              {subtitle ? <p className="apx-drawer-sub">{subtitle}</p> : null}
            </div>
            <button type="button" className="apx-drawer-close" onClick={onClose} aria-label="Close detail">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </header>
          {actions ? <div className="apx-drawer-actions">{actions}</div> : null}
          <div className="apx-drawer-body">{children}</div>
          {footer ? <div className="apx-drawer-foot">{footer}</div> : null}
        </div>
      </div>
    </div>,
    document.body
  );
}
