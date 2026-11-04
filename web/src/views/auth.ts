/**
 * Account pages: login, registration and the mandatory second factor.
 *   /registrieren → /2fa/einrichten (QR + first code → recovery codes) → app
 *   /login        → /2fa (6-digit code or recovery code) → app
 */
import { h, svg, icons, toast } from "../lib/dom.ts";
import { api, HttpError, invalidate } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { state, setUser, setMfa } from "../lib/store.ts";
import { field, section } from "../components/ui.ts";
import { qrSvg } from "../lib/qr.ts";

function nextOf(query: URLSearchParams) { const n = query.get("next") ?? "/"; return n.startsWith("/") && !n.startsWith("//") ? n : "/"; }

export function authView(mode: "login" | "register") {
  return (_p: Record<string, string>, query: URLSearchParams): HTMLElement => {
    const next = nextOf(query);
    const email = h("input", { type: "email", name: "email", required: true, autocomplete: "email", placeholder: "du@beispiel.de", inputmode: "email" });
    const pw = h("input", { type: "password", name: "password", required: true, minlength: 8, autocomplete: mode === "login" ? "current-password" : "new-password", placeholder: mode === "login" ? "Passwort" : "Mindestens 8 Zeichen" });
    const name = h("input", { type: "text", name: "name", autocomplete: "nickname", placeholder: "Wie sollen wir dich nennen?" });
    const submit = h("button", { class: "btn primary lg full", type: "submit" }, mode === "login" ? "Anmelden" : "Konto erstellen");
    const form = h("form", { class: "form auth-form" },
      mode === "register" ? field("Name (optional)", name) : null, field("E-Mail", email), field("Passwort", pw), submit,
      mode === "register" ? h("p", { class: "muted small center" }, svg(icons.shield, 14), " Jedes Konto ist mit einer Authenticator-App (2FA) geschützt – die Einrichtung dauert eine Minute und folgt direkt nach diesem Schritt.") : null,
      h("p", { class: "muted center" }, mode === "login" ? ["Noch kein Konto? ", h("a", { href: `/registrieren?next=${encodeURIComponent(next)}` }, "Registrieren")] : ["Schon dabei? ", h("a", { href: `/login?next=${encodeURIComponent(next)}` }, "Anmelden")]));
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); submit.disabled = true;
      try {
        const r = mode === "login" ? await api.login(email.value, pw.value) : await api.register(email.value, pw.value, name.value);
        invalidate();
        if (r.mfa) { setMfa({ step: r.mfa, email: r.email ?? email.value }); navigate(`${r.mfa === "setup" ? "/2fa/einrichten" : "/2fa"}?next=${encodeURIComponent(next)}`); return; }
        setUser(r.user); toast("Willkommen zurück!");
        navigate(r.user && !r.user.totpEnabled ? `/2fa/einrichten?next=${encodeURIComponent(next)}` : next);
      } catch (err) { submit.disabled = false; toast((err as Error).message, "error"); }
    });
    return h("div", { class: "page narrow" }, h("header", { class: "page-head center" }, h("div", null, h("p", { class: "eyebrow" }, "Konto"), h("h1", null, mode === "login" ? "Anmelden" : "Kostenlos registrieren"),
      mode === "register" ? h("p", { class: "muted" }, "Bis zu 50 Karten kostenlos. Keine Zahlungsdaten nötig.") : null)), form);
  };
}

/** Six boxes feel like an app; a single numeric input with autocomplete="one-time-code" is what actually works with password managers and SMS/iOS autofill. */
function codeInput(placeholder = "123 456"): HTMLInputElement {
  return h("input", { class: "code-input", type: "text", inputmode: "numeric", autocomplete: "one-time-code", pattern: "[0-9 ]*", maxlength: 7, placeholder, "aria-label": "Code" }) as HTMLInputElement;
}

export async function mfaSetupView(_p: Record<string, string>, query: URLSearchParams): Promise<HTMLElement> {
  const next = nextOf(query);
  if (!state.user && !state.mfa) { navigate(`/login?next=${encodeURIComponent(location.pathname)}`, true); return h("div"); }
  const reSetup = !!state.user?.totpEnabled;
  const root = h("div", { class: "page narrow" });
  const head = h("header", { class: "page-head center" }, h("div", null, h("p", { class: "eyebrow" }, "Sicherheit"), h("h1", null, reSetup ? "Authenticator neu einrichten" : "Konto absichern"),
    h("p", { class: "muted" }, "Zwei-Faktor-Anmeldung mit einer Authenticator-App – Google Authenticator, Aegis, 1Password, Apple Passwörter oder Authy. Ohne dein Handy kommt niemand an deine Sammlung.")));
  root.append(head);
  const body = h("div");
  root.append(body);

  const start = async (code?: string) => {
    let setup: Awaited<ReturnType<typeof api.mfaSetup>>;
    try { setup = await api.mfaSetup(code); }
    catch (e) {
      if (e instanceof HttpError && e.code === "code_required") { // existing 2FA: ask for the current code first
        const inp = codeInput(); const btn = h("button", { class: "btn primary", type: "submit" }, "Weiter");
        const f = h("form", { class: "form" }, h("p", null, "Zum Zurücksetzen bitte den aktuellen Code aus deiner App eingeben."), field("Aktueller Code", inp), btn);
        f.addEventListener("submit", async (ev) => { ev.preventDefault(); btn.disabled = true; try { await start(inp.value); } catch (er) { toast((er as Error).message, "error"); btn.disabled = false; } });
        body.replaceChildren(section("Bestätigung", f)); return;
      }
      if (e instanceof HttpError && e.status === 401) { navigate("/login", true); return; }
      throw e;
    }
    const qr = h("div", { class: "qr-box" }); qr.innerHTML = qrSvg(setup.otpauth, 196);
    const secretPretty = setup.secret.match(/.{1,4}/g)!.join(" ");
    const copyBtn = h("button", { class: "btn ghost sm", type: "button", onClick: async () => { try { await navigator.clipboard.writeText(setup.secret); toast("Schlüssel kopiert."); } catch { toast("Kopieren nicht möglich – bitte markieren.", "error"); } } }, svg(icons.copy, 14), " Kopieren");
    const inp = codeInput();
    const submit = h("button", { class: "btn primary lg full", type: "submit" }, "Aktivieren");
    const form = h("form", { class: "form" }, field("Code aus der App", inp, "Sechs Ziffern, wechseln alle 30 Sekunden."), submit);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault(); submit.disabled = true;
      try {
        const r = await api.mfaEnable(inp.value);
        setUser(r.user); invalidate();
        showRecovery(r.recoveryCodes);
      } catch (e) { submit.disabled = false; inp.value = ""; inp.focus(); toast((e as Error).message, "error"); if (e instanceof HttpError && e.code === "too_many_attempts") navigate("/login"); }
    });
    body.replaceChildren(
      section("1 · App öffnen und Code scannen",
        h("div", { class: "qr-row" }, qr, h("div", null,
          h("p", null, "In der Authenticator-App „Konto hinzufügen“ wählen und diesen QR-Code scannen."),
          h("details", { class: "muted small" }, h("summary", null, "Kein Scanner? Schlüssel manuell eingeben"), h("p", { class: "mono" }, secretPretty), h("p", null, `Konto: ${setup.email} · Typ: zeitbasiert (TOTP) · 6 Ziffern`), copyBtn),
          h("p", { class: "muted small" }, "Am Handy: Link antippen – ", h("a", { href: setup.otpauth }, "in der App öffnen"), ".")))),
      section("2 · Ersten Code eingeben", form),
    );
    inp.focus();
  };

  const showRecovery = (codes: string[]) => {
    const text = codes.join("\n");
    const copy = h("button", { class: "btn ghost", type: "button", onClick: async () => { try { await navigator.clipboard.writeText(text); toast("Codes kopiert."); } catch { toast("Kopieren nicht möglich – bitte markieren.", "error"); } } }, svg(icons.copy, 16), " Kopieren");
    const dl = h("a", { class: "btn ghost", href: `data:text/plain;charset=utf-8,${encodeURIComponent(`Sammlerwert – Wiederherstellungscodes für ${state.user?.email ?? ""}\n\n${text}\n\nJeder Code funktioniert genau einmal. Bewahre die Datei sicher auf.`)}`, download: "sammlerwert-wiederherstellungscodes.txt" }, svg(icons.download, 16), " Als Datei");
    const check = h("input", { type: "checkbox" }) as HTMLInputElement;
    const done = h("button", { class: "btn primary lg full", disabled: true, onClick: () => { toast("Konto abgesichert."); navigate(next); } }, "Fertig – zur App");
    check.addEventListener("change", () => (done.disabled = !check.checked));
    body.replaceChildren(section("3 · Wiederherstellungscodes sichern",
      h("p", null, "Verlierst du dein Handy, kommst du mit einem dieser Codes ins Konto. Jeder Code gilt einmal. Wir zeigen sie nur jetzt."),
      h("ul", { class: "recovery-codes" }, ...codes.map((c) => h("li", { class: "mono" }, c))),
      h("div", { class: "actions-row" }, copy, dl),
      h("label", { class: "check" }, check, " Ich habe die Codes sicher gespeichert."),
      done));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  body.append(h("p", { class: "muted center" }, "Lade …"));
  start().catch((e) => { body.replaceChildren(h("p", { class: "muted" }, (e as Error).message)); });
  return root;
}

export function mfaVerifyView(_p: Record<string, string>, query: URLSearchParams): HTMLElement {
  const next = nextOf(query);
  if (state.user) { navigate(next, true); return h("div"); }
  if (!state.mfa) { navigate(`/login?next=${encodeURIComponent(next)}`, true); return h("div"); }
  const inp = codeInput("Code");
  inp.maxLength = 12; inp.inputMode = "text"; inp.removeAttribute("pattern"); inp.autocomplete = "one-time-code";
  const submit = h("button", { class: "btn primary lg full", type: "submit" }, "Anmelden");
  const form = h("form", { class: "form auth-form" }, field("Code aus der Authenticator-App", inp, "Oder einer deiner Wiederherstellungscodes (xxxxx-xxxxx)."), submit,
    h("p", { class: "muted center small" }, h("a", { href: "/login" }, "Anderes Konto")));
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); submit.disabled = true;
    try {
      const r = await api.mfaVerify(inp.value);
      setUser(r.user); invalidate();
      if (r.usedRecovery) toast(`Wiederherstellungscode verwendet – noch ${r.recoveryCodesLeft ?? "?"} übrig. Neue Codes gibt es in den Einstellungen.`);
      navigate(next);
    } catch (err) {
      submit.disabled = false; inp.value = ""; inp.focus(); toast((err as Error).message, "error");
      if (err instanceof HttpError && (err.code === "too_many_attempts" || err.status === 401)) { setMfa(null); navigate("/login"); }
    }
  });
  setTimeout(() => inp.focus(), 50);
  return h("div", { class: "page narrow" }, h("header", { class: "page-head center" }, h("div", null, h("p", { class: "eyebrow" }, "Zweiter Faktor"), h("h1", null, "Code eingeben"), h("p", { class: "muted" }, `Angemeldet als ${state.mfa.email}. Öffne deine Authenticator-App.`))), form);
}
