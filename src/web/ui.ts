// ─────────────────────────────────────────────────────────────────────────────
// ui.ts — the small set of things every other module builds with: DOM helpers,
// toasts, sheets, menus, confirmation dialogs, error cards and loading
// skeletons.
//
// Nothing here knows about chat, jobs, printers or settings. Everything here is
// keyboard-reachable and screen-reader-labelled: menus are real `role="menu"`
// lists of `role="menuitemradio"` buttons (each menu here is a single-choice
// picker, so `aria-checked` marks the current one — that attribute is only
// valid on a `menuitemradio`/`menuitemcheckbox`, never on a plain `menuitem`);
// sheets and the confirmation dialog are
// modal, with the focus trap ported from site/main.js and focus restored to
// whatever opened them; and the toast region is a polite live region.
// ─────────────────────────────────────────────────────────────────────────────

// ── tiny DOM helpers ─────────────────────────────────────────────────────────

export function byId<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id} in index.html`);
  return found as T;
}

/** Create an element with an optional class and text. Text is always set as a
 *  text node (never innerHTML): most of what this renders is model output. */
export function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * An anchor to somewhere outside the app.
 *
 * Only http(s) is allowed through: the agent's text is model output, and a
 * `javascript:` href in a rendered chat bubble is a script-injection hole.
 */
export function externalLink(href: string, label: string): HTMLElement {
  let safe = "";
  try {
    const u = new URL(href, location.href);
    if (u.protocol === "http:" || u.protocol === "https:") safe = u.href;
  } catch {
    /* not a URL we can render as a link */
  }
  if (!safe) return make("span", "", label);
  const a = make("a", "link", label);
  a.href = safe;
  a.target = "_blank";
  a.rel = "noreferrer noopener";
  return a;
}

/** Everything a keyboard can land on inside a container, in tab order. */
function focusable(root: HTMLElement): HTMLElement[] {
  const found = root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  return Array.from(found).filter(
    (el) => el.getClientRects().length > 0 || el === document.activeElement,
  );
}

/** Tab/Shift-Tab cycling inside one container. Ported from site/main.js. */
function trapTab(root: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== "Tab") return;
  const visible = focusable(root);
  if (visible.length === 0) return;
  const first = visible[0];
  const last = visible[visible.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  } else if (!root.contains(document.activeElement)) {
    e.preventDefault();
    first.focus();
  }
}

// ── toasts ───────────────────────────────────────────────────────────────────

export type ToastKind = "info" | "error" | "success";

export function toast(message: string, kind: ToastKind = "info"): void {
  const host = byId<HTMLElement>("toasts");
  const t = make("div", `toast ${kind}`, message);
  host.appendChild(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, 4000);
}

// ── sheets (Settings, Chats, Print jobs) ─────────────────────────────────────

export type SheetId = "settings" | "chats" | "jobs";

const SHEET_ELEMENT: Record<SheetId, string> = {
  settings: "settingsSheet",
  chats: "chatsSheet",
  jobs: "jobsSheet",
};

let openSheetId: SheetId | null = null;
/** Whatever had focus before a sheet opened, so closing puts it back. */
let sheetReturnFocus: HTMLElement | null = null;
const sheetListeners = new Set<(open: SheetId | null) => void>();

/** Notified whenever a sheet opens or closes — the printer poll uses this to
 *  speed up while its list is on screen. */
export function onSheetChange(fn: (open: SheetId | null) => void): void {
  sheetListeners.add(fn);
}

export function isSheetOpen(id?: SheetId): boolean {
  return id === undefined ? openSheetId !== null : openSheetId === id;
}

function applySheets(): void {
  for (const id of Object.keys(SHEET_ELEMENT) as SheetId[]) {
    const el = byId<HTMLElement>(SHEET_ELEMENT[id]);
    const shown = openSheetId === id;
    el.classList.toggle("hidden", !shown);
    // A hidden sheet is still in the document, so say so: without this a screen
    // reader walks straight through the closed Settings sheet on its way down
    // the page.
    el.setAttribute("aria-hidden", shown ? "false" : "true");
  }
  byId<HTMLElement>("scrim").classList.toggle("hidden", openSheetId === null);
  for (const fn of sheetListeners) fn(openSheetId);
}

export function openSheet(id: SheetId): void {
  const active = document.activeElement;
  if (openSheetId === null && active instanceof HTMLElement) sheetReturnFocus = active;
  openSheetId = id;
  applySheets();
  const sheet = byId<HTMLElement>(SHEET_ELEMENT[id]);
  // The close button is the safest landing spot: it always exists, and it is
  // where someone who opened this by keyboard expects to start.
  const first = sheet.querySelector<HTMLElement>(".sheet-close") ?? focusable(sheet)[0];
  first?.focus();
}

export function closeSheets(): void {
  if (openSheetId === null) return;
  openSheetId = null;
  applySheets();
  const restore = sheetReturnFocus;
  sheetReturnFocus = null;
  restore?.focus();
}

/** Toggle a sheet from its header button. Returns true if it is now open. */
export function toggleSheet(id: SheetId): boolean {
  if (openSheetId === id) {
    closeSheets();
    return false;
  }
  openSheet(id);
  return true;
}

// ── menus ────────────────────────────────────────────────────────────────────

export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** Drawn with a check — the current choice. */
  active?: boolean;
  /** Optional heading this item sits under. A heading is drawn once, when the
   *  group changes — which is what lets the model picker show six models from
   *  two providers without the reader having to know which is which. */
  group?: string;
}

interface OpenMenu {
  trigger: HTMLElement;
  el: HTMLElement;
  close(returnFocus: boolean): void;
}

let currentMenu: OpenMenu | null = null;

export function closeMenus(returnFocus = false): void {
  currentMenu?.close(returnFocus);
}

/**
 * A dropdown menu anchored under `trigger`.
 *
 * Built fresh each time it opens (the item list is usually derived from
 * just-fetched state) and thrown away on close, so there is never a stale menu
 * in the DOM. Arrow keys, Home/End and Escape work; focus returns to the
 * trigger when it closes.
 */
export function menu(
  trigger: HTMLElement,
  items: MenuItem[],
  onPick: (id: string) => void,
): void {
  const reopening = currentMenu?.trigger === trigger;
  closeMenus(false);
  if (reopening) return;

  const el = make("div", "picker-menu");
  el.setAttribute("role", "menu");
  const labelledBy = trigger.id;
  if (labelledBy) el.setAttribute("aria-labelledby", labelledBy);

  const buttons: HTMLButtonElement[] = [];
  let group: string | undefined;
  for (const item of items) {
    if (item.group && item.group !== group) {
      group = item.group;
      const heading = make("div", "menu-group", item.group);
      // Presentational: the check state already tells a screen reader which item
      // is chosen, and a heading inside a menu is not a menuitem.
      heading.setAttribute("role", "presentation");
      el.appendChild(heading);
    }
    const btn = make("button", `menu-item${item.active ? " active" : ""}${item.disabled ? " disabled" : ""}`);
    btn.type = "button";
    // `menuitemradio`, not `menuitem`: every menu built here is a single-choice
    // picker (the model, the effort level), and `aria-checked` — which marks
    // the current choice below — is invalid ARIA on a plain `menuitem`.
    btn.setAttribute("role", "menuitemradio");
    if (item.disabled) {
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
    }
    const text = make("div", "mtext");
    text.appendChild(make("div", "mname", item.label));
    if (item.hint) text.appendChild(make("div", "mblurb", item.hint));
    btn.appendChild(text);
    const check = make("span", "check", "✓");
    check.setAttribute("aria-hidden", "true");
    btn.appendChild(check);
    btn.setAttribute("aria-checked", item.active ? "true" : "false");
    btn.addEventListener("click", () => {
      if (item.disabled) return;
      close(true);
      onPick(item.id);
    });
    el.appendChild(btn);
    if (!item.disabled) buttons.push(btn);
  }

  function close(returnFocus: boolean): void {
    if (currentMenu?.el !== el) return;
    currentMenu = null;
    document.removeEventListener("pointerdown", onOutside, true);
    el.remove();
    trigger.setAttribute("aria-expanded", "false");
    trigger.classList.remove("open");
    if (returnFocus) trigger.focus();
  }

  function onOutside(e: Event): void {
    const t = e.target as Node | null;
    if (t && (el.contains(t) || trigger.contains(t))) return;
    close(false);
  }

  el.addEventListener("keydown", (e) => {
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      buttons[(idx + 1 + buttons.length) % buttons.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      buttons[(idx - 1 + buttons.length) % buttons.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      buttons[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      buttons[buttons.length - 1]?.focus();
    } else if (e.key === "Tab") {
      close(false);
    }
  });

  (trigger.parentElement ?? document.body).appendChild(el);
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "true");
  trigger.classList.add("open");
  currentMenu = { trigger, el, close };
  document.addEventListener("pointerdown", onOutside, true);
  (buttons.find((b) => b.classList.contains("active")) ?? buttons[0])?.focus();
}

// ── confirmation dialog ──────────────────────────────────────────────────────

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
}

let dialogSeq = 0;
/** How many confirmation dialogs are open. A dialog opened on top of a sheet is
 *  the only thing the keyboard should be able to reach, so the sheet's own Tab
 *  trap stands down while one is up — otherwise the two traps fight and focus
 *  can never leave the dialog's first button. */
let openDialogs = 0;

/**
 * Ask before something irreversible or hazardous.
 *
 * `role="alertdialog"` with a focus trap; Escape and the scrim both cancel, so
 * the safe answer is always the easy one. Cancel is focused first for the same
 * reason.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const seq = ++dialogSeq;
    const titleId = `dialogTitle${seq}`;
    const bodyId = `dialogBody${seq}`;

    const host = make("div", "dialog-host");
    const box = make("div", `dialog${opts.danger ? " danger" : ""}`);
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", titleId);
    box.setAttribute("aria-describedby", bodyId);

    const title = make("h2", "dialog-title", opts.title);
    title.id = titleId;
    const body = make("p", "dialog-body", opts.body);
    body.id = bodyId;
    const actions = make("div", "dialog-actions");
    const cancel = make("button", "btn ghost", "Cancel");
    cancel.type = "button";
    const confirm = make("button", `btn ${opts.danger ? "danger-solid" : "primary"}`, opts.confirmLabel);
    confirm.type = "button";
    actions.append(cancel, confirm);
    box.append(title, body, actions);
    host.appendChild(box);

    function settle(answer: boolean): void {
      openDialogs -= 1;
      document.removeEventListener("keydown", onKey, true);
      host.remove();
      returnFocus?.focus();
      resolve(answer);
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        settle(false);
        return;
      }
      trapTab(box, e);
    }

    cancel.addEventListener("click", () => settle(false));
    confirm.addEventListener("click", () => settle(true));
    host.addEventListener("pointerdown", (e) => {
      if (e.target === host) settle(false);
    });
    openDialogs += 1;
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(host);
    cancel.focus();
  });
}

// ── error + loading states ───────────────────────────────────────────────────

/**
 * One failure component for the whole client.
 *
 * A list that failed to load and a list that is genuinely empty are different
 * facts, and a coloured sentence cannot be retried. This says what went wrong
 * and offers the one action that might fix it.
 */
export function errorCard(message: string, retry?: () => void): HTMLElement {
  const card = make("div", "error-card");
  card.setAttribute("role", "group");
  const icon = make("span", "error-ico", "⚠");
  icon.setAttribute("aria-hidden", "true");
  const text = make("div", "error-text", message);
  card.append(icon, text);
  if (retry) {
    const btn = make("button", "btn ghost small", "Retry");
    btn.type = "button";
    btn.addEventListener("click", retry);
    card.appendChild(btn);
  }
  return card;
}

/** Placeholder rows while a list loads, so an empty panel never reads as "you
 *  have nothing" before the answer arrives. */
export function skeleton(rows: number): HTMLElement {
  const wrap = make("div", "skeleton");
  wrap.setAttribute("aria-hidden", "true");
  for (let i = 0; i < Math.max(1, rows); i++) wrap.appendChild(make("div", "skeleton-row"));
  return wrap;
}

/** Install the global Escape/scrim handling for sheets and menus. Called once
 *  from app.ts's boot. */
export function initUi(): void {
  byId<HTMLElement>("scrim").addEventListener("click", () => closeSheets());
  byId<HTMLElement>("toasts").setAttribute("aria-live", "polite");
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (currentMenu) {
      closeMenus(true);
      return;
    }
    closeSheets();
  });
  // Keep the keyboard inside an open sheet, the same way the dialog does.
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Tab" || openSheetId === null || openDialogs > 0) return;
      trapTab(byId<HTMLElement>(SHEET_ELEMENT[openSheetId]), e);
    },
    true,
  );
}
