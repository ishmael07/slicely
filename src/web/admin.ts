// The owner's page. Fetches /api/admin/summary and draws it; on anything but
// a 200 it shows the same "nothing here" the server meant, with a way to sign
// in. No framework, no chart library: tiles, CSS bars, tables.
import type { AdminSummary } from "../main/accounts/admin-summary";

const root = document.getElementById("admin") as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** µ¢ → dollars, two places; three when under a cent so tiny spend still shows. */
function usd(micros: number | null): string {
  if (micros === null) return "unknown";
  const dollars = micros / 100_000_000;
  const places = dollars > 0 && dollars < 0.01 ? 3 : 2;
  return `$${dollars.toLocaleString(undefined, { minimumFractionDigits: places, maximumFractionDigits: places })}`;
}

function n(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

function when(ts: number): string {
  const d = new Date(ts);
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function tile(k: string, v: string, s = "", accent = false): HTMLElement {
  const t = el("div", "tile");
  t.append(el("span", "k", k), el("span", `v${accent ? " acc" : ""}`, v));
  if (s) t.append(el("span", "s", s));
  return t;
}

function tiles(items: HTMLElement[]): HTMLElement {
  const g = el("div", "tiles");
  g.append(...items);
  return g;
}

function table(head: string[], rows: Array<Array<string | HTMLElement>>, numeric: number[] = []): HTMLElement {
  const wrap = el("div", "table-wrap");
  const t = el("table");
  const thead = el("thead");
  const tr = el("tr");
  head.forEach((h, i) => tr.append(el("th", numeric.includes(i) ? "num" : "", h)));
  thead.append(tr);
  const tbody = el("tbody");
  for (const r of rows) {
    const row = el("tr");
    r.forEach((c, i) => {
      const td = el("td", numeric.includes(i) ? "num" : "");
      if (typeof c === "string") td.textContent = c;
      else td.append(c);
      row.append(td);
    });
    tbody.append(row);
  }
  t.append(thead, tbody);
  wrap.append(t);
  return wrap;
}

function bars(s: AdminSummary): HTMLElement {
  const wrap = el("div", "bars-wrap");
  const g = el("div", "bars");
  const max = Math.max(1, ...s.usage.days.map((d) => d.spendMicros ?? d.ledgerMicros));
  for (const d of s.usage.days) {
    const b = el("div", `bar${d.spendMicros === null ? " unknown" : ""}`);
    const v = d.spendMicros ?? d.ledgerMicros;
    const i = document.createElement("i");
    i.style.height = `${Math.max(2, Math.round((v / max) * 100))}%`;
    b.append(el("b", "", `${usd(d.spendMicros)} · ${n(d.calls, "call")}`), i, el("span", "", d.day.slice(5)));
    b.title = `${d.day}: ${usd(d.spendMicros)} spent, ${n(d.calls, "call")}, ${d.tokensIn.toLocaleString()} tokens in / ${d.tokensOut.toLocaleString()} out`;
    g.append(b);
  }
  wrap.append(g);
  return wrap;
}

function render(s: AdminSummary): void {
  root.replaceChildren();

  const head = el("div", "adm-head");
  const h1 = el("h1");
  h1.append(el("span", "logo", "◆"), document.createTextNode("Slicely admin"));
  const meta = el("div", "when", `as of ${new Date(s.generatedAt).toLocaleTimeString()} · UTC day ${s.today}`);
  const back = el("a", "", "open the app →");
  back.href = "/";
  meta.append(back);
  head.append(h1, meta);
  root.append(head);

  root.append(el("h2", "", "Users"));
  root.append(
    tiles([
      tile("Accounts", String(s.users.total), `${s.users.newToday} today · ${s.users.new7d} this week`, true),
      tile("Active 24 h", String(s.users.active24h)),
      tile("Live sessions", String(s.sessions), "signed in or not"),
      tile("Waitlist", String(s.waitlist.count), "asked for a paid plan"),
      tile("Blocked", String(s.users.blocked)),
    ]),
  );

  root.append(el("h2", "", "Cost to you"));
  const cap = s.credit.dailyCapMicros;
  const todayPct = s.credit.spentTodayMicros === null || cap === 0 ? "" : `${Math.round((s.credit.spentTodayMicros / cap) * 100)}% of ${usd(cap)} cap`;
  root.append(
    tiles([
      tile("Spent today", usd(s.credit.spentTodayMicros), todayPct, true),
      tile("Spent, all time", usd(s.credit.spentMicros), `of ${usd(s.credit.grantedMicros)} granted`),
      tile("Calls today", s.usage.callsToday.toLocaleString(), `${n(s.usage.calls7d, "call")} this week`),
      tile("Revenue", "$0.00", "nothing is charged yet"),
    ]),
  );
  root.append(el("h2", "", "Spend, last 14 days"));
  root.append(bars(s));

  root.append(el("h2", "", "By model"));
  root.append(
    s.usage.byModel.length
      ? table(
          ["Model", "Calls", "Cost"],
          s.usage.byModel.map((m) => [m.model, m.calls.toLocaleString(), usd(m.micros)]),
          [1, 2],
        )
      : el("div", "adm-empty", "No metered calls in the last 14 days."),
  );

  root.append(el("h2", "", "Accounts"));
  root.append(
    s.accounts.length
      ? table(
          ["Email", "Via", "Name", "Joined", "Last seen", "Spent", "Left", "Chats today", ""],
          s.accounts.map((a) => {
            const tag = el("span", `tag${a.blocked ? " blocked" : ""}`, a.blocked ? "blocked" : "");
            return [
              a.email,
              a.provider,
              a.name ?? "",
              when(a.createdAt),
              when(a.lastSeenAt),
              usd(a.spentMicros),
              usd(a.balanceMicros),
              String(a.chatsToday),
              a.blocked ? tag : "",
            ];
          }),
          [5, 6, 7],
        )
      : el("div", "adm-empty", "Nobody has signed in yet."),
  );

  root.append(el("h2", "", "Waitlist"));
  root.append(
    s.waitlist.entries.length
      ? table(
          ["Email", "Name", "When"],
          s.waitlist.entries.map((w) => [w.email, w.name ?? "", when(w.ts)]),
        )
      : el("div", "adm-empty", "Empty."),
  );
}

/** Signed in or not, as /api/me reports it; false when it cannot be asked. */
async function signedIn(): Promise<boolean> {
  try {
    const resp = await fetch("/api/me", { headers: { Accept: "application/json" } });
    if (!resp.ok) return false;
    return ((await resp.json()) as { signedIn?: boolean }).signedIn === true;
  } catch {
    return false;
  }
}

async function gate(): Promise<void> {
  const known = await signedIn();
  root.replaceChildren();
  const g = el("div", "gate");
  g.append(el("span", "big", "◆"));
  const p = el("p");
  const a = el("a", "", "the app");
  a.href = "/";
  if (known) {
    p.append(document.createTextNode("This account isn't listed as an owner. Back to "), a, document.createTextNode("."));
  } else {
    p.append(document.createTextNode("Nothing here. Sign in from "), a, document.createTextNode(" as the owner, then come back."));
  }
  g.append(p);
  root.append(g);
}

async function load(): Promise<void> {
  try {
    const resp = await fetch("/api/admin/summary", { headers: { Accept: "application/json" } });
    if (!resp.ok) return gate();
    render((await resp.json()) as AdminSummary);
  } catch {
    await gate();
  }
}

void load();
