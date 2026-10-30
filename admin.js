(() => {
  "use strict";
  const db = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => `${CONFIG.CURRENCY}${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  const METHOD = { airtel: "Airtel Money", tnm: "TNM Mpamba" };
  const FIELDS = [
    ["free_until", "Free period ends (date)", "date"], ["fee_percent", "Fee % after free period", "number"],
    ["hold_hours", "Hold hours after both confirm", "number"], ["airtel_number", "Airtel Money number", "text"],
    ["airtel_name", "Airtel registered name", "text"], ["tnm_number", "TNM Mpamba number", "text"],
    ["tnm_name", "TNM registered name", "text"],
  ];
  let orders = [], names = {}, contacts = {};

  let t;
  const toast = (m) => { const e = $("toast"); e.textContent = m; e.classList.add("show"); clearTimeout(t); t = setTimeout(() => e.classList.remove("show"), 3400); };

  async function init() {
    const { data } = await db.auth.getSession();
    if (!data.session) { $("gate").innerHTML = 'Please <a href="./">log in on the main page</a> with your admin account, then come back.'; return; }
    const { data: ok } = await db.rpc("is_admin");
    if (ok !== true) { $("gate").textContent = "This account is not an admin."; return; }
    $("gate").classList.add("hidden");
    $("app").classList.remove("hidden");
    loadOrders(); loadSettings();
  }

  document.querySelector(".tabs").addEventListener("click", (e) => {
    const tab = e.target.dataset.tab;
    if (!tab) return;
    document.querySelectorAll(".tabs .btn").forEach((b) => b.classList.toggle("on", b === e.target));
    ["orders", "reports", "settings"].forEach((x) => $("tab-" + x).classList.toggle("hidden", x !== tab));
    if (tab === "reports") loadReports();
  });

  // ---------- payments ----------
  async function loadOrders() {
    const { data, error } = await db.from("orders").select("*").order("created_at", { ascending: false }).limit(300);
    if (error) return toast("Could not load orders");
    orders = data;
    const ids = [...new Set(orders.flatMap((o) => [o.buyer_id, o.seller_id]))];
    if (ids.length) {
      const { data: ps } = await db.from("profiles").select("id,user_name,business_name").in("id", ids);
      (ps || []).forEach((p) => (names[p.id] = p.user_name + (p.business_name ? ` (${p.business_name})` : "")));
    }
    const lids = orders.map((o) => o.listing_id).filter(Boolean);
    if (lids.length) {
      const { data: cs } = await db.from("contacts").select("*").in("listing_id", lids);
      (cs || []).forEach((c) => (contacts[c.listing_id] = c.contact));
    }
    renderOrders();
  }

  function renderOrders() {
    const sum = (st) => orders.filter((o) => st.includes(o.status));
    const held = sum(["held", "confirmed", "disputed"]).reduce((a, o) => a + Number(o.amount), 0);
    const fees = sum(["released"]).reduce((a, o) => a + Number(o.fee_amount), 0);
    $("stats").innerHTML = `
      <div class="stat">Money you hold<b>${esc(money(held))}</b></div>
      <div class="stat">Fees earned<b>${esc(money(fees))}</b></div>
      <div class="stat">To verify<b>${sum(["payment_submitted"]).length}</b></div>
      <div class="stat">Disputes<b>${sum(["disputed"]).length}</b></div>`;
    const f = $("statusFilter").value;
    const now = new Date();
    const list = orders.filter((o) => f === "all" ? true : f ? o.status === f
      : ["payment_submitted", "disputed"].includes(o.status) || (o.status === "confirmed" && new Date(o.release_after) <= now));
    $("orders").innerHTML = list.length ? list.map(orderHTML).join("") : '<p class="muted">Nothing here.</p>';
  }
  $("statusFilter").addEventListener("change", renderOrders);

  function orderHTML(o) {
    const due = o.release_after && new Date(o.release_after) <= new Date();
    const b = (a, label, cls = "btn") => `<button class="${cls}" data-act="${a}">${label}</button>`;
    let btns = "";
    if (o.status === "payment_submitted") btns = b("received", "Money received", "btn primary") + b("reject", "Reject payment", "btn danger");
    if (o.status === "held") btns = b("refund", "Refund buyer", "btn danger");
    if (o.status === "confirmed") btns = (due ? b("release", "Release to seller", "btn primary") : `<span class="muted">Release unlocks ${esc(new Date(o.release_after).toLocaleString())}</span>`) + b("refund", "Refund buyer", "btn danger");
    if (o.status === "disputed") btns = b("release", "Release to seller", "btn primary") + b("refund", "Refund buyer", "btn danger");
    return `<div class="panel" data-id="${esc(o.id)}">
      <div><b>${esc(o.listing_title)}</b> <span class="chip">${esc(o.status)}</span></div>
      <div>Buyer: ${esc(names[o.buyer_id] || "?")} · Seller: ${esc(names[o.seller_id] || "?")}</div>
      <div>${esc(METHOD[o.method])} · amount <b>${esc(money(o.amount))}</b> · fee ${esc(money(o.fee_amount))} (${esc(o.fee_percent)}%) · <b>pay seller ${esc(money(o.seller_payout))}</b></div>
      ${o.payment_ref ? `<div>Paid from ${esc(o.payer_phone)} · ref <b>${esc(o.payment_ref)}</b></div>` : ""}
      ${["confirmed", "disputed"].includes(o.status) && contacts[o.listing_id] ? `<div>Seller contact: ${esc(contacts[o.listing_id])}</div>` : ""}
      ${o.payout_ref ? `<div class="muted">Payout ref: ${esc(o.payout_ref)}</div>` : ""}
      ${o.admin_note ? `<div class="muted">Note: ${esc(o.admin_note)}</div>` : ""}
      <div class="btns">${btns}</div></div>`;
  }

  $("orders").addEventListener("click", async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    const o = orders.find((x) => x.id === e.target.closest(".panel").dataset.id);
    let text = null;
    if (act === "release") {
      text = prompt(`First send ${money(o.seller_payout)} to the seller by ${METHOD[o.method]}.\nThen enter the payout transaction ID:`);
      if (!text) return;
    } else if (act === "refund" || act === "reject") {
      text = prompt("Reason / note (shown to nobody but admins). Refund the buyer by mobile money yourself.");
      if (text === null) return;
    } else if (!confirm(`Confirm you saw ${money(o.amount)} arrive in the ${METHOD[o.method]} account (ref ${o.payment_ref})?`)) return;
    const { error } = await db.rpc("admin_order_action", { p_order: o.id, p_action: act, p_text: text });
    if (error) return toast(error.message);
    toast("Updated");
    loadOrders();
  });

  // ---------- reports ----------
  async function loadReports() {
    const { data, error } = await db.from("reports").select("*").order("created_at", { ascending: false }).limit(100);
    if (error) return toast("Could not load reports");
    const ids = [...new Set(data.map((r) => r.listing_id))];
    const { data: ls } = ids.length ? await db.from("listings").select("id,title,seller_name").in("id", ids) : { data: [] };
    const m = Object.fromEntries((ls || []).map((l) => [l.id, l]));
    $("reports").innerHTML = data.length ? data.map((r) => `<div class="panel" data-lid="${esc(r.listing_id)}">
        <div><b>${esc(m[r.listing_id]?.title || "(listing deleted)")}</b> <span class="muted">by ${esc(m[r.listing_id]?.seller_name || "?")}</span></div>
        <div>${esc(r.reason)}</div><div class="muted">${esc(new Date(r.created_at).toLocaleString())}</div>
        ${m[r.listing_id] ? '<div class="btns"><button class="btn danger" data-del>Delete listing</button></div>' : ""}</div>`).join("")
      : '<p class="muted">No reports.</p>';
  }
  $("reports").addEventListener("click", async (e) => {
    if (!("del" in e.target.dataset)) return;
    if (!confirm("Delete this listing permanently?")) return;
    const { error } = await db.from("listings").delete().eq("id", e.target.closest(".panel").dataset.lid);
    if (error) return toast("Could not delete (a held order may be attached)");
    toast("Listing deleted");
    loadReports();
  });

  // ---------- settings ----------
  async function loadSettings() {
    const { data } = await db.from("settings").select("*");
    const s = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
    $("settingsForm").innerHTML = FIELDS.map(([k, label, type]) =>
      `<label>${esc(label)}<input name="${k}" type="${type}" ${type === "number" ? 'step="0.1" min="0"' : ""} value="${esc(s[k] || "")}"></label>`).join("") +
      '<button class="btn primary" type="submit">Save settings</button>';
  }
  $("settingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const rows = FIELDS.map(([k]) => ({ key: k, value: String(new FormData(e.target).get(k) ?? "").trim() }));
    if (!rows.find((r) => r.key === "free_until").value) return toast("Set the free period end date");
    const { error } = await db.from("settings").upsert(rows);
    toast(error ? "Could not save settings" : "Settings saved");
  });

  init();
})();
