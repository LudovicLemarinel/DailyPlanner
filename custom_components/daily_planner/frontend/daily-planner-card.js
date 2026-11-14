/*
 * Daily Planner card for Home Assistant.
 * Served by the daily_planner integration — no build step, no dependency.
 */
const CARD_VERSION = "0.1.0";

const I18N = {
  fr: {
    days_short: ["L", "M", "M", "J", "V", "S", "D"],
    days_long: ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"],
    name: "Nom du programme",
    time: "Heure",
    days: "Jours",
    actions: "Actions",
    no_actions: "Aucune action. Ajoutez-en une ci-dessous.",
    add_action: "Action",
    add_json: "Avancé (JSON)",
    action: "Action (ex. light.turn_on)",
    entities: "Entités (séparées par des virgules)",
    data: "Données JSON (optionnel)",
    raw: "Action Home Assistant au format JSON",
    remove: "Supprimer l'action",
    save: "Enregistrer",
    saved: "Enregistré",
    test: "Tester",
    tested: "Actions lancées",
    delete: "Supprimer le programme",
    confirm_delete: "Supprimer définitivement ce programme ?",
    next_run: "Prochaine exécution",
    never: "aucune (programme désactivé ou aucun jour choisi)",
    not_saved: "Nouveau programme — enregistrez pour l'activer.",
    unsaved: "Modifications non enregistrées",
    edit: "Modifier",
    close: "Fermer",
    invalid_json: "JSON invalide",
    missing_action: "Chaque action doit avoir un service (ex. light.turn_on)",
    not_installed:
      "L'intégration Daily Planner n'est pas configurée. Ajoutez-la dans Paramètres › Appareils et services.",
    no_id: "Configurez schedule_id dans la carte.",
    editor_schedule: "Programme",
    editor_new: "➕ Nouveau programme",
    editor_id: "Identifiant (lettres minuscules, chiffres, _)",
    editor_name: "Nom par défaut",
  },
  en: {
    days_short: ["M", "T", "W", "T", "F", "S", "S"],
    days_long: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
    name: "Schedule name",
    time: "Time",
    days: "Days",
    actions: "Actions",
    no_actions: "No action yet. Add one below.",
    add_action: "Action",
    add_json: "Advanced (JSON)",
    action: "Action (e.g. light.turn_on)",
    entities: "Entities (comma separated)",
    data: "JSON data (optional)",
    raw: "Home Assistant action as JSON",
    remove: "Remove action",
    save: "Save",
    saved: "Saved",
    test: "Run now",
    tested: "Actions started",
    delete: "Delete schedule",
    confirm_delete: "Permanently delete this schedule?",
    next_run: "Next run",
    never: "none (schedule disabled or no day selected)",
    not_saved: "New schedule — save it to activate it.",
    unsaved: "Unsaved changes",
    edit: "Edit",
    close: "Close",
    invalid_json: "Invalid JSON",
    missing_action: "Every action needs a service (e.g. light.turn_on)",
    not_installed:
      "The Daily Planner integration is not set up. Add it in Settings › Devices & services.",
    no_id: "Set schedule_id in the card configuration.",
    editor_schedule: "Schedule",
    editor_new: "➕ New schedule",
    editor_id: "Identifier (lowercase letters, digits, _)",
    editor_name: "Default name",
  },
};

const t = (hass, key) => {
  const lang = (hass && hass.language ? hass.language : "en").slice(0, 2);
  return (I18N[lang] || I18N.en)[key] ?? I18N.en[key];
};

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const randomId = () => "programme_" + Math.random().toString(36).slice(2, 8);

/* ---- action <-> editable row conversion ---------------------------------- */
function actionToRow(action) {
  const service = action.action ?? action.service;
  const known = new Set(["action", "service", "target", "data", "entity_id"]);
  const simple =
    typeof service === "string" &&
    Object.keys(action).every((k) => known.has(k)) &&
    (!action.target || Object.keys(action.target).every((k) => k === "entity_id"));
  if (!simple) return { kind: "raw", raw: JSON.stringify(action, null, 2) };
  let entities = action.target?.entity_id ?? action.entity_id ?? [];
  if (!Array.isArray(entities)) entities = [entities];
  const data = action.data && Object.keys(action.data).length ? JSON.stringify(action.data) : "";
  return { kind: "service", service, entities: entities.join(", "), data };
}

function rowToAction(row, hass) {
  if (row.kind === "raw") {
    try {
      return JSON.parse(row.raw);
    } catch (e) {
      throw new Error(`${t(hass, "invalid_json")}: ${e.message}`);
    }
  }
  const service = row.service.trim();
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(service)) throw new Error(t(hass, "missing_action"));
  const action = { action: service };
  const entities = row.entities.split(",").map((s) => s.trim()).filter(Boolean);
  if (entities.length) action.target = { entity_id: entities };
  if (row.data.trim()) {
    try {
      action.data = JSON.parse(row.data);
    } catch (e) {
      throw new Error(`${t(hass, "invalid_json")} (${service}): ${e.message}`);
    }
  }
  return action;
}

/* ========================================================================== */
class DailyPlannerCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._schedule = null; // last version from the server (null = not created)
    this._draft = null; // editable copy
    this._dirty = false;
    this._expanded = false;
    this._loaded = false;
    this._error = "";
    this._info = "";
    this._entityStamp = null;
  }

  static getConfigElement() {
    return document.createElement("daily-planner-card-editor");
  }

  static getStubConfig() {
    return { schedule_id: randomId(), name: "Mon programme" };
  }

  setConfig(config) {
    if (!config || !config.schedule_id) throw new Error("schedule_id is required");
    if (!/^[a-z0-9_]{1,64}$/.test(config.schedule_id))
      throw new Error("schedule_id must only contain a-z, 0-9 and _");
    const changed = !this._config || this._config.schedule_id !== config.schedule_id;
    this._config = config;
    if (changed) {
      this._loaded = false;
      this._dirty = false;
      if (this._hass) this._load();
    }
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._load();
      return;
    }
    // Refresh when the schedule changed elsewhere (other dashboard, automation…).
    const entityId = this._schedule?.entity_id;
    const state = entityId ? hass.states[entityId] : null;
    const stamp = state ? state.last_updated + JSON.stringify(state.attributes) + state.state : null;
    if (stamp && this._entityStamp && stamp !== this._entityStamp && !this._dirty) {
      this._entityStamp = stamp;
      this._load();
    } else if (stamp) {
      this._entityStamp = stamp;
    }
  }

  getCardSize() {
    return this._expanded ? 8 : 4;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  /* ---- server ------------------------------------------------------------ */
  async _load() {
    if (!this._hass || !this._config) return;
    try {
      const schedule = await this._hass.callWS({ type: "daily_planner/get", schedule_id: this._config.schedule_id });
      this._error = "";
      this._setSchedule(schedule);
    } catch (err) {
      this._error = /not set up|unknown command/i.test(err.message || err.code || "")
        ? t(this._hass, "not_installed")
        : err.message || String(err);
      this._setSchedule(null);
    }
  }

  _setSchedule(schedule) {
    this._schedule = schedule;
    const src = schedule || {
      name: this._config.name || "Programme",
      enabled: true,
      time: "07:00",
      days: [0, 1, 2, 3, 4],
      actions: [],
    };
    this._draft = {
      name: src.name,
      enabled: src.enabled,
      time: src.time,
      days: [...src.days],
      rows: src.actions.map(actionToRow),
    };
    this._dirty = false;
    this._loaded = true;
    if (!schedule) this._expanded = true;
    const state = schedule?.entity_id && this._hass.states[schedule.entity_id];
    if (state) this._entityStamp = state.last_updated + JSON.stringify(state.attributes) + state.state;
    this._render();
  }

  async _save() {
    let actions;
    try {
      actions = this._draft.rows.map((row) => rowToAction(row, this._hass));
    } catch (err) {
      return this._flash(err.message, true);
    }
    try {
      const saved = await this._hass.callWS({
        type: "daily_planner/save",
        schedule_id: this._config.schedule_id,
        name: this._draft.name.trim() || this._config.schedule_id,
        enabled: this._draft.enabled,
        time: this._draft.time,
        days: this._draft.days,
        actions,
      });
      this._setSchedule(saved);
      this._flash(t(this._hass, "saved"));
    } catch (err) {
      this._flash(err.message || String(err), true);
    }
  }

  async _toggle(enabled) {
    this._draft.enabled = enabled;
    if (!this._schedule) return this._markDirty();
    try {
      await this._hass.callService("switch", enabled ? "turn_on" : "turn_off", {
        entity_id: this._schedule.entity_id,
      });
      this._schedule.enabled = enabled;
    } catch (err) {
      this._flash(err.message || String(err), true);
    }
  }

  async _run() {
    try {
      await this._hass.callWS({ type: "daily_planner/run", schedule_id: this._config.schedule_id });
      this._flash(t(this._hass, "tested"));
    } catch (err) {
      this._flash(err.message || String(err), true);
    }
  }

  async _delete() {
    if (!confirm(t(this._hass, "confirm_delete"))) return;
    try {
      await this._hass.callWS({ type: "daily_planner/delete", schedule_id: this._config.schedule_id });
      this._setSchedule(null);
    } catch (err) {
      this._flash(err.message || String(err), true);
    }
  }

  /* ---- UI helpers -------------------------------------------------------- */
  _flash(message, isError = false) {
    this._error = isError ? message : "";
    this._info = isError ? "" : message;
    this._render();
    if (!isError) {
      clearTimeout(this._flashTimer);
      this._flashTimer = setTimeout(() => {
        this._info = "";
        this._render();
      }, 2500);
    }
  }

  _markDirty() {
    this._dirty = true;
    const save = this.shadowRoot.querySelector("#save");
    if (save) save.disabled = false;
    const status = this.shadowRoot.querySelector("#status");
    if (status) status.textContent = t(this._hass, "unsaved");
  }

  _nextRunText() {
    if (!this._schedule) return t(this._hass, "not_saved");
    const state = this._hass.states[this._schedule.entity_id];
    const next = state?.attributes?.next_run ?? this._schedule.next_run;
    if (!next) return `${t(this._hass, "next_run")} : ${t(this._hass, "never")}`;
    const date = new Date(next);
    const label = date.toLocaleString(this._hass.locale?.language || this._hass.language, {
      weekday: "long",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${t(this._hass, "next_run")} : ${label}`;
  }

  _datalists() {
    const services = [];
    for (const [domain, list] of Object.entries(this._hass.services || {}))
      for (const name of Object.keys(list)) services.push(`${domain}.${name}`);
    services.sort();
    const entities = Object.keys(this._hass.states).sort();
    return `
      <datalist id="dp-services">${services.map((s) => `<option value="${esc(s)}"></option>`).join("")}</datalist>
      <datalist id="dp-entities">${entities
        .map((e) => `<option value="${esc(e)}">${esc(this._hass.states[e].attributes.friendly_name || "")}</option>`)
        .join("")}</datalist>`;
  }

  _rowHtml(row, index) {
    const h = this._hass;
    if (row.kind === "raw") {
      return `
        <div class="action" data-index="${index}">
          <div class="action-fields">
            <label>${esc(t(h, "raw"))}
              <textarea data-field="raw" rows="5" spellcheck="false">${esc(row.raw)}</textarea>
            </label>
          </div>
          <button class="icon-btn remove" title="${esc(t(h, "remove"))}" data-remove="${index}">
            <ha-icon icon="mdi:delete-outline"></ha-icon>
          </button>
        </div>`;
    }
    return `
      <div class="action" data-index="${index}">
        <div class="action-fields">
          <label>${esc(t(h, "action"))}
            <input data-field="service" list="dp-services" value="${esc(row.service)}" placeholder="light.turn_on" autocomplete="off">
          </label>
          <label>${esc(t(h, "entities"))}
            <input data-field="entities" list="dp-entities" value="${esc(row.entities)}" placeholder="light.salon" autocomplete="off">
          </label>
          <label>${esc(t(h, "data"))}
            <input data-field="data" value="${esc(row.data)}" placeholder='{"brightness_pct": 50}' spellcheck="false">
          </label>
        </div>
        <button class="icon-btn remove" title="${esc(t(h, "remove"))}" data-remove="${index}">
          <ha-icon icon="mdi:delete-outline"></ha-icon>
        </button>
      </div>`;
  }

  /* ---- rendering --------------------------------------------------------- */
  _render() {
    if (!this._hass || !this._config) return;
    const h = this._hass;
    const d = this._draft;
    if (!this._loaded || !d) {
      this.shadowRoot.innerHTML = `<ha-card><div class="content">…</div></ha-card>`;
      return;
    }
    const daysLong = t(h, "days_long");
    const days = t(h, "days_short")
      .map(
        (label, i) =>
          `<button class="day ${d.days.includes(i) ? "on" : ""}" data-day="${i}" title="${esc(daysLong[i])}" aria-pressed="${d.days.includes(i)}">${esc(label)}</button>`
      )
      .join("");

    const actionsSummary = d.rows.length
      ? d.rows
          .map((r) => (r.kind === "raw" ? "JSON" : `${r.service}${r.entities ? " → " + r.entities : ""}`))
          .map((s) => `<li>${esc(s)}</li>`)
          .join("")
      : `<li class="muted">${esc(t(h, "no_actions"))}</li>`;

    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="header">
          <ha-icon icon="mdi:calendar-clock" class="${d.enabled ? "active" : ""}"></ha-icon>
          <input id="name" class="name" value="${esc(d.name)}" aria-label="${esc(t(h, "name"))}">
          <ha-switch id="enabled" ${d.enabled ? "checked" : ""}></ha-switch>
        </div>
        <div class="content ${d.enabled ? "" : "disabled"}">
          <div class="when">
            <input id="time" type="time" class="time" value="${esc(d.time)}" aria-label="${esc(t(h, "time"))}">
            <div class="days" role="group" aria-label="${esc(t(h, "days"))}">${days}</div>
          </div>
          <div class="next">${esc(this._nextRunText())}</div>

          <div class="section-title">
            <span>${esc(t(h, "actions"))} (${d.rows.length})</span>
            <button class="link" id="expand">${esc(t(h, this._expanded ? "close" : "edit"))}</button>
          </div>
          ${
            this._expanded
              ? `<div class="actions">
                   ${d.rows.length ? d.rows.map((r, i) => this._rowHtml(r, i)).join("") : `<div class="muted">${esc(t(h, "no_actions"))}</div>`}
                   <div class="add">
                     <button class="btn" id="add-service"><ha-icon icon="mdi:plus"></ha-icon>${esc(t(h, "add_action"))}</button>
                     <button class="btn" id="add-raw"><ha-icon icon="mdi:code-json"></ha-icon>${esc(t(h, "add_json"))}</button>
                   </div>
                 </div>
                 ${this._datalists()}`
              : `<ul class="summary">${actionsSummary}</ul>`
          }
        </div>
        ${this._error ? `<div class="msg error">${esc(this._error)}</div>` : ""}
        ${this._info ? `<div class="msg info">${esc(this._info)}</div>` : ""}
        <div class="footer">
          <span id="status" class="muted">${this._dirty ? esc(t(h, "unsaved")) : ""}</span>
          <span class="spacer"></span>
          ${this._schedule ? `<button class="icon-btn" id="delete" title="${esc(t(h, "delete"))}"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>` : ""}
          ${this._schedule ? `<button class="btn" id="run"><ha-icon icon="mdi:play"></ha-icon>${esc(t(h, "test"))}</button>` : ""}
          <button class="btn primary" id="save" ${this._dirty || !this._schedule ? "" : "disabled"}>${esc(t(h, "save"))}</button>
        </div>
      </ha-card>`;
    this._bind();
  }

  _bind() {
    const root = this.shadowRoot;
    const $ = (sel) => root.querySelector(sel);
    $("#name").addEventListener("input", (e) => {
      this._draft.name = e.target.value;
      this._markDirty();
    });
    const sw = $("#enabled");
    sw.checked = this._draft.enabled;
    sw.addEventListener("change", (e) => {
      this._toggle(e.target.checked);
      root.querySelector(".content").classList.toggle("disabled", !e.target.checked);
      root.querySelector(".header ha-icon").classList.toggle("active", e.target.checked);
    });
    $("#time").addEventListener("change", (e) => {
      if (!e.target.value) return;
      this._draft.time = e.target.value.slice(0, 5);
      this._markDirty();
    });
    root.querySelectorAll(".day").forEach((btn) =>
      btn.addEventListener("click", () => {
        const day = Number(btn.dataset.day);
        const set = new Set(this._draft.days);
        set.has(day) ? set.delete(day) : set.add(day);
        this._draft.days = [...set].sort();
        btn.classList.toggle("on", set.has(day));
        btn.setAttribute("aria-pressed", set.has(day));
        this._markDirty();
      })
    );
    $("#expand").addEventListener("click", () => {
      this._expanded = !this._expanded;
      this._render();
    });
    root.querySelectorAll(".action [data-field]").forEach((input) =>
      input.addEventListener("input", (e) => {
        const index = Number(e.target.closest(".action").dataset.index);
        this._draft.rows[index][e.target.dataset.field] = e.target.value;
        this._markDirty();
      })
    );
    root.querySelectorAll("[data-remove]").forEach((btn) =>
      btn.addEventListener("click", () => {
        this._draft.rows.splice(Number(btn.dataset.remove), 1);
        this._dirty = true;
        this._render();
      })
    );
    $("#add-service")?.addEventListener("click", () => {
      this._draft.rows.push({ kind: "service", service: "", entities: "", data: "" });
      this._dirty = true;
      this._render();
    });
    $("#add-raw")?.addEventListener("click", () => {
      this._draft.rows.push({ kind: "raw", raw: '{\n  "delay": "00:00:30"\n}' });
      this._dirty = true;
      this._render();
    });
    $("#save").addEventListener("click", () => this._save());
    $("#run")?.addEventListener("click", () => this._run());
    $("#delete")?.addEventListener("click", () => this._delete());
  }
}

const STYLE = `
  :host { display: block; }
  ha-card { overflow: hidden; }
  .header { display: flex; align-items: center; gap: 12px; padding: 16px 16px 4px; }
  .header ha-icon { color: var(--state-icon-color, var(--secondary-text-color)); }
  .header ha-icon.active { color: var(--state-active-color, var(--primary-color)); }
  .name { flex: 1; min-width: 0; font: inherit; font-size: 1.25rem; font-weight: 500;
    color: var(--primary-text-color); background: transparent; border: none;
    border-bottom: 1px solid transparent; padding: 2px 0; }
  .name:hover, .name:focus { border-bottom-color: var(--divider-color); outline: none; }
  .content { padding: 4px 16px 8px; transition: opacity .2s; }
  .content.disabled .when, .content.disabled .next { opacity: .5; }
  .when { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; margin: 8px 0; }
  .time { font: inherit; font-size: 2rem; font-weight: 300; letter-spacing: 1px;
    color: var(--primary-text-color); background: var(--secondary-background-color, transparent);
    border: 1px solid var(--divider-color); border-radius: 8px; padding: 4px 8px; color-scheme: light dark; }
  .days { display: flex; gap: 6px; flex-wrap: wrap; }
  .day { width: 36px; height: 36px; border-radius: 50%; cursor: pointer; font: inherit; font-weight: 500;
    border: 1px solid var(--divider-color); background: transparent; color: var(--secondary-text-color); }
  .day.on { background: var(--primary-color); border-color: var(--primary-color);
    color: var(--text-primary-color, #fff); }
  .next { font-size: .875rem; color: var(--secondary-text-color); margin-bottom: 8px; }
  .section-title { display: flex; justify-content: space-between; align-items: center;
    font-weight: 500; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--divider-color); }
  .summary { margin: 6px 0 0; padding-left: 20px; font-size: .875rem; color: var(--secondary-text-color); }
  .summary li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actions { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; }
  .action { display: flex; gap: 8px; align-items: flex-start; padding: 10px;
    border: 1px solid var(--divider-color); border-radius: 8px; }
  .action-fields { flex: 1; display: grid; gap: 8px; min-width: 0; }
  label { display: flex; flex-direction: column; gap: 2px; font-size: .75rem; color: var(--secondary-text-color); }
  label input, label textarea { font: inherit; font-size: .9rem; color: var(--primary-text-color);
    background: var(--card-background-color, transparent); border: 1px solid var(--divider-color);
    border-radius: 6px; padding: 6px 8px; min-width: 0; box-sizing: border-box; width: 100%; }
  textarea { font-family: var(--code-font-family, monospace) !important; resize: vertical; }
  .add { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn { display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: .875rem; font-weight: 500;
    cursor: pointer; border-radius: 18px; padding: 6px 14px; border: 1px solid var(--divider-color);
    background: transparent; color: var(--primary-color); --mdc-icon-size: 18px; }
  .btn.primary { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
  .btn:disabled { opacity: .4; cursor: default; }
  .icon-btn { border: none; background: transparent; cursor: pointer; color: var(--secondary-text-color);
    padding: 6px; border-radius: 50%; --mdc-icon-size: 20px; }
  .icon-btn:hover { background: var(--secondary-background-color); }
  .link { border: none; background: none; color: var(--primary-color); cursor: pointer; font: inherit; font-size: .875rem; }
  .footer { display: flex; align-items: center; gap: 8px; padding: 8px 16px 12px; }
  .spacer { flex: 1; }
  .muted { color: var(--secondary-text-color); font-size: .8rem; }
  .msg { margin: 0 16px 8px; padding: 8px 12px; border-radius: 6px; font-size: .875rem; }
  .msg.error { background: rgba(var(--rgb-error-color, 219, 68, 55), .12); color: var(--error-color, #db4437); }
  .msg.info { background: rgba(var(--rgb-success-color, 67, 160, 71), .12); color: var(--success-color, #43a047); }
`;

/* ========================================================================== */
class DailyPlannerCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._loadList();
  }

  async _loadList() {
    try {
      this._list = await this._hass.callWS({ type: "daily_planner/list" });
    } catch (e) {
      this._list = [];
    }
    this._render();
  }

  _emit() {
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
  }

  _render() {
    if (!this._config) return;
    const h = this._hass;
    const list = this._list || [];
    const current = this._config.schedule_id;
    const known = list.some((s) => s.id === current);
    const options = list
      .map((s) => `<option value="${esc(s.id)}" ${s.id === current ? "selected" : ""}>${esc(s.name)} (${esc(s.time)})</option>`)
      .join("");
    this.innerHTML = `
      <style>
        .dp-editor { display: grid; gap: 12px; }
        .dp-editor label { display: grid; gap: 4px; font-size: .875rem; color: var(--secondary-text-color); }
        .dp-editor select, .dp-editor input { font: inherit; padding: 8px; border-radius: 6px;
          border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
      </style>
      <div class="dp-editor">
        <label>${esc(t(h, "editor_schedule"))}
          <select id="pick">
            <option value="__new__" ${known ? "" : "selected"}>${esc(t(h, "editor_new"))}</option>
            ${options}
          </select>
        </label>
        ${
          known
            ? ""
            : `<label>${esc(t(h, "editor_id"))}<input id="sid" value="${esc(current)}" pattern="[a-z0-9_]+"></label>
               <label>${esc(t(h, "editor_name"))}<input id="name" value="${esc(this._config.name || "")}"></label>`
        }
      </div>`;
    this.querySelector("#pick").addEventListener("change", (e) => {
      const value = e.target.value;
      this._config = value === "__new__" ? { ...this._config, schedule_id: randomId() } : { ...this._config, schedule_id: value };
      this._emit();
      this._render();
    });
    this.querySelector("#sid")?.addEventListener("change", (e) => {
      const value = e.target.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
      if (!value) return;
      this._config = { ...this._config, schedule_id: value };
      this._emit();
    });
    this.querySelector("#name")?.addEventListener("change", (e) => {
      this._config = { ...this._config, name: e.target.value };
      this._emit();
    });
  }
}

if (!customElements.get("daily-planner-card")) customElements.define("daily-planner-card", DailyPlannerCard);
if (!customElements.get("daily-planner-card-editor"))
  customElements.define("daily-planner-card-editor", DailyPlannerCardEditor);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "daily-planner-card")) {
  window.customCards.push({
    type: "daily-planner-card",
    name: "Daily Planner",
    description: "Planifier des actions à une heure donnée, certains jours de la semaine.",
    preview: false,
    documentationURL: "https://github.com/LudovicLemarinel/DailyPlanner",
  });
}

console.info(`%c DAILY-PLANNER-CARD %c v${CARD_VERSION} `, "color:#fff;background:#03a9f4;font-weight:700", "color:#03a9f4");
