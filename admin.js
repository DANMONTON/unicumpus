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
    ["admin_whatsapp", "Admin WhatsApp number (buyers can ask you questions, with country code)", "text"],
  ];
  let orders = [], names = {}, contacts = {}, me = null;

  let t;
  const toast = (m) => { const e = $("toast"); e.textContent = m; e.classList.add("show"); clearTimeout(t); t = setTimeout(() => e.classList.remove("show"), 3400); };

  async function init() {
    const { data } = await db.auth.getSession();
    if (!data.session) { $("gate").innerHTML = 'Please <a href="./">log in on the main page</a> with your admin account, then come back.'; return; }
    const { data: ok } = await db.rpc("is_admin");
    if (ok !== true) { $("gate").textContent = "This account is not an admin."; return; }
    me = data.session.user.id;
    $("gate").classList.add("hidden");
    $("app").classList.remove("hidden");
    loadOrders(); loadSettings();
  }

  document.querySelector(".tabs").addEventListener("click", (e) => {
    const tab = e.target.dataset.tab;
    if (!tab) return;
    document.querySelectorAll(".tabs .btn").forEach((b) => b.classList.toggle("on", b === e.target));
    ["orders", "reports", "users", "settings"].forEach((x) => $("tab-" + x).classList.toggle("hidden", x !== tab));
    if (tab === "reports") loadReports();
    if (tab === "users") loadTraffic();
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
      <div class="btns">${btns}${b("report", "Evidence report")}${b("msgs", "Messages")}</div>
      <div class="thread hidden"></div></div>`;
  }

  // ---------- evidence: reports, chat, CSV ----------
  const download = (name, text, type) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const who = (id) => (id ? names[id] || "Admin" : "System");

  async function evidenceReport(o) {
    const [ev, ms] = await Promise.all([
      db.from("order_events").select("*").eq("order_id", o.id).order("created_at"),
      db.from("order_messages").select("*").eq("order_id", o.id).order("created_at"),
    ]);
    if (ev.error || ms.error) return toast("Could not build report: " + (ev.error || ms.error).message);
    const events = ev.data.map((e) => `<tr><td>${esc(new Date(e.created_at).toLocaleString())}</td><td>${esc(e.event)}</td><td>${esc(who(e.actor))}</td><td><pre>${esc(JSON.stringify(e.detail, null, 1))}</pre></td></tr>`).join("");
    const msgs = ms.data.map((m) => `<tr><td>${esc(new Date(m.created_at).toLocaleString())}</td><td>${esc(who(m.sender_id))}</td><td>${esc(m.body)}</td></tr>`).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Evidence ${esc(o.id)}</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;color:#111}table{border-collapse:collapse;width:100%;margin:8px 0 20px}td,th{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top;font-size:13px}pre{margin:0;white-space:pre-wrap;font-size:12px}h1{font-size:20px}h2{font-size:16px}</style></head><body>
<h1>Campus Market: transaction evidence report</h1>
<p>Order ID: <b>${esc(o.id)}</b><br>Generated: ${esc(new Date().toLocaleString())}</p>
<h2>Order</h2><table>
<tr><th>Item</th><td>${esc(o.listing_title)}</td></tr>
<tr><th>Buyer</th><td>${esc(who(o.buyer_id))} (${esc(o.buyer_id)})</td></tr>
<tr><th>Seller</th><td>${esc(who(o.seller_id))} (${esc(o.seller_id)})</td></tr>
<tr><th>Method</th><td>${esc(METHOD[o.method])}</td></tr>
<tr><th>Amount / fee / seller payout</th><td>${esc(money(o.amount))} / ${esc(money(o.fee_amount))} (${esc(o.fee_percent)}%) / ${esc(money(o.seller_payout))}</td></tr>
<tr><th>Status</th><td>${esc(o.status)}</td></tr>
<tr><th>Payer phone / payment ref</th><td>${esc(o.payer_phone || "-")} / ${esc(o.payment_ref || "-")}</td></tr>
<tr><th>Funds received</th><td>${esc(o.funds_received_at ? new Date(o.funds_received_at).toLocaleString() : "-")}</td></tr>
<tr><th>Buyer confirmed / seller confirmed</th><td>${esc(o.buyer_confirmed_at ? new Date(o.buyer_confirmed_at).toLocaleString() : "-")} / ${esc(o.seller_confirmed_at ? new Date(o.seller_confirmed_at).toLocaleString() : "-")}</td></tr>
<tr><th>Released / payout ref</th><td>${esc(o.released_at ? new Date(o.released_at).toLocaleString() : "-")} / ${esc(o.payout_ref || "-")}</td></tr>
<tr><th>Admin note</th><td>${esc(o.admin_note || "-")}</td></tr></table>
<h2>Timeline (automatic, cannot be edited)</h2><table><tr><th>When</th><th>Event</th><th>By</th><th>Details</th></tr>${events || '<tr><td colspan="4">No events</td></tr>'}</table>
<h2>Messages (cannot be edited)</h2><table><tr><th>When</th><th>From</th><th>Message</th></tr>${msgs || '<tr><td colspan="3">No messages</td></tr>'}</table>
<p style="color:#666;font-size:12px">Tip: open this file and use Print > Save as PDF to keep a copy.</p></body></html>`;
    download(`evidence-${o.id.slice(0, 8)}.html`, html, "text/html");
    toast("Evidence report downloaded");
  }

  async function loadAdminThread(o, box) {
    const { data, error } = await db.from("order_messages").select("*").eq("order_id", o.id).order("created_at");
    if (error) { box.textContent = "Could not load messages"; return; }
    box.innerHTML = (data.length
      ? data.map((m) => `<div class="msg"><b>${esc(m.sender_id === me ? "You (admin)" : who(m.sender_id))}</b> <span class="muted">${esc(new Date(m.created_at).toLocaleString())}</span><div>${esc(m.body)}</div></div>`).join("")
      : '<div class="muted">No messages yet.</div>') +
      '<div style="display:flex;gap:8px"><input data-f="msg" maxlength="1000" placeholder="Reply to buyer and seller..."><button class="btn primary" type="button" data-act="send">Send</button></div>';
  }

  const csvCell = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  $("exportCsv").addEventListener("click", () => {
    const head = ["order_id", "created", "item", "buyer", "seller", "method", "amount", "fee_percent", "fee_amount", "seller_payout", "status", "payer_phone", "payment_ref", "funds_received", "released", "payout_ref", "admin_note"];
    const rows = orders.map((o) => [o.id, o.created_at, o.listing_title, who(o.buyer_id), who(o.seller_id), o.method, o.amount, o.fee_percent, o.fee_amount, o.seller_payout, o.status, o.payer_phone, o.payment_ref, o.funds_received_at, o.released_at, o.payout_ref, o.admin_note]);
    download("campus-market-orders.csv", [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n"), "text/csv");
  });

  $("orders").addEventListener("click", async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    const panel = e.target.closest(".panel");
    const o = orders.find((x) => x.id === panel.dataset.id);
    if (act === "report") return evidenceReport(o);
    if (act === "msgs") {
      const th = panel.querySelector(".thread");
      th.classList.toggle("hidden");
      if (!th.classList.contains("hidden")) loadAdminThread(o, th);
      return;
    }
    if (act === "send") {
      const body = panel.querySelector("[data-f=msg]").value.trim();
      if (!body) return;
      const { error } = await db.from("order_messages").insert({ order_id: o.id, body });
      if (error) return toast("Could not send: " + error.message);
      return loadAdminThread(o, panel.querySelector(".thread"));
    }
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

  // ---------- users & traffic ----------
  let allUsers = [];

  const niceMax = (m) => {
    if (m <= 4) return 4;
    const p = 10 ** Math.floor(Math.log10(m));
    const n = m / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  };

  // Small dependency-free SVG chart. kind: "bar" or "line". series: [{name, color, values}]
  function chartSVG(labels, series, kind) {
    const n = labels.length;
    if (!n) return '<p class="muted">No data.</p>';
    const W = 640, H = 230, L = 38, R = 10, T = 10, B = 26;
    const iw = W - L - R, ih = H - T - B, band = iw / n;
    const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
    const cx = (i) => L + band * (i + 0.5);
    const y = (v) => T + ih - (v / max) * ih;
    let g = "";
    for (let k = 0; k <= 4; k++) {
      const v = (max * k) / 4;
      g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e7eb"/>` +
           `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="#6b7280">${Math.round(v)}</text>`;
    }
    const step = Math.max(1, Math.ceil(n / 7));
    labels.forEach((lb, i) => {
      if (i % step === 0 || i === n - 1) g += `<text x="${cx(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#6b7280">${esc(lb.slice(5))}</text>`;
    });
    let marks = "";
    series.forEach((s) => {
      if (kind === "bar") {
        marks += s.values.map((v, i) => `<rect x="${cx(i) - band * 0.35}" y="${y(v)}" width="${band * 0.7}" height="${Math.max(0, T + ih - y(v))}" rx="2" fill="${s.color}"><title>${esc(labels[i])}: ${v} ${esc(s.name)}</title></rect>`).join("");
      } else {
        marks += `<polyline fill="none" stroke="${s.color}" stroke-width="2" points="${s.values.map((v, i) => `${cx(i)},${y(v)}`).join(" ")}"/>`;
        if (n <= 31) marks += s.values.map((v, i) => `<circle cx="${cx(i)}" cy="${y(v)}" r="3" fill="${s.color}"><title>${esc(labels[i])}: ${v} ${esc(s.name)}</title></circle>`).join("");
      }
    });
    const legend = series.map((s) => `<span style="margin-right:14px"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${s.color};margin-right:5px"></span>${esc(s.name)}</span>`).join("");
    return `<div class="muted" style="margin-bottom:4px">${legend}</div><svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img">${g}${marks}</svg>`;
  }

  async function loadTraffic() {
    const days = Number($("range").value) || 30;
    const [users, su, vi, tot] = await Promise.all([
      db.rpc("admin_user_list"), db.rpc("admin_signups_by_day", { p_days: days }),
      db.rpc("admin_visits_by_day", { p_days: days }), db.rpc("admin_traffic_totals", { p_days: days }),
    ]);
    const err = users.error || su.error || vi.error || tot.error;
    if (err) { $("uStats").innerHTML = ""; return toast("Run schema_v6.sql first: " + err.message); }
    allUsers = users.data || [];
    const t = (tot.data && tot.data[0]) || {};
    const last7 = allUsers.filter((u) => new Date(u.joined) > new Date(Date.now() - 7 * 864e5)).length;
    const today = new Date().toDateString();
    const newToday = allUsers.filter((u) => new Date(u.joined).toDateString() === today).length;
    $("uStats").innerHTML = `
      <div class="stat">Registered users<b>${allUsers.length}</b></div>
      <div class="stat">New today / last 7 days<b>${newToday} / ${last7}</b></div>
      <div class="stat">Visits (${days} days)<b>${Number(t.visits || 0)}</b></div>
      <div class="stat">Unique visitors<b>${Number(t.unique_visitors || 0)}</b></div>`;
    $("chartVisits").innerHTML = chartSVG(vi.data.map((r) => r.day), [
      { name: "visits", color: "#0f9d6b", values: vi.data.map((r) => Number(r.visits)) },
      { name: "unique visitors", color: "#2563eb", values: vi.data.map((r) => Number(r.unique_visitors)) },
    ], "line");
    $("chartSignups").innerHTML = chartSVG(su.data.map((r) => r.day), [
      { name: "new accounts", color: "#0f9d6b", values: su.data.map((r) => Number(r.signups)) },
    ], "bar");
    renderUsers();
  }
  $("range").addEventListener("change", loadTraffic);

  function renderUsers() {
    const q = $("uSearch").value.trim().toLowerCase();
    const list = allUsers.filter((u) => !q || [u.name, u.email, u.school_name].join(" ").toLowerCase().includes(q));
    $("uCount").textContent = `(${list.length} of ${allUsers.length})`;
    const d = (v) => (v ? new Date(v).toLocaleDateString() : "-");
    $("uTable").innerHTML = "<tr><th>Name</th><th>Email</th><th>School</th><th>Joined</th><th>Last login</th><th>Listings</th></tr>" +
      list.slice(0, 500).map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.school_name || "-")}</td><td>${esc(d(u.joined))}</td><td>${esc(d(u.last_seen))}</td><td>${esc(u.listing_count)}</td></tr>`).join("");
  }
  $("uSearch").addEventListener("input", renderUsers);

  $("exportUsers").addEventListener("click", () => {
    const head = ["name", "email", "school", "joined", "last_login", "listings"];
    const rows = allUsers.map((u) => [u.name, u.email, u.school_name, u.joined, u.last_seen, u.listing_count]);
    download("campus-market-users.csv", [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n"), "text/csv");
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
