"use client";

/**
 * Corner radii, so the app looks like one thing:
 * covers 3px · small bars and steppers `rounded` (4px) · buttons, fields and rows `rounded-lg` (8px)
 * · cards, panels, menus and the sidebar `rounded-2xl` (16px) · modal sheets 28px · pills and round buttons `rounded-full`.
 */
/** Shared building blocks: icons, menus, modal sheet and the class strings that keep the app uniform. */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const ICONS = {
  x: "M6 6l12 12M18 6 6 18",
  chevronLeft: "M15 5l-7 7 7 7",
  chevronRight: "M9 5l7 7-7 7",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.5 15.5 21 21",
  home: "M4 10.5 12 4l8 6.5V20h-5.500v-5.500h-5V20H4Z",
  headphones:
    "M4 15v-3a8 8 0 0 1 16 0v3M4 14.500h2.500V20H6a2 2 0 0 1-2-2ZM20 14.500h-2.500V20H18a2 2 0 0 0 2-2Z",
  shelf: "M4 5h4v15H4ZM8 8h4v12H8ZM13.500 6.500l3.500-1 3.500 13.500-3.500 1Z",
  want: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8 12h8M13 9l3 3-3 3",
  minus: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8 12h8",
  finished: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8 12.500l2.700 2.700L16 9.500",
  book: "M12 7C10 5.500 7 5 3 5.500V18c4-.5 7 0 9 1.500 2-1.500 5-2 9-1.500V5.500C17 5 14 5.500 12 7ZM12 7v12.500",
  doc: "M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM14 3v5h5M9 13h6M9 16.500h6",
  lines: "M4 7h16M4 12h16M4 17h16",
  plus: "M12 5v14M5 12h14",
  chevronDown: "M6 9l6 6 6-6",
  check: "M5 12.500l4.500 4.500L19 7",
  grid: "M5 5h5v5H5ZM14 5h5v5h-5ZM5 14h5v5H5ZM14 14h5v5h-5Z",
  list: "M9 7h11M9 12h11M9 17h11M4.500 7h.01M4.500 12h.01M4.500 17h.01",
  trash: "M5 7h14M10 7V4.500h4V7M7 7l1 13h8l1-13",
  star: "M12 3.500l2.600 5.400 5.900.8-4.300 4.100 1 5.900L12 16.900l-5.200 2.800 1-5.900L3.500 9.700l5.900-.8Z",
  settings: "M4 7h10M18 7h2M4 17h2M10 17h10M16 5v4M8 15v4",
  import: "M12 4v10M8 10l4 4 4-4M5 18h14",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.500 9.500a2.500 2.500 0 1 1 3.500 2.300c-.7.4-1 .9-1 1.700M12 16.500h.01",
  logout: "M10 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4M14 8l4 4-4 4M18 12H9",
  tag: "M4 4h7l9 9-7 7-9-9ZM8 8h.01",
  play: "M7 5v14l12-7Z",
  pause: "M8 5v14M16 5v14",
  moon: "M20 14.500A8 8 0 0 1 9.500 4a8 8 0 1 0 10.500 10.500Z",
  chart: "M5 20V10M12 20V4M19 20v-7",
  pencil: "M4 20h4L19 9l-4-4L4 16ZM13.500 6.500l4 4",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.500 20a7.500 7.500 0 0 1 15 0",
  people:
    "M9 12a3.500 3.500 0 1 0 0-7 3.500 3.500 0 0 0 0 7ZM2.500 19.500a6.500 6.500 0 0 1 13 0M16 5.200a3.500 3.500 0 0 1 0 6.600M17.500 14.300a6.500 6.500 0 0 1 4 5.200",
  cloud:
    "M7 18a4 4 0 0 1-.5-7.970A5.500 5.500 0 0 1 17.200 9.500 4.300 4.300 0 0 1 17 18Z",
  cloudDown:
    "M7 18a4 4 0 0 1-.5-7.970A5.500 5.500 0 0 1 17.200 9.500 4.300 4.300 0 0 1 17 18M12 10.500v6M9.700 14.300 12 16.600l2.300-2.300",
  cloudDone:
    "M7 18a4 4 0 0 1-.5-7.970A5.500 5.500 0 0 1 17.200 9.500 4.300 4.300 0 0 1 17 18M9.300 13.800l2 2 3.600-4",
  bookmark: "M7 4h10v16l-5-4-5 4Z",
  text: "M5 19 10.500 6h1L17 19M7.500 14h7M19 9v10M16.500 11.500h5",
  highlight: "M5 19h14M8 15l-1-4 8-7 4 4-7 8ZM11 6.500l5 5",
  panels: "M4 4h7v9H4ZM13 4h7v5h-7ZM13 11h7v9h-7ZM4 15h7v5H4Z",
  skip: "M5.200 9.500A7.500 7.500 0 1 1 4.500 13M5.200 9.500V5M5.200 9.500h4.500",
  volume: "M4 9.500v5h3.500L12 18.500v-13L7.500 9.500ZM15.500 9a4 4 0 0 1 0 6M18 6.500a7.500 7.500 0 0 1 0 11",
  chevronUp: "M6 15l6-6 6 6",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
  eye: "M2 12s3.600-7 10-7 10 7 10 7-3.600 7-10 7-10-7-10-7ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  eyeOff:
    "M2 12s3.600-7 10-7 10 7 10 7-3.600 7-10 7-10-7-10-7ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4 4l16 16",
};
export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  className = "size-[22px]",
  fill = "none",
  strokeWidth = 1.7,
}: {
  name: IconName;
  className?: string;
  fill?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

const PETAL =
  "M0 0C-5-13-23-21-22-37C-21-50 21-50 22-37C23-21 5-13 0 0ZM0-9C-2-15-9-20-8.500-28C-8-35 8-35 8.500-28C9-20 2-15 0-9Z";
/** The Sonnet flower, in the colour of the text around it. The same drawing as app/icon.svg. */
export function Logo({ className }: { className: string }) {
  return (
    <svg viewBox="-64 -64 128 128" className={className} fill="currentColor" aria-hidden>
      <g transform="scale(1.2)">
        {[8, 80, 152, 224, 296].map((turn) => (
          <path key={turn} transform={`rotate(${turn}) skewX(-14)`} fillRule="evenodd" d={PETAL} />
        ))}
      </g>
    </svg>
  );
}

export const DOTS = (
  <svg viewBox="0 0 18 6" className="w-[18px]" fill="currentColor" aria-hidden>
    <circle cx="3" cy="3" r="1.7" />
    <circle cx="9" cy="3" r="1.7" />
    <circle cx="15" cy="3" r="1.7" />
  </svg>
);

/**
 * Button that toggles a floating menu; any click inside or outside the menu closes it.
 * The menu is placed against the window, not the page: below the button or above it, lined up
 * with its left or right edge, wherever it fits. It never adds space to scroll and is never cut
 * off by a scrolling row. Only the width in `panelClass` matters.
 */
export function Popover({
  label,
  button,
  buttonClass,
  panelClass,
  children,
}: {
  label: string;
  button: ReactNode;
  buttonClass: string;
  panelClass: string; // width
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<React.CSSProperties>({ visibility: "hidden" });
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !anchor.current || !panel.current) return;
    const b = anchor.current.getBoundingClientRect();
    const p = panel.current.getBoundingClientRect();
    const gap = 4;
    const edge = 8; // kept clear of the window's edges
    const below = window.innerHeight - b.bottom - gap - edge;
    const above = b.top - gap - edge;
    const down = p.height <= below || below >= above;
    const maxHeight = Math.max(120, down ? below : above);
    const left = b.left + p.width <= window.innerWidth - edge ? b.left : b.right - p.width;
    setAt({
      left: Math.max(edge, Math.min(left, window.innerWidth - edge - p.width)),
      top: down ? b.bottom + gap : Math.max(edge, b.top - gap - Math.min(p.height, maxHeight)),
      right: "auto",
      bottom: "auto",
      maxHeight,
    });
  }, [open]);
  return (
    <div className="relative" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button
        ref={anchor}
        aria-label={label}
        aria-expanded={open}
        onClick={() => {
          setAt({ visibility: "hidden" }); // measured, then shown in place
          setOpen(!open);
        }}
        className={buttonClass}
      >
        {button}
      </button>
      {open &&
        // On the page's top layer: a menu inside a zoomed, clipped or shifted part of the page
        // would be scaled, cut off or misplaced with it.
        createPortal(
          <>
            <div className="fixed inset-0 z-[70]" onClick={() => setOpen(false)} />
            <div
              ref={panel}
              role="menu"
              onClick={() => setOpen(false)}
              style={at}
              className={`fixed z-[70] overflow-y-auto rounded-2xl border border-white/15 bg-[#222] p-[5px] font-sans font-normal text-[#f2f2f2] shadow-2xl ${panelClass}`}
            >
              {children}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

/** `checked` (even false) reserves the checkmark gutter so a group of items lines up. */
export function MenuItem({
  label,
  icon,
  checked,
  onClick,
}: {
  label: string;
  icon?: IconName;
  checked?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      // Taller rows and larger type on phones, where they are tapped with a finger.
      className="flex h-[25.500px] w-full items-center rounded-lg px-[6px] text-left text-[13px] hover:bg-white/10 max-md:h-[42px] max-md:px-[10px] max-md:text-[16px]"
    >
      {checked !== undefined && (
        <span className="w-[22px] max-md:w-[32px]">
          {checked && <Icon name="check" className="size-[14px] max-md:size-[19px]" strokeWidth={2.4} />}
        </span>
      )}
      {icon && (
        <span className="w-[22px] text-[#b4b4b4] max-md:w-[32px]">
          <Icon name={icon} className="size-[14px] max-md:size-[19px]" />
        </span>
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}

export const MENU_RULE = <hr className="mx-2 my-[5px] border-white/10" />;

export function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="mx-auto mt-[150px] max-w-[290px] text-center text-[#8e8e8e]">
      <h2 className="font-serif text-[21px] font-bold">{title}</h2>
      <p className="mt-[10px] text-[14.500px] leading-[18px]">{text}</p>
    </div>
  );
}

/** Modal over the blurred page (the sidebar stays usable on desktop). Escape or a click outside closes it. */
export function Sheet({
  label,
  onClose,
  className,
  children,
}: {
  label: string;
  onClose: () => void;
  className: string; // size of the content box
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={onClose}
      // Covers the whole window; the sidebar floats above it, and the sheet is centred in the space beside it.
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-2xl md:pl-[221px]"
    >
      <div onClick={(e) => e.stopPropagation()} className={`relative ${className}`}>
        {children}
      </div>
    </div>
  );
}

export const panelClass = "relative rounded-2xl bg-[#2e2e2e] md:mr-[33px]";
export const fieldClass =
  "h-[36px] w-full rounded-lg border border-white/15 bg-white/5 px-3 text-[14px] outline-none focus:border-white/50";
export const primaryClass =
  "rounded-full bg-white text-[13px] font-bold text-black hover:bg-white/85";
/** Padded body of a small modal (import, goals, edit details). */
export const sheetClass = "rounded-[28px] bg-[#2c2c2e] px-8 pt-[76px] pb-8 shadow-2xl";
/** Round close button in the top-left corner of a sheet. */
export const closeClass =
  "absolute top-5 left-5 flex size-[38px] items-center justify-center rounded-full border border-white/15 hover:bg-white/10";
/** Small secondary button, select or number field. */
export const controlClass =
  "h-[30px] shrink-0 rounded-lg bg-white/10 px-3 text-[13px] font-bold hover:bg-white/15 [&>option]:bg-[#2e2e2e]";
/** Round button that goes ahead with something that can't be undone. */
export const dangerClass =
  "rounded-full bg-[#ff453a] text-[13px] font-bold text-white hover:bg-[#ff5c52]";

type Ask = {
  title: string;
  text?: string;
  action: string; // label of the button that goes ahead
  danger?: boolean;
  input?: InputHTMLAttributes<HTMLInputElement>; // also asks for a value
};
type Asked = Ask & { done: (value: string | null) => void };
let openAsk: (asked: Asked) => void = () => {};
/**
 * The app's own confirm() and prompt(). Resolves to null when cancelled, otherwise to what was
 * typed ("" when there is no `input`).
 */
export const ask = (a: Ask) => new Promise<string | null>((done) => openAsk({ ...a, done }));

/**
 * Mounted once: draws what the browser would otherwise draw in its own style. The `ask` dialog,
 * the hover tip of anything with `data-tip`, and the message under a form field that isn't valid.
 * All in the browser's top layer, so they sit above every sheet and menu.
 */
export function Overlays() {
  const [asked, setAsked] = useState<Asked | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const close = (value: string | null) => {
    asked?.done(value);
    setAsked(null);
  };
  useEffect(() => {
    if (asked && !dialog.current?.open) dialog.current?.showModal();
  }, [asked]);
  useEffect(() => {
    openAsk = setAsked;
    const t = tip.current!;
    let timer = 0;
    let pinned = false; // an error stays until the field is edited; hovering elsewhere leaves it
    const hide = () => {
      clearTimeout(timer);
      pinned = false;
      if (t.matches(":popover-open")) t.hidePopover();
    };
    /** `r`: what the tip sits under (or over, when there is no room below). */
    const show = (r: DOMRect, text: string, error: boolean) => {
      hide();
      pinned = error;
      t.textContent = text;
      t.dataset.error = String(error);
      t.showPopover(); // shown again each time, so it lands above a dialog opened since
      const w = t.offsetWidth;
      const h = t.offsetHeight;
      t.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - 8 - w))}px`;
      t.style.top = `${r.bottom + 6 + h > innerHeight ? r.top - 6 - h : r.bottom + 6}px`;
    };
    let over: HTMLElement | null | undefined;
    let quiet: HTMLElement | null | undefined = null; // has had its tip, or was clicked: no tip until the pointer returns
    const onMove = (e: MouseEvent) => {
      if (pinned) return;
      const el = (e.target as Element).closest?.<HTMLElement>("[data-tip]");
      if (el !== over) {
        over = el;
        quiet = null;
        hide();
      }
      if (!el || el === quiet) return;
      clearTimeout(timer);
      // Like the browser's own tooltip: once the pointer has rested, just below it.
      timer = window.setTimeout(() => {
        quiet = el;
        if (el.isConnected) show(new DOMRect(e.clientX, e.clientY, 0, 16), el.dataset.tip!, false);
      }, 500);
    };
    const onDown = () => {
      quiet = over;
      hide();
    };
    const onInvalid = (e: Event) => {
      e.preventDefault(); // no browser bubble
      if (pinned) return; // only the first field that is wrong
      const el = e.target as HTMLInputElement;
      el.focus();
      show(
        el.getBoundingClientRect(),
        (el.validity.patternMismatch && el.dataset.tip) || el.validationMessage,
        true,
      );
    };
    const events = [
      ["mousemove", onMove],
      ["invalid", onInvalid],
      ["input", hide],
      ["pointerdown", onDown],
      ["scroll", hide],
      ["mouseleave", hide],
    ] as const;
    for (const [name, fn] of events) document.addEventListener(name, fn as EventListener, true);
    return () => {
      for (const [name, fn] of events) document.removeEventListener(name, fn as EventListener, true);
    };
  }, []);
  return (
    <>
      {asked && (
        <dialog
          ref={dialog}
          aria-label={asked.title}
          onCancel={() => close(null)}
          onClick={(e) => e.target === e.currentTarget && close(null)} // the dimmed page around it
          // Escape closes only this, not the sheet underneath.
          onKeyDown={(e) => e.key === "Escape" && e.stopPropagation()}
          className="m-auto w-[400px] max-w-[calc(100%-32px)] rounded-[28px] bg-[#2c2c2e] font-sans text-[#f2f2f2] shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
        >
          <form
            className="p-8"
            onSubmit={(e) => {
              e.preventDefault();
              close(String(new FormData(e.currentTarget).get("value") ?? ""));
            }}
          >
            <h2 className="font-serif text-[22px] font-bold">{asked.title}</h2>
            {asked.text && (
              <p className="mt-2 text-[14px] leading-[20px] text-[#a0a0a0]">{asked.text}</p>
            )}
            {asked.input && (
              <input {...asked.input} name="value" className={`${fieldClass} mt-5`} />
            )}
            {/* Cancel comes first, so it has the focus: Enter never deletes anything by accident. */}
            <div className="mt-7 flex gap-3">
              <button
                type="button"
                onClick={() => close(null)}
                className="h-[36px] grow basis-0 rounded-full bg-white/10 text-[13px] font-bold hover:bg-white/15"
              >
                Cancel
              </button>
              <button
                className={`${asked.danger ? dangerClass : primaryClass} h-[36px] grow basis-0`}
              >
                {asked.action}
              </button>
            </div>
          </form>
        </dialog>
      )}
      <div
        ref={tip}
        popover="manual"
        role="tooltip"
        className="pointer-events-none inset-auto max-w-[280px] rounded-lg border border-white/15 bg-[#222] px-2 py-1 font-sans text-[12px] leading-[16px] text-[#f2f2f2] shadow-2xl data-[error=true]:text-[#ff6b61]"
      />
    </>
  );
}
