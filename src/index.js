/**
 * Cloudflare Booking System
 * A self-hosted "book a call" page: time-zone aware slots, no double booking,
 * email confirmations with a calendar invite, and 24h / 1h reminders.
 *
 * Runs on Cloudflare Workers + D1. Email via Resend. Optional Telegram alerts.
 * MIT License. Built by Nahid Reza (https://nahidreza.com).
 */

/* ------------------------------------------------------------------ */
/* Settings: change these to match your working hours                  */
/* ------------------------------------------------------------------ */
const CONFIG = {
  ownerName: "Your Name",
  timeZone: "Asia/Dhaka",          // your time zone (IANA name)
  workDays: [0, 1, 2, 3, 4, 6],    // 0 = Sunday ... 6 = Saturday
  dayStart: "10:00",               // first slot of the day (your time)
  dayEnd: "22:00",                 // last call must END by this time
  slotMinutes: 30,                 // length of one call
  minNoticeHours: 12,              // earliest a visitor can book
  daysAhead: 30,                   // how far ahead people can book
  methods: ["Google Meet", "Zoom", "WhatsApp call"],
};

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/book")) return html(PAGE.replace(/%NAME%/g, esc(CONFIG.ownerName)));
      if (req.method === "GET" && url.pathname === "/api/slots") return json({ timeZone: CONFIG.timeZone, slotMinutes: CONFIG.slotMinutes, methods: CONFIG.methods, slots: await freeSlots(env) });
      if (req.method === "POST" && url.pathname === "/api/book") return await book(req, env, ctx, url);
      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendReminders(env));
  },
};

/* ------------------------------------------------------------------ */
/* Time helpers                                                        */
/* ------------------------------------------------------------------ */
// Offset (in minutes) of a time zone at a given instant, e.g. Asia/Dhaka = +360
function tzOffset(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date).map(x => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}
// Convert "local date + local time in a time zone" into a real UTC Date
function zonedToUtc(y, m, d, hh, mm, timeZone) {
  let guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  for (let i = 0; i < 2; i++) guess = new Date(Date.UTC(y, m - 1, d, hh, mm) - tzOffset(guess, timeZone) * 60000);
  return guess;
}
function localParts(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
const hm = s => s.split(":").map(Number);

/* ------------------------------------------------------------------ */
/* Slots                                                               */
/* ------------------------------------------------------------------ */
async function takenStarts(env) {
  const rows = await env.DB.prepare("SELECT start_utc FROM bookings WHERE status='confirmed' AND start_utc >= ?").bind(new Date(Date.now() - 864e5).toISOString()).all();
  return new Set(rows.results.map(r => r.start_utc));
}

async function freeSlots(env) {
  const taken = await takenStarts(env);
  const now = Date.now();
  const earliest = now + CONFIG.minNoticeHours * 3600e3;
  const [sh, sm] = hm(CONFIG.dayStart), [eh, em] = hm(CONFIG.dayEnd);
  const out = [];
  for (let i = 0; i <= CONFIG.daysAhead; i++) {
    const day = localParts(new Date(now + i * 864e5), CONFIG.timeZone);
    if (!CONFIG.workDays.includes(day.dow)) continue;
    for (let t = sh * 60 + sm; t + CONFIG.slotMinutes <= eh * 60 + em; t += CONFIG.slotMinutes) {
      const start = zonedToUtc(day.y, day.m, day.d, Math.floor(t / 60), t % 60, CONFIG.timeZone);
      const iso = start.toISOString();
      if (start.getTime() >= earliest && !taken.has(iso) && !out.includes(iso)) out.push(iso);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Booking                                                             */
/* ------------------------------------------------------------------ */
async function book(req, env, ctx, url) {
  // Only accept posts from this site
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== url.host) return json({ error: "Not allowed." }, 403);

  const d = await req.json().catch(() => ({}));
  const clean = (v, n) => String(v ?? "").trim().slice(0, n);
  const name = clean(d.name, 100), email = clean(d.email, 200).toLowerCase(), whatsapp = clean(d.whatsapp, 40);
  const method = CONFIG.methods.includes(d.method) ? d.method : CONFIG.methods[0];
  const topic = clean(d.topic, 2000), clientTz = clean(d.timeZone, 64) || "UTC";

  if (d.company) return json({ ok: true });                                   // honeypot: bots fill hidden fields
  if (!name || !/\p{L}/u.test(name)) return json({ error: "Please add your name." }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Please add a valid email." }, 400);
  if (method === "WhatsApp call" && whatsapp.replace(/\D/g, "").length < 7) return json({ error: "Please add your WhatsApp number." }, 400);

  // The chosen slot must still be free and valid
  const start = new Date(d.start);
  if (isNaN(start)) return json({ error: "Please pick a time." }, 400);
  const iso = start.toISOString();
  if (!(await freeSlots(env)).includes(iso)) return json({ error: "Sorry, that time was just taken. Please pick another." }, 409);

  // Simple rate limit: max 3 bookings per email per day
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE email=? AND created_at > datetime('now','-1 day')").bind(email).first();
  if (recent.n >= 3) return json({ error: "Too many bookings from this email today." }, 429);

  try {
    await env.DB.prepare("INSERT INTO bookings (start_utc, duration, name, email, whatsapp, method, topic, client_tz) VALUES (?,?,?,?,?,?,?,?)")
      .bind(iso, CONFIG.slotMinutes, name, email, whatsapp, method, topic, clientTz).run();
  } catch (e) {
    // UNIQUE index on confirmed start_utc protects against two people booking the same slot at the same moment
    return json({ error: "Sorry, that time was just taken. Please pick another." }, 409);
  }

  const b = { start: iso, name, email, whatsapp, method, topic, clientTz };
  ctx.waitUntil(Promise.all([sendConfirmation(env, b, url.origin), notifyOwner(env, b)]));
  return json({ ok: true, start: iso });
}

/* ------------------------------------------------------------------ */
/* Email (Resend) + calendar invite                                    */
/* ------------------------------------------------------------------ */
async function sendMail(env, { to, subject, html, text, attachments }) {
  if (!env.RESEND_API_KEY) return { ok: false, error: "RESEND_API_KEY not set" };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ from: env.FROM_EMAIL, to: [to], reply_to: env.OWNER_EMAIL, subject, html, text, attachments }),
  });
  return { ok: r.ok, status: r.status };
}

function when(iso, tz) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).format(new Date(iso));
}

function ics(b) {
  const f = d => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const end = new Date(new Date(b.start).getTime() + CONFIG.slotMinutes * 60000);
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//booking//EN", "METHOD:REQUEST", "BEGIN:VEVENT",
    "UID:" + f(b.start) + "-" + b.email, "DTSTAMP:" + f(Date.now()), "DTSTART:" + f(b.start), "DTEND:" + f(end),
    "SUMMARY:Call with " + CONFIG.ownerName, "DESCRIPTION:" + b.method, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}

async function sendConfirmation(env, b, origin) {
  const t = when(b.start, b.clientTz);
  const html = `<p>Hi ${esc(b.name.split(" ")[0])},</p><p>Your call with ${esc(CONFIG.ownerName)} is booked for <b>${esc(t)}</b> (${esc(b.method)}).</p><p>${b.method === "WhatsApp call" ? "I will call you on WhatsApp at that time." : "You will get the meeting link by email before the call."}</p><p>You will also get a reminder 24 hours and 1 hour before.</p><p>See you soon,<br>${esc(CONFIG.ownerName)}</p>`;
  return sendMail(env, {
    to: b.email, subject: "Your call is booked: " + t, html, text: html.replace(/<[^>]+>/g, "\n"),
    attachments: [{ filename: "invite.ics", content: btoa(ics(b)) }],
  });
}

async function notifyOwner(env, b) {
  const t = when(b.start, CONFIG.timeZone);
  const msg = `New booking\n${b.name} (${b.email})\n${t}\n${b.method}${b.whatsapp ? "\nWhatsApp: " + b.whatsapp : ""}${b.topic ? "\n\n" + b.topic : ""}`;
  const jobs = [];
  if (env.OWNER_EMAIL) jobs.push(sendMail(env, { to: env.OWNER_EMAIL, subject: "New booking: " + b.name + " · " + t, html: "<pre style='font:15px/1.6 sans-serif'>" + esc(msg) + "</pre>", text: msg }));
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) jobs.push(fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: msg }) }));
  return Promise.all(jobs);
}

/* ------------------------------------------------------------------ */
/* Reminders (runs on the cron trigger in wrangler.toml)               */
/* ------------------------------------------------------------------ */
async function sendReminders(env) {
  const now = Date.now();
  const rows = await env.DB.prepare("SELECT * FROM bookings WHERE status='confirmed' AND start_utc > ? AND start_utc < ?")
    .bind(new Date(now).toISOString(), new Date(now + 25 * 3600e3).toISOString()).all();
  for (const b of rows.results) {
    const mins = (new Date(b.start_utc) - now) / 60000;
    const col = mins <= 70 ? "r1" : mins <= 24 * 60 + 10 ? "r24" : null;
    if (!col || b[col]) continue;
    const t = when(b.start_utc, b.client_tz || "UTC");
    const html = `<p>Hi ${esc(b.name.split(" ")[0])},</p><p>A reminder: your call with ${esc(CONFIG.ownerName)} is ${col === "r1" ? "in about an hour" : "tomorrow"}, <b>${esc(t)}</b> (${esc(b.method)}).</p>${b.meet_link ? `<p>Join here: <a href="${esc(b.meet_link)}">${esc(b.meet_link)}</a></p>` : ""}<p>See you soon,<br>${esc(CONFIG.ownerName)}</p>`;
    const r = await sendMail(env, { to: b.email, subject: (col === "r1" ? "Starting soon: " : "Tomorrow: ") + "your call with " + CONFIG.ownerName, html, text: html.replace(/<[^>]+>/g, "\n") });
    if (r.ok) await env.DB.prepare(`UPDATE bookings SET ${col}=1 WHERE id=?`).bind(b.id).run();
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function json(o, status = 200) { return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
function html(s) { return new Response(s, { headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" } }); }

/* ------------------------------------------------------------------ */
/* Booking page (single file, no frameworks)                           */
/* ------------------------------------------------------------------ */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Book a call with %NAME%</title>
<style>
:root{--bg:#06070D;--card:#0F1324;--line:#252B45;--tx:#F4F6FF;--t2:#A7AECB;--ac:#4D6BFF}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.w{max-width:880px;margin:0 auto;padding:40px 20px}h1{font-size:clamp(30px,5vw,44px);margin:0 0 6px}p.s{color:var(--t2);margin:0 0 28px}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:24px;margin-bottom:16px}
.days{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px}.day{flex:0 0 auto;min-width:76px;padding:10px;border-radius:14px;border:1.5px solid var(--line);background:none;color:var(--tx);cursor:pointer;text-align:center}
.day b{display:block;font-size:20px}.day.on{border-color:var(--ac);background:rgba(77,107,255,.15)}
.times{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin-top:16px}
.t{min-height:44px;border-radius:12px;border:1.5px solid var(--line);background:none;color:var(--tx);cursor:pointer;font-weight:600}.t.on{background:var(--ac);border-color:var(--ac)}
label{display:block;font-size:14px;font-weight:600;color:var(--t2);margin:14px 0 6px}input,select,textarea{width:100%;min-height:46px;padding:10px 14px;border-radius:12px;border:1.5px solid var(--line);background:#090B16;color:var(--tx);font:inherit}
.g{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:600px){.g{grid-template-columns:1fr}}
button.go{width:100%;min-height:52px;margin-top:20px;border:0;border-radius:999px;background:var(--ac);color:#fff;font-weight:700;font-size:16px;cursor:pointer}button.go:disabled{opacity:.6}
.err{color:#FF9C94;font-weight:600;margin-top:12px}.ok{text-align:center;padding:40px 10px}.ok h2{font-size:28px}.hp{position:absolute;left:-9999px}.tz{font-size:13px;color:var(--t2)}
</style></head><body><main class="w"><h1>Book a free call</h1><p class="s">Pick a time that suits you. Times are shown in <span id="tzn"></span>.</p>
<div id="app"><div class="card"><div class="days" id="days"></div><div class="times" id="times"></div></div>
<form class="card" id="f" novalidate><div class="g"><div><label for="n">Name</label><input id="n" autocomplete="name" required></div><div><label for="e">Email</label><input id="e" type="email" autocomplete="email" required></div></div>
<div class="g"><div><label for="m">How should we talk?</label><select id="m"></select></div><div><label for="wa">WhatsApp number</label><input id="wa" autocomplete="tel"></div></div>
<label for="tp">What would you like to talk about? (optional)</label><textarea id="tp" rows="3"></textarea>
<div class="hp" aria-hidden="true"><label for="hp">Leave empty</label><input id="hp" tabindex="-1" autocomplete="nope"></div>
<p class="tz" id="pick">Pick a day and time above.</p><button class="go" id="go" type="submit" disabled>Book this time</button><p class="err" id="err" role="alert" hidden></p></form></div></main>
<script>
var tz=Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC",sel=null,byDay={};document.getElementById("tzn").textContent=tz.replace("_"," ");
function fd(iso,o){return new Intl.DateTimeFormat("en-GB",Object.assign({timeZone:tz},o)).format(new Date(iso))}
fetch("/api/slots").then(r=>r.json()).then(function(j){var m=document.getElementById("m");j.methods.forEach(function(x){var o=document.createElement("option");o.textContent=x;m.appendChild(o)});
 j.slots.forEach(function(s){var k=fd(s,{year:"numeric",month:"2-digit",day:"2-digit"});(byDay[k]=byDay[k]||[]).push(s)});var dw=document.getElementById("days");
 Object.keys(byDay).forEach(function(k,i){var b=document.createElement("button");b.type="button";b.className="day";b.innerHTML=fd(byDay[k][0],{weekday:"short"})+"<b>"+fd(byDay[k][0],{day:"numeric"})+"</b>"+fd(byDay[k][0],{month:"short"});b.onclick=function(){document.querySelectorAll(".day").forEach(x=>x.classList.remove("on"));b.classList.add("on");times(k)};dw.appendChild(b);if(!i)b.click()});
 if(!j.slots.length)dw.textContent="No free times right now. Please check back soon."});
function times(k){var t=document.getElementById("times");t.innerHTML="";byDay[k].forEach(function(s){var b=document.createElement("button");b.type="button";b.className="t";b.textContent=fd(s,{hour:"numeric",minute:"2-digit",hour12:true});b.onclick=function(){document.querySelectorAll(".t").forEach(x=>x.classList.remove("on"));b.classList.add("on");sel=s;document.getElementById("pick").textContent="Selected: "+fd(s,{weekday:"long",day:"numeric",month:"long",hour:"numeric",minute:"2-digit",hour12:true});document.getElementById("go").disabled=false};t.appendChild(b)})}
document.getElementById("f").onsubmit=function(e){e.preventDefault();var go=document.getElementById("go"),er=document.getElementById("err");er.hidden=true;go.disabled=true;go.textContent="Booking\\u2026";
 fetch("/api/book",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({start:sel,name:n.value,email:e.value,whatsapp:wa.value,method:m.value,topic:tp.value,timeZone:tz,company:hp.value})}).then(r=>r.json()).then(function(j){
  if(j.ok){document.getElementById("app").innerHTML='<div class="card ok"><h2>You are booked \\u2713</h2><p>'+fd(j.start,{weekday:"long",day:"numeric",month:"long",hour:"numeric",minute:"2-digit",hour12:true})+'</p><p class="s">A confirmation with a calendar invite is on its way to your email.</p></div>';}
  else{er.hidden=false;er.textContent=j.error||"Something went wrong.";go.disabled=false;go.textContent="Book this time"}}).catch(function(){er.hidden=false;er.textContent="No connection. Please try again.";go.disabled=false;go.textContent="Book this time"})};
</script></body></html>`;
