(() => {
  "use strict";

  // persistSession keeps the login after the page is closed or refreshed.
  const db = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const $ = (id) => document.getElementById(id);

  const CATEGORIES = ["Books & Notes", "Electronics", "Clothing & Shoes", "Furniture & Room", "Kitchen & Appliances", "Services", "Other"];
  const CONDITIONS = ["New", "Like new", "Good", "Fair"];
  const ICONS = {
    "Books & Notes": "📚", "Electronics": "💻", "Clothing & Shoes": "👟",
    "Furniture & Room": "🛏️", "Kitchen & Appliances": "🍳", "Services": "🛠️", "Other": "📦",
  };

  let user = null;
  let mineOnly = false;
  let kind = "sell"; // "sell" = items for sale, "want" = "I want" requests
  try { kind = localStorage.getItem("kind") === "want" ? "want" : "sell"; } catch {}
  let authMode = "login";
  let listings = [];
  let isAdmin = false;
  let settings = {};
  const profiles = {};

  // ---------- helpers ----------
  // Everything that comes from the database is escaped before it touches innerHTML.
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => `${CONFIG.CURRENCY}${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  const priceText = (l) => (l.kind === "want" ? (Number(l.price) > 0 ? "Budget " + money(l.price) : "Wanted") : money(l.price));
  const safeImg = (u) => (typeof u === "string" && u.startsWith("https://") ? u : null);

  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3400);
  }

  function fillSelect(sel, items, withAll) {
    sel.innerHTML = (withAll ? `<option value="">${esc(typeof withAll === "string" ? withAll : "All categories")}</option>` : "") +
      items.map((i) => `<option value="${esc(i)}">${esc(i)}</option>`).join("");
  }

  function setBusy(btn, busy, label) {
    btn.disabled = busy;
    if (label) btn.textContent = label;
  }

  // ---------- auth ----------
  function renderAuthUI() {
    $("btnAuth").textContent = user ? "Log out" : "Log in";
    for (const id of ["btnMine", "btnOrders", "btnProfile"]) $(id).classList.toggle("hidden", !user);
    $("btnAdmin").classList.toggle("hidden", !isAdmin);
    $("btnSignup").classList.toggle("hidden", !!user);
    // Who is logged in: top-left corner
    const w = $("whoami");
    if (user) {
      const nm = profiles[user.id]?.user_name || user.user_metadata?.full_name || (user.email || "").split("@")[0] || "Student";
      w.innerHTML = `${avatarHTML(profiles[user.id] || { user_name: nm }, "av sm")}<span class="who-txt"><b>${esc(nm)}</b><small>Logged in</small></span>`;
      w.classList.add("in");
    } else {
      w.innerHTML = '<span class="av sm ph">?</span><span class="who-txt"><b>Guest</b><small>Not logged in · tap to log in</small></span>';
      w.classList.remove("in");
    }
  }

  function setAuthMode(mode) {
    authMode = mode;
    const signup = mode === "signup";
    $("authTitle").textContent = signup ? "Create account" : "Log in";
    $("authSubmit").textContent = signup ? "Sign up" : "Log in";
    $("nameRow").classList.toggle("hidden", !signup);
    $("schoolRow").classList.toggle("hidden", !signup);
    $("authSwitchText").textContent = signup ? "Already have an account?" : "New here?";
    $("authSwitch").textContent = signup ? "Log in" : "Create an account";
    $("authPass").autocomplete = signup ? "new-password" : "current-password";
  }

  function openAuth(mode = "login") {
    setAuthMode(mode);
    $("authDialog").showModal();
  }

  $("btnAuth").addEventListener("click", async () => {
    if (user) {
      await db.auth.signOut();
      clearDraft();
      toast("Logged out");
    } else {
      openAuth("login");
    }
  });
  $("btnSignup").addEventListener("click", () => openAuth("signup"));
  $("whoami").addEventListener("click", () => (user ? $("btnProfile").click() : openAuth("login")));
  $("authSwitch").addEventListener("click", () => setAuthMode(authMode === "login" ? "signup" : "login"));

  $("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("authEmail").value.trim().toLowerCase();
    const password = $("authPass").value;

    if (CONFIG.ALLOWED_EMAIL_DOMAIN && !email.endsWith("@" + CONFIG.ALLOWED_EMAIL_DOMAIN)) {
      return toast(`Please use your @${CONFIG.ALLOWED_EMAIL_DOMAIN} campus email`);
    }

    const btn = $("authSubmit");
    const label = btn.textContent;
    setBusy(btn, true);
    try {
      if (authMode === "signup") {
        const name = $("authName").value.trim();
        if (!name) return toast("Please enter your name");
        const school = $("authSchool").value;
        if (!school) return toast("Please choose your school");
        const options = { data: { full_name: name, school } };
        try { localStorage.setItem("school", school); } catch {}
        if (location.protocol.startsWith("http")) options.emailRedirectTo = location.origin + location.pathname;
        const { data, error } = await db.auth.signUp({ email, password, options });
        if (error) return toast(error.message);
        // Supabase returns no error for an email that already exists; the user comes back with no identities.
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          setAuthMode("login");
          return toast("This email is already registered. Please log in instead.");
        }
        toast(data.session ? "Welcome to Campus Market!" : "Account created. Check your inbox (and spam) for the confirmation link.");
      } else {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) return toast(error.message);
        toast("Logged in");
      }
      $("authForm").reset();
      $("authDialog").close();
    } finally {
      setBusy(btn, false, label);
    }
  });

  // ---------- listings ----------
  async function loadListings() {
    const term = $("fSearch").value.trim().replace(/[%_\\]/g, "\\$&");
    const cat = $("fCategory").value;
    const sort = $("fSort").value;

    let q = db.from("listings").select("*").limit(80);
    if (mineOnly && user) q = q.eq("seller_id", user.id);
    else q = q.eq("status", "available").eq("kind", kind);
    const school = $("fSchool").value;
    if (school && !mineOnly) q = q.eq("school", school);
    if (cat) q = q.eq("category", cat);
    if (term) q = q.ilike("title", `%${term}%`);
    if (sort === "low") q = q.order("price", { ascending: true });
    else if (sort === "high") q = q.order("price", { ascending: false });
    else q = q.order("created_at", { ascending: false });

    const { data, error } = await q;
    if (error) {
      toast("Could not load listings");
      return;
    }
    listings = data || [];
    await loadProfiles(listings.map((l) => l.seller_id));
    renderGrid();
  }

  function renderGrid() {
    $("listTitle").textContent = mineOnly ? "My listings" : kind === "want" ? "What students want" : "Latest listings";
    $("btnMine").textContent = mineOnly ? "All listings" : "My listings";
    $("empty").classList.toggle("hidden", listings.length > 0);
    $("empty").textContent = mineOnly
      ? "You haven't posted anything yet."
      : kind === "want" ? "No requests yet. Post what you want!" : "Nothing here yet. Be the first to post an item!";

    $("grid").innerHTML = listings.map((l) => {
      const img = safeImg(l.image_url);
      return `
        <button class="card" type="button" data-id="${esc(l.id)}">
          <div class="thumb">
            ${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : esc(ICONS[l.category] || "📦")}
            ${l.kind === "want" ? '<span class="badge want">I WANT</span>' : l.status !== "available" ? `<span class="badge">${esc(l.status.toUpperCase())}</span>` : ""}
          </div>
          <div class="card-body">
            <div class="price">${esc(priceText(l))}</div>
            <div class="card-title">${esc(l.title)}</div>
            <div class="meta">${esc(l.condition)} · ${esc(l.category)}</div>
            <div class="seller-mini">${avatarHTML(profiles[l.seller_id] || { user_name: l.seller_name }, "av sm")}<span>${esc(profiles[l.seller_id]?.user_name || l.seller_name)}</span></div>
          </div>
        </button>`;
    }).join("");
  }

  $("grid").addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (!card) return;
    const l = listings.find((x) => x.id === card.dataset.id);
    if (l) openDetail(l);
  });

  // ---------- detail ----------
  async function openDetail(l) {
    const mine = user && user.id === l.seller_id;
    const img = safeImg(l.image_url);
    const when = new Date(l.created_at).toLocaleDateString();

    $("detailBody").innerHTML = `
      <div style="position:relative">
        <div class="photo">${img ? `<img src="${esc(img)}" alt="">` : esc(ICONS[l.category] || "📦")}</div>
        <div class="close-row"><button class="x" type="button" data-close aria-label="Close">&times;</button></div>
      </div>
      <div class="content">
        <div class="price">${esc(priceText(l))}${l.status === "sold" ? (l.kind === "want" ? " · FOUND" : " · SOLD") : ""}</div>
        <h3>${esc(l.title)}</h3>
        <div class="chips">
          <span class="chip">${esc(l.category)}</span>
          <span class="chip">${esc(l.condition)}</span>
          <span class="chip">Posted ${esc(when)}</span>
        </div>
        ${l.description ? `<p class="desc">${esc(l.description)}</p>` : ""}
        <div class="muted" id="sellerLine">Seller: ${esc(l.seller_name)}</div>
        <div class="actions" id="detailActions"><span class="muted">Loading contact...</span></div>
        <div class="comments">
          <h4>Comments</h4>
          <div id="commentList" class="muted">Loading...</div>
          ${user
            ? '<form id="commentForm" class="cform"><input id="commentText" maxlength="500" placeholder="Write a comment or question..." required><button class="btn primary" type="submit">Post</button></form>'
            : '<p class="muted">Log in to comment.</p>'}
        </div>
      </div>`;
    $("detailDialog").showModal();

    const actions = $("detailActions");
    actions.innerHTML = "";

    if (!user) {
      actions.innerHTML = '<button class="btn primary" type="button" id="dLogin">Log in to see seller contact</button>';
      $("dLogin").addEventListener("click", () => { $("detailDialog").close(); openAuth("login"); });
    } else {
      const { data } = await db.from("contacts").select("contact").eq("listing_id", l.id).maybeSingle();
      const contact = data?.contact || "";
      const digits = contact.replace(/\D/g, "");
      if (digits.length >= 9) {
        const msg = encodeURIComponent(l.kind === "want"
          ? `Hi, I saw your request for "${l.title}" on Campus Market. I have one for you.`
          : `Hi, I saw "${l.title}" on Campus Market. Is it still available?`);
        const a = document.createElement("a");
        a.className = "btn primary";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.href = `https://wa.me/${digits}?text=${msg}`;
        a.textContent = l.kind === "want" ? "I have this · WhatsApp" : "Chat on WhatsApp";
        actions.appendChild(a);
      }
      const p = document.createElement("div");
      p.className = "muted center";
      p.textContent = contact ? `Contact: ${contact}` : "No contact available";
      actions.appendChild(p);
    }

    if (mine) {
      if (l.status === "available") {
        const b = document.createElement("button");
        b.className = "btn"; b.type = "button"; b.textContent = l.kind === "want" ? "Mark as found" : "Mark as sold";
        b.addEventListener("click", () => markSold(l));
        actions.appendChild(b);
      }
      const d = document.createElement("button");
      d.className = "btn danger"; d.type = "button"; d.textContent = "Delete listing";
      d.addEventListener("click", () => deleteListing(l));
      actions.appendChild(d);
    } else if (user) {
      const r = document.createElement("button");
      r.className = "btn ghost"; r.type = "button"; r.textContent = "Report this listing";
      r.addEventListener("click", () => reportListing(l));
      actions.appendChild(r);
    }

    if (user && !mine && l.status === "available" && l.kind !== "want") {
      const b = document.createElement("button");
      b.className = "btn primary"; b.type = "button";
      b.textContent = `Buy securely · ${money(l.price)}`;
      b.addEventListener("click", () => openBuy(l));
      actions.prepend(b);
    }
    wireComments(l);
  }

  async function markSold(l) {
    const { error } = await db.from("listings").update({ status: "sold" }).eq("id", l.id);
    if (error) return toast("Could not update listing");
    $("detailDialog").close();
    toast("Marked as sold");
    loadListings();
  }

  async function deleteListing(l) {
    if (!confirm("Delete this listing? This cannot be undone.")) return;
    const { error } = await db.from("listings").delete().eq("id", l.id);
    if (error) return toast("Could not delete listing");
    if (l.image_path) await db.storage.from("listing-images").remove([l.image_path]);
    $("detailDialog").close();
    toast("Listing deleted");
    loadListings();
  }

  async function reportListing(l) {
    const reason = (prompt("Why are you reporting this listing? (scam, fake, offensive, etc.)") || "").trim();
    if (reason.length < 3) return;
    const { error } = await db.from("reports").insert({ listing_id: l.id, reason: reason.slice(0, 300) });
    toast(error ? "Could not send report" : "Thanks, we'll review it");
  }

  // ---------- sell / "I want" tabs + saved draft ----------
  const DRAFT_KEY = "postDraft";
  const DRAFT_IDS = ["pKind", "pTitle", "pCategory", "pCondition", "pPrice", "pDesc", "pContact"];
  function applyKind() {
    const want = $("pKind").value === "want";
    $("postTitle").textContent = want ? "I want an item" : "Sell an item";
    $("pPriceLabel").textContent = want ? "Budget (optional, 0 = any price)" : "Price";
    $("pPrice").required = !want;
    $("postSubmit").textContent = want ? "Post request" : "Post listing";
  }
  function saveDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(Object.fromEntries(DRAFT_IDS.map((i) => [i, $(i).value])))); } catch {}
  }
  function restoreDraft() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch {}
    if (d) DRAFT_IDS.forEach((i) => { if (d[i] != null) $(i).value = d[i]; });
    else $("pKind").value = kind;
    applyKind();
  }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch {} }
  $("postForm").addEventListener("input", () => { applyKind(); saveDraft(); });
  function syncTabs() {
    document.querySelectorAll("#kindTabs .btn").forEach((b) => b.classList.toggle("on", b.dataset.kind === kind));
  }
  $("kindTabs").addEventListener("click", (e) => {
    const k = e.target.dataset.kind;
    if (!k) return;
    kind = k;
    try { localStorage.setItem("kind", k); } catch {}
    mineOnly = false;
    syncTabs();
    loadListings();
  });

  // ---------- post a listing ----------
  $("btnPost").addEventListener("click", () => {
    if (!user) {
      toast("Log in to post an item");
      return openAuth("login");
    }
    restoreDraft();
    $("postDialog").showModal();
  });

  $("postForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!user) return toast("Please log in first");

    const btn = $("postSubmit");
    const label = btn.textContent;
    setBusy(btn, true, "Posting...");
    let imagePath = null;

    try {
      const file = $("pImage").files[0];
      let imageUrl = null;

      if (file) {
        const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[file.type];
        if (!ext) return toast("Photo must be JPG, PNG or WebP");
        if (file.size > 5 * 1024 * 1024) return toast("Photo must be under 5 MB");
        imagePath = `${user.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
        const up = await db.storage.from("listing-images").upload(imagePath, file, { contentType: file.type });
        if (up.error) { imagePath = null; return toast("Photo upload failed"); }
        imageUrl = db.storage.from("listing-images").getPublicUrl(imagePath).data.publicUrl;
      }

      const row = {
        title: $("pTitle").value.trim(),
        description: $("pDesc").value.trim() || null,
        price: Number($("pPrice").value) || 0,
        kind: $("pKind").value === "want" ? "want" : "sell",
        category: $("pCategory").value,
        condition: $("pCondition").value,
        seller_name: (user.user_metadata?.full_name || "Student").slice(0, 60),
        image_url: imageUrl,
        image_path: imagePath,
      };

      const { data, error } = await db.from("listings").insert(row).select("id").single();
      if (error) {
        if (imagePath) await db.storage.from("listing-images").remove([imagePath]);
        return toast("Could not post listing: " + error.message);
      }

      const c = await db.from("contacts").insert({ listing_id: data.id, contact: $("pContact").value.trim() });
      if (c.error) {
        await db.from("listings").delete().eq("id", data.id);
        if (imagePath) await db.storage.from("listing-images").remove([imagePath]);
        return toast("Could not save contact details: " + c.error.message);
      }

      kind = row.kind;
      try { localStorage.setItem("kind", kind); } catch {}
      clearDraft();
      syncTabs();
      $("postForm").reset();
      $("postDialog").close();
      toast("Your item is live!");
      mineOnly = false;
      loadListings();
    } finally {
      setBusy(btn, false, label);
    }
  });

  // ---------- misc UI ----------
  $("btnMine").addEventListener("click", () => {
    mineOnly = !mineOnly;
    loadListings();
  });

  let searchTimer;
  $("fSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadListings, 300);
  });
  $("fCategory").addEventListener("change", loadListings);
  $("fSchool").addEventListener("change", () => {
    try { localStorage.setItem("school", $("fSchool").value); } catch {}
    loadListings();
  });

  // Show the student's own campus by default (they can switch to "All campuses").
  async function applyDefaultSchool() {
    let s = "";
    try { s = localStorage.getItem("school") || ""; } catch {}
    if (user) {
      delete profiles[user.id];
      await loadProfiles([user.id]);
      s = profiles[user.id]?.school || user.user_metadata?.school || s;
    }
    if (s && (CONFIG.SCHOOLS || []).includes(s)) $("fSchool").value = s;
  }
  $("fSort").addEventListener("change", loadListings);

  // Close buttons + click on backdrop
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) e.target.closest("dialog").close();
    else if (e.target.tagName === "DIALOG") e.target.close();
  });

  // ---------- settings, fee banner, admin check ----------
  const freeNow = () => settings.free_until && new Date(settings.free_until + "T23:59:59") > new Date();
  const feePctNow = () => (freeNow() ? 0 : Number(settings.fee_percent || 3.5));

  async function loadSettings() {
    const { data } = await db.from("settings").select("*");
    settings = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
    const pct = settings.fee_percent || "3.5";
    $("feeBanner").textContent = freeNow()
      ? `🎉 No fees until ${new Date(settings.free_until).toLocaleDateString()}. After that, ${pct}% is deducted from the seller on completed sales.`
      : `Payments are held safely until both sides confirm. A ${pct}% fee is deducted from the seller on completed sales.`;
  }

  async function checkAdmin() {
    if (!user) { isAdmin = false; return; }
    const { data } = await db.rpc("is_admin");
    isAdmin = data === true;
  }

  // ---------- profiles ----------
  async function loadProfiles(ids) {
    const need = [...new Set(ids)].filter((i) => i && !profiles[i]);
    if (!need.length) return;
    const { data } = await db.from("profiles").select("*").in("id", need);
    (data || []).forEach((p) => (profiles[p.id] = p));
  }

  const avatarHTML = (p, cls = "av") => {
    const u = safeImg(p?.avatar_url);
    return u ? `<img class="${cls}" src="${esc(u)}" alt="">`
             : `<span class="${cls} ph">${esc((p?.user_name || "?")[0].toUpperCase())}</span>`;
  };

  $("btnProfile").addEventListener("click", async () => {
    delete profiles[user.id];
    await loadProfiles([user.id]);
    const p = profiles[user.id] || {};
    $("prName").value = p.user_name || "";
    $("prBiz").value = p.business_name || "";
    $("prLoc").value = p.location || "";
    $("prSchool").value = p.school || "";
    $("prAvatar").innerHTML = avatarHTML(p, "av big");
    $("profileDialog").showModal();
  });

  $("profileForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("prSubmit");
    setBusy(btn, true);
    try {
      const old = profiles[user.id] || {};
      const upd = {
        user_name: $("prName").value.trim(),
        business_name: $("prBiz").value.trim() || null,
        location: $("prLoc").value.trim() || null,
        school: $("prSchool").value || null,
        updated_at: new Date().toISOString(),
      };
      const file = $("prFile").files[0];
      if (file) {
        const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[file.type];
        if (!ext) return toast("Photo must be JPG, PNG or WebP");
        if (file.size > 2 * 1024 * 1024) return toast("Photo must be under 2 MB");
        const path = `${user.id}/${Date.now()}.${ext}`;
        const up = await db.storage.from("avatars").upload(path, file, { contentType: file.type });
        if (up.error) return toast("Photo upload failed");
        upd.avatar_path = path;
        upd.avatar_url = db.storage.from("avatars").getPublicUrl(path).data.publicUrl;
        if (old.avatar_path) await db.storage.from("avatars").remove([old.avatar_path]);
      }
      const { error } = await db.from("profiles").upsert({ id: user.id, ...upd });
      if (error) return toast("Could not save profile: " + error.message);
      delete profiles[user.id];
      $("profileForm").reset();
      $("profileDialog").close();
      toast("Profile saved");
      if (upd.school) $("fSchool").value = upd.school;
      loadListings();
      db.auth.updateUser({ data: { full_name: upd.user_name } });
    } finally {
      setBusy(btn, false);
    }
  });

  // ---------- comments ----------
  async function loadComments(l) {
    const box = $("commentList");
    if (!box) return;
    const { data, error } = await db.from("comments").select("*").eq("listing_id", l.id).order("created_at").limit(100);
    if (error) { box.textContent = "Could not load comments"; return; }
    await loadProfiles(data.map((c) => c.user_id).concat(l.seller_id));
    if (!$("commentList")) return; // dialog was closed meanwhile
    box.className = "";
    box.innerHTML = data.length ? data.map((c) => {
      const p = profiles[c.user_id];
      const canDel = user && (user.id === c.user_id || isAdmin);
      return `<div class="comment">${avatarHTML(p)}<div>
        <b>${esc(p?.user_name || "Student")}</b>
        <span class="muted">${esc(new Date(c.created_at).toLocaleDateString())}</span>
        ${canDel ? `<button class="linkbtn" type="button" data-del="${esc(c.id)}">delete</button>` : ""}
        <div class="ctext">${esc(c.body)}</div></div></div>`;
    }).join("") : '<div class="muted">No comments yet. Ask the seller a question!</div>';
    const sp = profiles[l.seller_id];
    if (sp) $("sellerLine").innerHTML = `<span class="seller-mini">${avatarHTML(sp)}<span>Seller: <b>${esc(sp.user_name)}</b></span></span>` +
      `${sp.business_name ? " · " + esc(sp.business_name) : ""}${sp.location ? " · 📍" + esc(sp.location) : ""}`;
  }

  function wireComments(l) {
    loadComments(l);
    $("commentForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = $("commentText").value.trim();
      if (!body) return;
      const { error } = await db.from("comments").insert({ listing_id: l.id, body });
      if (error) return toast("Could not post comment");
      $("commentText").value = "";
      loadComments(l);
    });
    $("commentList").addEventListener("click", async (e) => {
      const id = e.target.dataset.del;
      if (!id) return;
      await db.from("comments").delete().eq("id", id);
      loadComments(l);
    });
  }

  // ---------- buying (escrow) ----------
  let buying = null;
  function openBuy(l) {
    buying = l;
    const hrs = settings.hold_hours || 48;
    $("buyInfo").innerHTML = `<p><b>${esc(l.title)}</b><br>You pay <b>${esc(money(l.price))}</b>.</p>
      <p class="muted">Your money is held by Campus Market, not given to the seller yet. After you and the seller both confirm the item changed hands, the seller is paid ${esc(hrs)} hours later.</p>`;
    $("detailDialog").close();
    $("buyDialog").showModal();
  }

  $("buyForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("buySubmit");
    setBusy(btn, true);
    try {
      const { error } = await db.rpc("create_order", { p_listing: buying.id, p_method: $("buyMethod").value });
      if (error) return toast(error.message);
      $("buyDialog").close();
      toast("Order created. Follow the payment steps.");
      loadListings();
      openOrders();
    } finally {
      setBusy(btn, false);
    }
  });

  // ---------- orders ----------
  const STATUS = {
    awaiting_payment: "Awaiting payment", payment_submitted: "Verifying payment", held: "Money held safely",
    confirmed: "Confirmed, payout pending", released: "Completed", refunded: "Refunded",
    disputed: "In dispute", cancelled: "Cancelled",
  };
  const METHOD = { airtel: "Airtel Money", tnm: "TNM Mpamba" };

  async function openOrders() {
    $("ordersDialog").showModal();
    loadOrders();
  }
  $("btnOrders").addEventListener("click", openOrders);

  async function loadOrders() {
    const box = $("ordersList");
    box.textContent = "Loading...";
    const { data, error } = await db.from("orders").select("*")
      .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`).order("created_at", { ascending: false });
    if (error) { box.textContent = "Could not load orders"; return; }
    box.innerHTML = data.length ? data.map(orderHTML).join("") : '<p class="muted center">No orders yet.</p>';
  }

  function orderHTML(o) {
    const buyer = user.id === o.buyer_id;
    const mineDone = buyer ? o.buyer_confirmed_at : o.seller_confirmed_at;
    const num = settings[o.method + "_number"], nm = settings[o.method + "_name"];
    const btns = '<button class="btn" data-act="confirm">Confirm item handed over</button> <button class="btn danger" data-act="dispute">Report a problem</button>';
    let body = "";
    switch (o.status) {
      case "awaiting_payment":
        body = buyer
          ? `<p>1. Send <b>${esc(money(o.amount))}</b> by <b>${METHOD[o.method]}</b> to <b>${esc(num || "(number not set yet, ask admin)")}</b>${nm ? ` (${esc(nm)})` : ""}.<br>2. Enter the details from the payment SMS.</p>
             <input data-f="phone" placeholder="Phone you paid from" maxlength="20">
             <input data-f="ref" placeholder="Transaction ID" maxlength="60">
             <button class="btn primary" data-act="pay">I have paid</button> <button class="btn danger" data-act="cancel">Cancel order</button>`
          : "Waiting for the buyer to pay. Do not hand over the item yet.";
        break;
      case "payment_submitted":
        body = buyer ? "We are verifying your payment." : "Buyer says they paid. Do not hand over the item until the money is secured.";
        break;
      case "held":
        body = (buyer ? "Your money is safe. " : "Payment secured, you can meet the buyer. ") +
          (mineDone ? "You confirmed. Waiting for the other person." : "Meet on campus, then confirm once the item has changed hands.");
        body += mineDone ? ' <button class="btn danger" data-act="dispute">Report a problem</button>' : `<div class="actions">${btns}</div>`;
        break;
      case "confirmed":
        body = `Both sides confirmed. Seller is paid after ${esc(new Date(o.release_after).toLocaleString())}. <button class="btn danger" data-act="dispute">Report a problem</button>`;
        break;
      case "released": body = buyer ? "Done. The seller has been paid." : "Paid out to you. Thank you!"; break;
      case "refunded": body = "The buyer was refunded."; break;
      case "disputed": body = "Admin is reviewing this order."; break;
      default: body = "This order was cancelled.";
    }
    const fee = o.fee_amount > 0 ? ` · fee ${esc(money(o.fee_amount))} (${o.fee_percent}%)` : " · no fee";
    return `<div class="order" data-id="${esc(o.id)}">
      <div class="order-head"><b>${esc(o.listing_title)}</b><span class="chip">${esc(STATUS[o.status])}</span></div>
      <div class="muted">${buyer ? "Buying" : "Selling"} · ${esc(money(o.amount))}${buyer ? "" : ` · you receive ${esc(money(o.seller_payout))}${fee}`}</div>
      <div class="order-body">${body}</div></div>`;
  }

  $("ordersList").addEventListener("click", async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    const card = e.target.closest(".order");
    const id = card.dataset.id;
    let r;
    if (act === "pay") {
      const phone = card.querySelector("[data-f=phone]").value.trim();
      const ref = card.querySelector("[data-f=ref]").value.trim();
      if (phone.length < 5 || ref.length < 4) return toast("Enter your phone and the transaction ID");
      r = await db.rpc("submit_payment", { p_order: id, p_phone: phone, p_ref: ref });
    } else if (act === "cancel") r = await db.rpc("cancel_order", { p_order: id });
    else if (act === "confirm") r = await db.rpc("confirm_order", { p_order: id });
    else if (act === "dispute") {
      if (!confirm("Report a problem? Admin will review this order and decide.")) return;
      r = await db.rpc("dispute_order", { p_order: id });
    }
    if (r?.error) return toast(r.error.message);
    toast("Done");
    loadOrders();
    loadListings();
  });

  // ---------- start ----------
  async function init() {
    fillSelect($("fCategory"), CATEGORIES, true);
    fillSelect($("fSchool"), CONFIG.SCHOOLS || [], "All campuses");
    fillSelect($("authSchool"), CONFIG.SCHOOLS || [], "Choose your school...");
    fillSelect($("prSchool"), CONFIG.SCHOOLS || [], "Choose your school...");
    fillSelect($("pCategory"), CATEGORIES, false);
    fillSelect($("pCondition"), CONDITIONS, false);

    const { data } = await db.auth.getSession();
    user = data.session?.user ?? null;
    await db.rpc("expire_unpaid_orders");
    await Promise.all([loadSettings(), checkAdmin()]);
    await applyDefaultSchool();
    renderAuthUI();
    syncTabs();
    loadListings();

    db.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION") return;
      user = session?.user ?? null;
      if (!user) mineOnly = false;
      renderAuthUI();
      setTimeout(() => checkAdmin().then(renderAuthUI), 0);
      setTimeout(() => applyDefaultSchool().then(() => { renderAuthUI(); loadListings(); }), 0);
    });
  }

  init();
})();
