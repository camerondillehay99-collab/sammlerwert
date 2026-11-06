// Market, auth, settings, pricing pages.
import { h, svg, icons, fmt, label, toast, cardName, saleBadge } from "../lib/dom.ts";
import { api, HttpError, invalidate } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { state, setUser, setTheme } from "../lib/store.ts";
import { cardTile, empty, field, modal, section, placeholder, spinner } from "../components/ui.ts";
import { hoverToggle } from "../components/hover.ts";
import { imgOr, cardImage, clear } from "../lib/dom.ts";
import type { SaleFeedItem, SetSummary } from "../../../shared/types.ts";
import { groupSets } from "./search.ts";
import { tr, UI_LANGUAGES, getLang, setLang, getEdition, setEdition } from "../lib/i18n.ts";

export async function market(_p: Record<string, string>, query: URLSearchParams): Promise<HTMLElement> {
  const lang = (query.get("lang") === "en" || query.get("lang") === "de" ? query.get("lang") : getEdition()) as "de" | "en";
  const tab = query.get("tab") === "sales" ? "sales" : "movers";
  const [m, hlt, sets] = await Promise.all([api.movers(lang), api.health(), api.sets().then((r) => r.items).catch(() => [] as SetSummary[])]);
  const edition = h("a", { class: "chip ghost", href: "/einstellungen", title: tr("Standard-Edition in den Einstellungen ändern") }, lang === "de" ? tr("Deutsche Karten") : tr("Englische Karten"));
  const tabs = h("div", { class: "seg", role: "tablist" },
    h("a", { class: tab === "movers" ? "active" : "", role: "tab", href: `/markt${lang !== getEdition() ? `?lang=${lang}` : ""}` }, tr("Bewegungen")),
    h("a", { class: tab === "sales" ? "active" : "", role: "tab", href: `/markt?tab=sales` }, tr("Verkäufe")));
  const page = h("div", { class: "page" },
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, tr("Markt")), h("h1", null, tab === "sales" ? tr("Letzte Verkäufe") : tr("Bewegungen der letzten 30 Tage"))), h("div", { class: "head-actions" }, hoverToggle(), edition)),
    tabs);
  if (tab === "sales") { page.append(salesFeed(sets, query)); return page; }
  page.append(
    h("p", { class: "muted" }, tr("Datenstand Cardmarket-Preisguide: {hltstatsguid} · {fmtintNumber} bewertete Karten-Varianten · Trends basieren bis zum Aufbau der eigenen Historie auf Cardmarkts 30-Tage-Durchschnitt.", { hltstatsguid: hlt.stats.guideDate ? fmt.date(String(hlt.stats.guideDate)) : "–", fmtintNumber: fmt.int(Number(hlt.stats.quotes)) })),
    section(tr("Aufsteiger"), m.up.length ? h("div", { class: "tiles" }, ...m.up.map((x) => cardTile(x.card, { value: x.value, trend: x.trend, sale: false }))) : empty(tr("Noch keine Daten"), tr("Trends erscheinen, sobald Preishistorie vorliegt."))),
    section(tr("Absteiger"), m.down.length ? h("div", { class: "tiles" }, ...m.down.map((x) => cardTile(x.card, { value: x.value, trend: x.trend, sale: false }))) : empty(tr("Noch keine Daten"), "")),
  );
  return page;
}

const GRADERS = ["PSA", "BGS", "CGC", "TAG"];
const GRADES: Record<string, string[]> = { PSA: ["10", "9", "8", "7"], BGS: ["10", "9.5", "9", "8.5"], CGC: ["10", "9.5", "9", "8"], TAG: ["10", "9.5", "9"] };

/** Gempire-style sold feed: every recorded sale with grader/grade or condition chips, filterable. */
function salesFeed(sets: SetSummary[], query: URLSearchParams): HTMLElement {
  const f = { grader: query.get("grader") ?? "", grade: query.get("grade") ?? "", set: query.get("set") ?? "", graded: (query.get("graded") ?? "") as "" | "1" | "0", min: query.get("min") ?? "", type: query.get("type") ?? "", source: query.get("source") ?? "" };
  const root = h("div", { class: "feed" });
  const list = h("div", { class: "sales-list" });
  const meta = h("p", { class: "muted result-meta" });
  const more = h("button", { class: "btn ghost", hidden: true }, tr("Mehr laden"));
  const bar = h("div", { class: "feed-filters" });
  let offset = 0, total = 0;
  const sync = () => { const p = new URLSearchParams({ tab: "sales" }); for (const [k, v] of Object.entries(f)) if (v) p.set(k, v); history.replaceState(null, "", `/markt?${p}`); };
  function filters() {
    const kind = h("div", { class: "chips" },
      h("button", { class: `chip ${!f.grader && !f.graded ? "" : "ghost"}`, onClick: () => { f.grader = ""; f.grade = ""; f.graded = ""; run(); } }, tr("Alle")),
      h("button", { class: `chip ${f.graded === "0" ? "" : "ghost"}`, onClick: () => { f.grader = ""; f.grade = ""; f.graded = "0"; run(); } }, tr("Roh")),
      ...GRADERS.map((g) => h("button", { class: `chip ${f.grader === g ? "" : "ghost"} grader-${g.toLowerCase()}`, onClick: () => { f.grader = g; f.graded = ""; f.grade = ""; run(); } }, g)));
    const grades = f.grader ? h("div", { class: "chips" }, h("button", { class: `chip ${!f.grade ? "" : "ghost"}`, onClick: () => { f.grade = ""; run(); } }, tr("Alle Noten")), ...(GRADES[f.grader] ?? []).map((g) => h("button", { class: `chip ${f.grade === g ? "" : "ghost"}`, onClick: () => { f.grade = g; run(); } }, `${f.grader} ${g}`))) : null;
    const setSel = h("select", { "aria-label": tr("Set") }, h("option", { value: "" }, tr("Alle Sets")), ...groupSets(sets)) as HTMLSelectElement; setSel.value = f.set;
    setSel.addEventListener("change", () => { f.set = setSel.value; run(); });
    const min = h("select", { "aria-label": tr("Mindestpreis") }, ...[["", tr("Jeder Preis")], ["10", "≥ 10 €"], ["50", "≥ 50 €"], ["200", "≥ 200 €"], ["1000", "≥ 1.000 €"]].map(([v, t]) => h("option", { value: v, selected: v === f.min }, t))) as HTMLSelectElement;
    min.addEventListener("change", () => { f.min = min.value; run(); });
    // Sale type and marketplace: auction results and Buy-It-Now comps are read differently.
    const types = h("div", { class: "chips" },
      ...[["", tr("Alle Verkaufsarten")], ["auction", tr("Auktion")], ["fixed_price", tr("Sofortkauf")], ["best_offer", tr("Preisvorschlag")]].map(([v, t]) => h("button", { class: `chip ${f.type === v ? "" : "ghost"} sale-${v || "all"}`, onClick: () => { f.type = v!; run(); } }, t)));
    const src = h("select", { "aria-label": tr("Marktplatz") }, ...[["", tr("Alle Marktplätze")], ["ebay_de", "eBay.de"], ["ebay", "eBay"], ["fanatics", "Fanatics Collect"], ["heritage", "Heritage Auctions"], ["alt", "Alt"], ["cardmarket", "Cardmarket"], ["user", tr("Community")]].map(([v, t]) => h("option", { value: v, selected: v === f.source }, t))) as HTMLSelectElement;
    src.addEventListener("change", () => { f.source = src.value; run(); });
    bar.replaceChildren(kind, ...(grades ? [grades] : []), types, h("div", { class: "feed-selects" }, setSel, min, src));
  }
  async function run(append = false) {
    sync(); filters();
    if (!append) { offset = 0; clear(list); list.appendChild(spinner()); }
    try {
      const r = await api.salesFeed({ grader: f.grader || null, grade: f.grade || null, set: f.set || null, graded: f.graded || null, min: f.min || null, type: f.type || null, source: f.source || null, limit: 50, offset });
      if (!append) clear(list);
      total = r.total; offset += r.items.length;
      if (!r.items.length && !append) list.appendChild(empty(tr("Noch keine Verkäufe erfasst"), tr("Hier erscheinen echte Verkäufe mit Note bzw. Zustand, Preis, Verkaufsart (Auktion / Sofortkauf) und Marktplatz – eBay-Verkäufe werden eingelesen, sobald der eBay-Zugang freigeschaltet ist; Community-Meldungen landen sofort hier.")));
      list.append(...r.items.map(saleRow));
      meta.textContent = total ? tr("{n} Verkäufe", { n: fmt.int(total) }) : "";
      more.hidden = offset >= total;
    } catch (e) { clear(list); list.appendChild(empty(tr("Fehler"), (e as Error).message)); }
  }
  more.addEventListener("click", () => run(true));
  root.append(bar, meta, list, h("div", { class: "center" }, more));
  run();
  return root;
}

function saleRow(s: SaleFeedItem): HTMLElement {
  const grade = s.gradingCompany ? h("span", { class: `chip grader-${s.gradingCompany.toLowerCase()}` }, `${s.gradingCompany} ${s.grade ?? ""}`) : h("span", { class: "chip ghost" }, s.condition ? label.condition(s.condition) : tr("Roh"));
  const src = label.marketplace(s.source);
  return h("div", { class: "sale" },
    h("a", { class: "sale-img", href: `/karte/${encodeURIComponent(s.cardId)}` }, imgOr(cardImage(s.card), () => placeholder(s.card), { alt: cardName(s.card), width: 56, height: 78 })),
    h("div", { class: "sale-body" }, h("a", { class: "sale-title", href: `/karte/${encodeURIComponent(s.cardId)}` }, h("strong", null, cardName(s.card))),
      h("span", { class: "muted" }, `${s.card.setNameDe ?? s.card.setNameEn ?? ""} · #${s.card.localId} · ${label.language(s.language)} · ${label.variant(s.variant)}`),
      h("div", { class: "chips" }, grade, saleBadge(s.listingType), s.verified ? h("span", { class: "chip ok", title: tr("verifiziert") }, "✓") : h("span", { class: "chip ghost", title: tr("von einem Nutzer gemeldet, noch nicht geprüft") }, tr("Community")))),
    h("div", { class: "sale-value" }, h("b", null, fmt.eur(s.priceEur)), h("span", { class: "muted" }, fmt.date(s.soldAt)), s.url ? h("a", { class: "muted small", href: s.url, target: "_blank", rel: "noopener" }, src, " ", svg(icons.external, 11)) : h("span", { class: "muted small" }, src)),
  );
}

export async function settings(_p: Record<string, string>, query: URLSearchParams): Promise<HTMLElement> {
  if (!state.user) { navigate("/login?next=/einstellungen", true); return h("div"); }
  const u = state.user;
  if (query.get("checkout") === "success") { toast("Danke! Dein Abo wird aktiviert."); setTimeout(async () => { setUser((await api.me()).user); }, 1500); }
  const hlt = await api.health();
  const name = h("input", { value: u.name ?? "", placeholder: tr("Name") });
  const save = h("button", { class: "btn primary", onClick: async () => { setUser((await api.updateMe({ name: name.value })).user); toast("Gespeichert."); } }, tr("Speichern"));
  const theme = h("div", { class: "seg" }, ...(["light", "dark"] as const).map((t) => h("button", { class: state.theme === t ? "active" : "", onClick: (e: Event) => { setTheme(t); (e.currentTarget as HTMLElement).parentElement!.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === e.currentTarget)); } }, svg(t === "light" ? icons.sun : icons.moon, 16), t === "light" ? tr(" Hell") : tr(" Dunkel"))));
  const planNames: Record<string, string> = { free: tr("Kostenlos"), sammler: tr("Sammler"), pro: tr("Pro") };
  const billing = section(tr("Abo"),
    h("p", null, tr("Aktueller Tarif: "), h("b", null, planNames[u.plan] ?? u.plan), u.planStatus && u.plan !== "free" ? h("span", { class: "muted" }, ` (${u.planStatus})`) : null),
    h("div", { class: "actions-row" },
      u.plan === "free" ? h("a", { class: "btn primary", href: "/tarife" }, tr("Upgrade")) : h("button", { class: "btn ghost", onClick: async () => { try { location.href = (await api.portal()).url; } catch (e) { toast((e as Error).message, "error"); } } }, tr("Abo verwalten")),
      !hlt.billing ? h("span", { class: "muted small" }, tr("Zahlungen sind in dieser Installation noch nicht aktiviert (Stripe-Schlüssel fehlen).")) : null));
  const watch = section(tr("Watchlist"), await watchlist());
  const admin = (u as { isAdmin?: boolean }).isAdmin ? await adminPanel() : null;
  return h("div", { class: "page narrow" },
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, tr("Konto")), h("h1", null, tr("Einstellungen")))),
    section(tr("Profil"), h("div", { class: "row" }, field(tr("Name"), name), field(tr("E-Mail"), h("input", { value: u.email, disabled: true }))), h("div", { class: "actions-row" }, save)),
    await securityPanel(),
    section(tr("Sprache & Darstellung"), languagePanel(), theme),
    billing, watch, admin,
    section(tr("Daten & Datenschutz"), h("p", { class: "muted" }, tr("Deine Sammlung gehört dir. Export jederzeit als CSV (ab Sammler-Tarif). Keine Werbung, kein Tracking, Server in der EU.")),
      h("div", { class: "actions-row" }, h("button", { class: "btn ghost", onClick: async () => { await api.logout(); setUser(null); invalidate(); navigate("/"); } }, svg(icons.logout, 16), tr(" Abmelden")))),
  );
}

/** UI language (any of the listed languages) and the default card edition used for prices. */
function languagePanel(): HTMLElement {
  const langSel = h("select", null, ...UI_LANGUAGES.map((l) => h("option", { value: l.code, selected: l.code === getLang() }, `${l.native}${l.machine ? " · " + tr("automatisch übersetzt") : ""}`))) as HTMLSelectElement;
  const status = h("small", { class: "muted" });
  langSel.addEventListener("change", async () => {
    langSel.disabled = true; status.textContent = tr("Übersetze …");
    try {
      await setLang(langSel.value);
      if (state.user) api.updateMe({ locale: langSel.value }).catch(() => {});
      status.textContent = "";
    } catch { status.textContent = tr("Das hat nicht geklappt"); }
    langSel.disabled = false;
  });
  const edSel = h("select", null, h("option", { value: "de", selected: getEdition() === "de" }, tr("Deutsche Karten")), h("option", { value: "en", selected: getEdition() === "en" }, tr("Englische Karten"))) as HTMLSelectElement;
  edSel.addEventListener("change", () => { setEdition(edSel.value as "de" | "en"); invalidate(); toast(tr("Gespeichert.")); });
  return h("div", { class: "row" },
    field(tr("Sprache der App"), langSel, tr("Deutsch und Englisch sind von Hand übersetzt, alle anderen Sprachen automatisch.")),
    field(tr("Standard-Edition der Karten"), edSel, tr("Welche Ausgabe Markt, Suche und Kartenpreise zuerst zeigen.")));
}

/** Two-factor status, fresh recovery codes, other sessions. */
async function securityPanel(): Promise<HTMLElement> {
  const st = await api.mfaStatus().catch(() => ({ enabled: false, enabledAt: null, recoveryCodesLeft: 0 }));
  const codesBtn = h("button", { class: "btn ghost", onClick: () => {
    const inp = h("input", { inputmode: "numeric", autocomplete: "one-time-code", placeholder: "123 456", class: "code-input" }) as HTMLInputElement;
    const go = h("button", { class: "btn primary", type: "submit" }, tr("Neue Codes erzeugen"));
    const f = h("form", { class: "form" }, h("p", null, tr("Die alten Wiederherstellungscodes verlieren ihre Gültigkeit. Zur Bestätigung den aktuellen Code aus der App eingeben.")), field(tr("Code"), inp), h("div", { class: "actions" }, go));
    f.addEventListener("submit", async (e) => {
      e.preventDefault(); go.disabled = true;
      try {
        const r = await api.mfaRecovery(inp.value);
        const text = r.recoveryCodes.join("\n");
        f.replaceChildren(h("p", null, tr("Deine neuen Codes – jeder gilt einmal. Wir zeigen sie nur jetzt.")), h("ul", { class: "recovery-codes" }, ...r.recoveryCodes.map((c) => h("li", { class: "mono" }, c))),
          h("div", { class: "actions-row" }, h("button", { class: "btn ghost", type: "button", onClick: async () => { try { await navigator.clipboard.writeText(text); toast("Kopiert."); } catch { toast("Bitte markieren und kopieren.", "error"); } } }, svg(icons.copy, 14), tr(" Kopieren")),
            h("a", { class: "btn ghost", href: `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`, download: "sammlerwert-wiederherstellungscodes.txt" }, svg(icons.download, 14), tr(" Datei")), h("button", { class: "btn primary", type: "button", onClick: () => close() }, tr("Fertig"))));
      } catch (err) { go.disabled = false; toast((err as Error).message, "error"); }
    });
    const close = modal(tr("Wiederherstellungscodes"), f);
    setTimeout(() => inp.focus(), 60);
  } }, svg(icons.lock, 16), tr(" Neue Wiederherstellungscodes"));
  const revoke = h("button", { class: "btn ghost", onClick: async () => { await api.revokeOtherSessions(); toast("Andere Geräte abgemeldet."); } }, svg(icons.logout, 16), tr(" Andere Geräte abmelden"));
  return section(tr("Sicherheit"),
    st.enabled
      ? h("p", null, svg(icons.shield, 16), tr(" Zwei-Faktor-Anmeldung ist "), h("b", null, "aktiv"), st.enabledAt ? h("span", { class: "muted" }, ` seit ${fmt.date(st.enabledAt)}`) : null, h("span", { class: "muted" }, tr(" · {strecoveryCo} Wiederherstellungscodes übrig", { strecoveryCo: st.recoveryCodesLeft })))
      : h("div", { class: "notice warn" }, svg(icons.warn, 18), h("div", null, h("b", null, tr("Dein Konto ist noch nicht mit 2FA geschützt.")), h("p", null, tr("Richte jetzt eine Authenticator-App ein – eine Minute, und deine Sammlung ist sicher.")))),
    h("div", { class: "actions-row" },
      st.enabled ? codesBtn : h("a", { class: "btn primary", href: "/2fa/einrichten?next=/einstellungen" }, svg(icons.shield, 16), tr(" 2FA einrichten")),
      st.enabled ? h("a", { class: "btn ghost", href: "/2fa/einrichten?next=/einstellungen" }, tr("Authenticator wechseln")) : null,
      revoke));
}

export async function watchlistView(): Promise<HTMLElement> {
  if (!state.user) { navigate("/login?next=/watchlist", true); return h("div"); }
  return h("div", { class: "page narrow" }, h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, tr("Beobachten")), h("h1", null, tr("Watchlist")), h("p", { class: "muted" }, tr("Karten, die du im Blick behalten willst – auf jeder Kartenseite über „Beobachten“.")))), section(tr("Karten"), await watchlist()));
}

async function watchlist(): Promise<HTMLElement> {
  const w = await api.watchlist();
  if (!w.items.length) return h("p", { class: "muted" }, tr("Noch keine Karten auf der Watchlist. Auf jeder Kartenseite: „Beobachten“."));
  return h("ul", { class: "ranked" }, ...w.items.map((it) => h("li", null, h("a", { href: `/karte/${encodeURIComponent(it.cardId)}` }, `${cardName(it.card)} #${it.card.localId}`), h("span", { class: "muted" }, label.language(it.language)), h("b", null, fmt.eur(it.card.valueDe)),
    h("button", { class: "icon-btn", "aria-label": tr("Entfernen"), onClick: async (e: Event) => { await api.unwatch(it.id); (e.currentTarget as HTMLElement).closest("li")!.remove(); } }, svg(icons.close, 16)))));
}

async function adminPanel(): Promise<HTMLElement> {
  const data = await api.jobs();
  const out = h("pre", { class: "log" }, JSON.stringify(data.stats, null, 1));
  const run = (job: string) => h("button", { class: "btn ghost", onClick: async (e: Event) => { const b = e.currentTarget as HTMLButtonElement; b.disabled = true; try { const r = await api.runJob(job); out.textContent = `${job}: ${r.detail}`; toast("Job ausgeführt."); } catch (err) { toast((err as Error).message, "error"); } b.disabled = false; } }, job);
  return section(tr("Admin · Daten-Jobs"), h("div", { class: "chips" }, run("daily_refresh"), run("catalog_completion"), run("reprice"), run("ebay_refresh"), run("snapshots")), out,
    h("details", null, h("summary", null, tr("Letzte Läufe")), h("ul", { class: "ranked" }, ...data.runs.slice(0, 15).map((r) => h("li", null, h("span", null, `${r.job}`), h("span", { class: "muted" }, String(r.started_at).slice(0, 16).replace("T", " ")), h("b", { class: r.status === "ok" ? "up" : r.status === "error" ? "down" : "" }, String(r.status)))))));
}

export function legal(kind: "impressum" | "datenschutz") {
  return (): HTMLElement => h("div", { class: "page narrow" },
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, tr("Rechtliches")), h("h1", null, kind === "impressum" ? tr("Impressum") : tr("Datenschutz")))),
    section(kind === "impressum" ? tr("Angaben gemäß § 5 DDG") : tr("Kurz gesagt"),
      kind === "impressum"
        ? h("p", null, tr("[Name / Firma], [Straße Nr.], [PLZ] Berlin · E-Mail: [adresse] · USt-IdNr.: [falls vorhanden]. Verantwortlich für den Inhalt: [Name]. Plattform der EU-Kommission zur Online-Streitbeilegung: ec.europa.eu/consumers/odr. Pokémon und alle Kartennamen sind Marken ihrer jeweiligen Rechteinhaber; Sammlerwert ist ein unabhängiges, inoffizielles Angebot."))
        : h("div", { class: "form" },
            h("p", null, tr("Wir speichern nur, was für dein Konto und deine Sammlung nötig ist: E-Mail, Passwort-Hash (Argon2id), Sammlungsdaten, hochgeladene Bilder und gemeldete Verkäufe. Keine Werbenetzwerke, kein Tracking, keine Weitergabe.")),
            h("p", null, tr("Server-Standort: EU. Zahlungsabwicklung: Stripe Payments Europe Ltd. (Kartendaten sehen wir nie). Kartenbilder werden von assets.tcgdex.net geladen; dabei wird deine IP-Adresse an diesen Dienst übertragen.")),
            h("p", null, tr("Du kannst dein Konto jederzeit löschen lassen ([adresse]); Exporte gibt es unter Sammlung → CSV. Verantwortlicher im Sinne der DSGVO: siehe Impressum.")))),
    h("p", { class: "muted small" }, tr("Platzhalter in eckigen Klammern vor dem Start ausfüllen – idealerweise mit einem Generator (z. B. e-recht24) oder Anwalt gegenprüfen.")));
}

export async function pricing(): Promise<HTMLElement> {
  const hlt = await api.health();
  const plan = (name: string, price: string, items: string[], cta: HTMLElement, featured = false) => h("div", { class: `plan ${featured ? "featured" : ""}` }, h("h3", null, name), h("div", { class: "plan-price" }, price), h("ul", null, ...items.map((i) => h("li", null, svg(icons.check, 16), i))), cta);
  const buy = (p: "sammler" | "pro", text: string) => h("button", { class: "btn primary full", onClick: async () => {
    if (!state.user) return navigate(`/registrieren?next=/tarife`);
    try { location.href = (await api.checkout(p)).url; } catch (e) { toast(e instanceof HttpError && e.code === "billing_disabled" ? tr("Zahlungen sind noch nicht freigeschaltet – bald!") : (e as Error).message, "error"); }
  } }, text);
  return h("div", { class: "page" },
    h("header", { class: "page-head center" }, h("div", null, h("p", { class: "eyebrow" }, tr("Tarife")), h("h1", null, tr("Einfach. Fair. Jederzeit kündbar.")), h("p", { class: "muted" }, tr("Preise inkl. MwSt. Monatlich kündbar."), !hlt.billing ? tr(" Zahlungen werden in Kürze freigeschaltet.") : ""))),
    h("div", { class: "plans" },
      plan(tr("Kostenlos"), "0 €", [tr("Bis zu 50 Karten, 3 Sammlungen"), tr("Deutsche Marktwerte & Trends"), tr("Scanner, Suche, Sets, Markt"), tr("Import von Collectr & Card Ladder"), tr("Verkäufe melden")], state.user ? h("a", { class: "btn ghost full", href: "/sammlung" }, tr("Dein aktueller Start")) : h("a", { class: "btn ghost full", href: "/registrieren" }, tr("Kostenlos starten"))),
      plan(tr("Sammler"), tr("4,99 € / Monat"), [tr("Bis zu 2.500 Karten, 15 Sammlungen"), tr("Vollständige Wert-Historie"), tr("Gewinn/Verlust & Insights"), tr("25 Preisalarme"), tr("CSV-Export & Teilen-Links")], buy("sammler", tr("Sammler werden")), true),
      plan(tr("Pro"), tr("9,99 € / Monat"), [tr("Unbegrenzte Karten & Sammlungen"), tr("Unbegrenzte Scans & Preisalarme"), tr("Prioritäts-Aktualisierung deiner Karten"), tr("PSA-Zertifikatsabgleich"), tr("Früher Zugang zu neuen Funktionen")], buy("pro", tr("Pro werden"))),
    ),
    h("p", { class: "muted center small" }, tr("Händler-/API-Zugang auf Anfrage.")));
}

/** Transparency page: how a Sammlerwert market value is built. Trust comes from showing the recipe. */
export function methodik(): HTMLElement {
  const p = (...c: (string | HTMLElement)[]) => h("p", null, ...c);
  return h("div", { class: "page narrow" },
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, tr("Transparenz")), h("h1", null, tr("So entsteht ein Sammlerwert")),
      h("p", { class: "muted" }, tr("Kein Wunschpreis, keine Schätzung ins Blaue: Jeder Marktwert ist aus echten Verkäufen und dem Cardmarket-Preisguide nachvollziehbar aufgebaut – und jeder Verkauf, der einfließt, steht sichtbar auf der Kartenseite.")))),
    section(tr("1 · Datenquellen"),
      h("div", { class: "form" },
        p(h("b", null, tr("Verkäufe auf eBay.de")), tr(" – abgeschlossene Verkäufe der letzten 90 Tage über die offizielle eBay-Schnittstelle. Jede Anzeige wird automatisch gelesen: Kartenname und Nummer müssen passen, Sprache (deutsch/englisch/japanisch), Variante (Holo, Reverse, 1. Edition), Bewertung (PSA, CGC, BGS …) werden erkannt; Lots, Proxys, Metallkarten und Codes fliegen raus.")),
        p(h("b", null, tr("Cardmarket-Preisguide")), tr(" – der tägliche Preisguide (Trend, Ø 1/7/30 Tage, Ab-Preis) als Anker. Er mischt alle Sprachen, deshalb lernt Sammlerwert pro Set einen "), h("i", null, tr("Sprachfaktor")), tr(" aus den deutschen Verkäufen: Verkaufspreis ÷ Guide-Trend, Median über das Set, gegen den globalen Faktor abgesichert.")),
        p(h("b", null, tr("Aktive Angebote")), tr(" – die günstigsten deutschen Angebote bei eBay.de dienen nur als Untergrenze. Sie dürfen den Wert nie dominieren (maximal 25 % Gewicht).")),
        p(h("b", null, tr("Community-Meldungen")), tr(" – von Nutzern gemeldete Verkäufe zählen mit halbem Gewicht, bis sie geprüft sind.")))),
    section(tr("2 · Rechenweg"),
      h("div", { class: "form" },
        p(tr("Alle Verkäufe werden auf Near Mint normiert (EX ≈ 85 %, GD ≈ 70 % …) und zeitlich gewichtet: ein Verkauf verliert alle 21 Tage die Hälfte seines Gewichts. Ausreißer (mehr als 3 MAD vom Median) werden entfernt.")),
        p(tr("Der Marktwert ist der gewichtete Median der Verkäufe, gemischt mit dem sprachbereinigten Guide-Wert. Je mehr aktuelle Verkäufe, desto mehr zählen sie: bei drei effektiven Verkäufen halbe-halbe, ab etwa zehn fast nur noch Verkäufe.")),
        p(tr("Comps: Unter jeder Karte steht zuerst der letzte echte Verkauf – mit Verkaufsart (Auktion, Sofortkauf, Preisvorschlag), Marktplatz, Zustand bzw. Note und Datum. Bewertete Karten (PSA 10, CGC 9.5 …) zeigen Note für Note den letzten Verkauf und ab zwei Verkäufen den zeitgewichteten Median (180 Tage). Zustände oder Noten ohne Verkauf bleiben leer – es wird nichts hochgerechnet oder geschätzt.")))),
    section(tr("3 · Konfidenz"),
      h("div", { class: "form" },
        p(h("b", null, tr("Hoch")), tr(" – mehrere aktuelle Verkäufe, die mit dem Guide übereinstimmen. "), h("b", null, tr("Mittel")), tr(" – Guide-Wert mit gelerntem Sprachfaktor oder wenige Verkäufe. "), h("b", null, tr("Niedrig")), tr(" – nur Guide ohne deutschen Faktor, oder nur Angebote.")),
        p(tr("Die Spanne (unteres bis oberes Quartil der Verkäufe) zeigt, was realistisch gezahlt wird – nicht nur einen Punkt.")))),
    section(tr("4 · Was Sammlerwert nicht tut"),
      h("div", { class: "form" },
        p(tr("Keine Preise aus Angeboten als „Wert“ verkaufen. Keine Verkäufe verstecken. Keine Zahlen ohne Quelle. Wenn eine Karte zu wenig Daten hat, steht das dort – statt einer erfundenen Zahl.")),
        h("p", { class: "muted small" }, tr("Datenstand und Quellenanteile stehen bei jeder Bewertung. Fehler gefunden? Melde den Verkauf oder schreib uns – jede Meldung macht die Datenbasis für alle besser.")))));
}
