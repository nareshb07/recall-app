import { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabase.js";

/* ─── constants ─────────────────────────────────────────────────────────── */
const PRESETS = {
  Standard:    [1, 3, 7, 14, 30, 60],
  Aggressive:  [1, 2, 4, 8, 16, 32],
  Relaxed:     [1, 7, 30, 90, 180],
  "Long-term": [1, 3, 7, 21, 60, 120, 365],
};

/* ─── date helpers ───────────────────────────────────────────────────────── */
const todayStr    = () => new Date().toISOString().split("T")[0];
const tomorrowStr = () => addDays(todayStr(), 1);
function addDays(base, n) {
  const d = new Date(base + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0];
}
function fmtDate(s) {
  return new Date(s + "T00:00:00").toLocaleDateString("en-IN", {
    weekday: "short", day: "numeric", month: "short",
  });
}

/* ─── DB helpers ─────────────────────────────────────────────────────────── */
// topics table schema:
//   id uuid primary key default gen_random_uuid()
//   name text not null
//   description text
//   intervals integer[]
//   start_date date
//   review_dates date[]
//   done_dates date[]
//   created_at timestamptz default now()

async function dbLoad() {
  const { data, error } = await supabase
    .from("topics")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function dbInsert(topic) {
  const { data, error } = await supabase
    .from("topics")
    .insert([{
      name:         topic.name,
      description:  topic.desc,
      intervals:    topic.intervals,
      start_date:   topic.startDate,
      review_dates: topic.reviewDates,
      done_dates:   [],
    }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function dbDelete(id) {
  const { error } = await supabase.from("topics").delete().eq("id", id);
  if (error) throw error;
}

async function dbMarkDone(id, doneDates) {
  const { error } = await supabase
    .from("topics")
    .update({ done_dates: doneDates })
    .eq("id", id);
  if (error) throw error;
}

/* ─── row → app shape ────────────────────────────────────────────────────── */
function rowToTopic(r) {
  return {
    id:          r.id,
    name:        r.name,
    desc:        r.description || "",
    intervals:   r.intervals   || [],
    startDate:   r.start_date,
    reviewDates: r.review_dates || [],
    doneDates:   r.done_dates   || [],
    createdAt:   r.created_at,
  };
}

/* ─── component ──────────────────────────────────────────────────────────── */
export default function App() {
  const [tab, setTab]       = useState("add");
  const [topics, setTopics] = useState([]);
  const [status, setStatus] = useState("loading"); // loading | idle | saving | error
  const [errMsg, setErrMsg] = useState("");
  const [toast, setToast]   = useState(null);

  // form
  const [name, setName]           = useState("");
  const [desc, setDesc]           = useState("");
  const [preset, setPreset]       = useState("Standard");
  const [customIvs, setCustomIvs] = useState("1,3,7,14,30,60");
  const [startDate, setStartDate] = useState(todayStr());

  /* toast helper */
  function showToast(msg, type = "ok") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  /* ── load ── */
  const loadTopics = useCallback(async () => {
    setStatus("loading");
    try {
      const rows = await dbLoad();
      setTopics(rows.map(rowToTopic));
      setStatus("idle");
    } catch (e) {
      setStatus("error");
      setErrMsg(
        e.message?.includes("relation") || e.message?.includes("does not exist")
          ? "Table not found. Did you run the SQL setup in Supabase?"
          : e.message || "Could not connect to Supabase."
      );
    }
  }, []);

  useEffect(() => { loadTopics(); }, [loadTopics]);

  /* ── add ── */
  async function addTopic() {
    if (!name.trim()) { showToast("⚠ Topic name required", "warn"); return; }
    const intervals =
      preset === "Custom"
        ? customIvs.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0)
        : PRESETS[preset];
    if (!intervals?.length) { showToast("⚠ Invalid intervals", "warn"); return; }

    const payload = {
      name: name.trim(),
      desc: desc.trim(),
      intervals,
      startDate,
      reviewDates: intervals.map(d => addDays(startDate, d)),
    };

    setStatus("saving");
    try {
      const row = await dbInsert(payload);
      setTopics(prev => [...prev, rowToTopic(row)]);
      setStatus("idle");
      showToast(`✓ "${payload.name}" saved`);
      setName(""); setDesc("");
    } catch (e) {
      setStatus("error");
      setErrMsg(e.message);
      showToast("✗ Failed to save", "err");
    }
  }

  /* ── delete ── */
  async function deleteTopic(id) {
    setStatus("saving");
    try {
      await dbDelete(id);
      setTopics(prev => prev.filter(t => t.id !== id));
      setStatus("idle");
      showToast("Topic removed");
    } catch (e) {
      setStatus("error"); setErrMsg(e.message);
      showToast("✗ Delete failed", "err");
    }
  }

  /* ── mark done ── */
  async function markDone(topicId, date) {
    const topic = topics.find(t => t.id === topicId);
    if (!topic) return;
    const newDoneDates = [...topic.doneDates, date];
    // optimistic update
    setTopics(prev => prev.map(t => t.id === topicId ? { ...t, doneDates: newDoneDates } : t));
    try {
      await dbMarkDone(topicId, newDoneDates);
      showToast("✓ Marked as reviewed!");
    } catch (e) {
      // rollback
      setTopics(prev => prev.map(t => t.id === topicId ? topic : t));
      showToast("✗ Could not save", "err");
    }
  }

  /* ── schedule ── */
  const today = todayStr(), tomorrow = tomorrowStr();
  const todayItems    = [];
  const tomorrowItems = [];
  topics.forEach(t => {
    t.reviewDates.forEach((d, i) => {
      if (d === today)    todayItems.push({ ...t, repIdx: i });
      if (d === tomorrow) tomorrowItems.push({ ...t, repIdx: i });
    });
  });
  const next7 = topics.reduce((acc, t) => {
    const cut = addDays(today, 7);
    return acc + t.reviewDates.filter(d => d > today && d <= cut).length;
  }, 0);

  /* ── styles ── */
  const c = {
    bg:       "#0f0e0c",
    surface:  "#1a1916",
    card:     "#211f1c",
    border:   "#2e2b27",
    accent:   "#e8c87a",
    text:     "#f0ece4",
    muted:    "#7a7060",
    green:    "#7ecf7e",
    blue:     "#7eaecf",
    red:      "#c95a4a",
  };

  const input = {
    background: c.card, border: `1px solid ${c.border}`, borderRadius: 6,
    color: c.text, fontFamily: "inherit", fontSize: "0.88rem",
    padding: "0.6rem 0.85rem", width: "100%", outline: "none",
  };
  const mono = { fontFamily: "'DM Mono', monospace" };

  /* ── render ── */
  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif", background: c.bg, minHeight: "100vh", color: c.text }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0f0e0c; }
        input:focus, textarea:focus { border-color: #e8c87a !important; outline: none; }
        .tc:hover { border-color: #4a4540 !important; transform: translateY(-1px); transition: all .2s; }
        .tc:hover .delbtn { opacity: 1 !important; }
        .sc { transition: transform .15s; }
        .sc:hover { transform: translateX(3px); }
        @keyframes fi { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
        @keyframes su { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }
        .fi { animation: fi .3s ease; }
        .su { animation: su .3s ease; }
      `}</style>

      {/* HEADER */}
      <div style={{ padding: "1.5rem 2rem 0", borderBottom: `1px solid ${c.border}`, display: "flex", alignItems: "flex-end", gap: "1rem" }}>
        <div>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "1.7rem", color: c.accent, letterSpacing: "-0.02em" }}>Recall</div>
          <div style={{ ...mono, fontSize: "0.62rem", color: c.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "0.3rem" }}>Spaced Repetition · Supabase</div>
        </div>
        <div style={{ display: "flex", marginLeft: "auto" }}>
          {[["add","Add Topics"],["schedule","Schedule"]].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} style={{ ...mono, fontSize: "0.72rem", letterSpacing: "0.08em", textTransform: "uppercase", padding: "0.7rem 1.4rem", cursor: "pointer", border: "none", background: "transparent", color: tab === key ? c.accent : c.muted, borderBottom: tab === key ? `2px solid ${c.accent}` : "2px solid transparent" }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* STATUS BANNER */}
      {status !== "idle" && (
        <div style={{ padding: "0.4rem 2rem" }}>
          <div style={{ ...mono, fontSize: "0.7rem", padding: "0.45rem 0.9rem", borderRadius: 6, display: "flex", alignItems: "center", gap: "0.5rem", background: status === "error" ? "rgba(201,90,74,.15)" : "rgba(232,200,122,.08)", color: status === "error" ? c.red : c.accent, border: `1px solid ${status === "error" ? "rgba(201,90,74,.3)" : "rgba(232,200,122,.2)"}` }}>
            {status === "loading" && "⟳ Loading from Supabase…"}
            {status === "saving"  && "⟳ Saving…"}
            {status === "error"   && <>✗ {errMsg} <button onClick={loadTopics} style={{ marginLeft: "0.5rem", background: "none", border: "none", color: c.accent, cursor: "pointer", ...mono, fontSize: "0.7rem", textDecoration: "underline" }}>Retry</button></>}
          </div>
        </div>
      )}

      {/* ── ADD TAB ── */}
      {tab === "add" && (
        <div className="fi" style={{ padding: "2rem" }}>
          {/* Form */}
          <div style={{ background: c.surface, border: `1px solid ${c.border}`, borderRadius: 10, padding: "1.5rem 1.8rem", maxWidth: 640, marginBottom: "2rem" }}>
            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "1.1rem", color: c.accent, marginBottom: "1.2rem" }}>Add a new topic</div>

            {[["Topic Name", name, setName, "text", "e.g. Dijkstra's Algorithm"],
              ["Description / Notes", desc, setDesc, "textarea", "Source, notes, or context…"]
            ].map(([label, val, setter, type, ph]) => (
              <div key={label} style={{ marginBottom: "1rem" }}>
                <label style={{ ...mono, fontSize: "0.62rem", letterSpacing: "0.1em", textTransform: "uppercase", color: c.muted, display: "block", marginBottom: "0.35rem" }}>{label}</label>
                {type === "textarea"
                  ? <textarea value={val} onChange={e => setter(e.target.value)} placeholder={ph} style={{ ...input, minHeight: 70, resize: "vertical" }} />
                  : <input value={val} onChange={e => setter(e.target.value)} placeholder={ph} onKeyDown={e => e.key === "Enter" && addTopic()} style={input} />
                }
              </div>
            ))}

            <label style={{ ...mono, fontSize: "0.62rem", letterSpacing: "0.1em", textTransform: "uppercase", color: c.muted, display: "block", marginBottom: "0.4rem" }}>Schedule Preset</label>
            <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
              {[...Object.keys(PRESETS), "Custom"].map(p => (
                <button key={p} onClick={() => setPreset(p)} style={{ ...mono, fontSize: "0.65rem", padding: "0.28rem 0.65rem", borderRadius: 4, border: `1px solid ${preset===p ? c.accent : c.border}`, background: preset===p ? "rgba(232,200,122,.1)" : c.card, color: preset===p ? c.accent : c.muted, cursor: "pointer", letterSpacing: "0.06em" }}>
                  {p}
                </button>
              ))}
            </div>
            {preset === "Custom"
              ? <input value={customIvs} onChange={e => setCustomIvs(e.target.value)} placeholder="1,3,7,14,30,60" style={{ ...input, ...mono, fontSize: "0.78rem", marginBottom: "0.4rem" }} />
              : <div style={{ ...mono, fontSize: "0.68rem", color: c.muted, marginBottom: "0.8rem" }}>Days: <span style={{ color: c.accent }}>{PRESETS[preset].join(", ")}</span></div>
            }

            <div>
              <label style={{ ...mono, fontSize: "0.62rem", letterSpacing: "0.1em", textTransform: "uppercase", color: c.muted, display: "block", marginBottom: "0.35rem" }}>Start Date</label>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ ...input, maxWidth: 200 }} />
            </div>

            <button onClick={addTopic} disabled={status === "saving"} style={{ marginTop: "1.2rem", padding: "0.7rem 1.8rem", background: c.accent, color: c.bg, border: "none", borderRadius: 6, ...mono, fontSize: "0.75rem", fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer" }}>
              {status === "saving" ? "⟳ Saving…" : "+ Add Topic"}
            </button>
          </div>

          {/* Topic cards */}
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "1rem" }}>
            <span style={{ fontFamily: "'Playfair Display', serif", fontSize: "1rem" }}>All Topics</span>
            <span style={{ ...mono, fontSize: "0.62rem", background: c.border, color: c.muted, padding: "0.15rem 0.5rem", borderRadius: 100 }}>{topics.length}</span>
          </div>
          {topics.length === 0
            ? <div style={{ textAlign: "center", padding: "2.5rem", color: c.muted, fontSize: "0.85rem" }}>📚 No topics yet. Add one above!</div>
            : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px,1fr))", gap: "0.8rem", maxWidth: 960 }}>
                {topics.map(t => {
                  const nextDue = t.reviewDates.find(d => d >= today);
                  return (
                    <div key={t.id} className="tc" style={{ background: c.surface, border: `1px solid ${c.border}`, borderRadius: 8, padding: "1rem 1.2rem", position: "relative" }}>
                      <button className="delbtn" onClick={() => deleteTopic(t.id)} style={{ position: "absolute", top: "0.6rem", right: "0.6rem", width: 20, height: 20, borderRadius: "50%", border: `1px solid ${c.border}`, background: "transparent", color: c.muted, cursor: "pointer", fontSize: "0.7rem", opacity: 0, transition: "opacity .15s", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                      <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "0.93rem", marginBottom: "0.3rem" }}>{t.name}</div>
                      <div style={{ fontSize: "0.77rem", color: c.muted, lineHeight: 1.5, marginBottom: "0.7rem" }}>{t.desc || <em style={{ opacity: 0.5 }}>No description</em>}</div>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                        <span style={{ ...mono, fontSize: "0.62rem", padding: "0.18rem 0.5rem", borderRadius: 4, background: "rgba(232,200,122,.1)", color: c.accent, border: "1px solid rgba(232,200,122,.2)" }}>Days: {t.intervals.join(", ")}</span>
                        <span style={{ ...mono, fontSize: "0.62rem", color: c.muted, marginLeft: "auto" }}>{nextDue ? "Next: " + fmtDate(nextDue) : "✓ Complete"}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          }
        </div>
      )}

      {/* ── SCHEDULE TAB ── */}
      {tab === "schedule" && (
        <div className="fi" style={{ padding: "2rem" }}>
          {/* Stats */}
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "2rem" }}>
            {[["Topics", topics.length, c.accent], ["Today", todayItems.length, c.green], ["Tomorrow", tomorrowItems.length, c.blue], ["Next 7 Days", next7, c.accent]].map(([label, val, color]) => (
              <div key={label} style={{ background: c.surface, border: `1px solid ${c.border}`, borderRadius: 8, padding: "0.7rem 1.1rem" }}>
                <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "1.5rem", color, lineHeight: 1 }}>{val}</div>
                <div style={{ ...mono, fontSize: "0.62rem", color: c.muted, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: "0.25rem" }}>{label}</div>
              </div>
            ))}
          </div>

          {/* Today */}
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.8rem", marginBottom: "0.8rem" }}>
            <span style={{ fontFamily: "'Playfair Display', serif", fontSize: "1.2rem", color: c.green }}>Today</span>
            <span style={{ ...mono, fontSize: "0.7rem", color: c.muted }}>{fmtDate(today)}</span>
          </div>
          {todayItems.length === 0
            ? <div style={{ textAlign: "center", padding: "1.5rem", color: c.muted, fontSize: "0.82rem" }}>🎉 Nothing due today!</div>
            : todayItems.map(t => {
                const isDone = t.doneDates.includes(today);
                return (
                  <div key={t.id + today} className="sc" style={{ display: "flex", alignItems: "flex-start", gap: "0.8rem", padding: "0.9rem 1.1rem", borderRadius: 7, marginBottom: "0.5rem", background: "rgba(58,90,58,.25)", border: "1px solid rgba(126,207,126,.2)", opacity: isDone ? 0.45 : 1 }}>
                    <div style={{ width: 7, height: 7, borderRadius: "50%", background: c.green, flexShrink: 0, marginTop: 6 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "0.92rem", marginBottom: "0.2rem" }}>{t.name}</div>
                      {t.desc && <div style={{ fontSize: "0.75rem", color: c.muted }}>{t.desc}</div>}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.3rem", flexShrink: 0 }}>
                      <span style={{ ...mono, fontSize: "0.62rem", padding: "0.18rem 0.5rem", borderRadius: 4, background: "rgba(126,207,126,.15)", color: c.green }}>Rep {t.repIdx+1}/{t.reviewDates.length}</span>
                      {isDone
                        ? <span style={{ ...mono, fontSize: "0.62rem", color: c.green }}>✓ Done</span>
                        : <button onClick={() => markDone(t.id, today)} style={{ ...mono, fontSize: "0.62rem", padding: "0.22rem 0.55rem", borderRadius: 4, border: "1px solid rgba(126,207,126,.3)", background: "transparent", color: c.green, cursor: "pointer" }}>Mark Done</button>
                      }
                    </div>
                  </div>
                );
              })
          }

          {/* Divider */}
          <div style={{ position: "relative", height: 1, background: c.border, margin: "1.5rem 0", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ ...mono, fontSize: "0.62rem", color: c.muted, letterSpacing: "0.12em", textTransform: "uppercase", background: c.bg, padding: "0 1rem" }}>tomorrow</span>
          </div>

          {/* Tomorrow */}
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.8rem", marginBottom: "0.8rem" }}>
            <span style={{ fontFamily: "'Playfair Display', serif", fontSize: "1.2rem", color: c.blue }}>Tomorrow</span>
            <span style={{ ...mono, fontSize: "0.7rem", color: c.muted }}>{fmtDate(tomorrow)}</span>
          </div>
          {tomorrowItems.length === 0
            ? <div style={{ textAlign: "center", padding: "1.5rem", color: c.muted, fontSize: "0.82rem" }}>Nothing scheduled for tomorrow.</div>
            : tomorrowItems.map(t => (
                <div key={t.id + tomorrow} className="sc" style={{ display: "flex", alignItems: "flex-start", gap: "0.8rem", padding: "0.9rem 1.1rem", borderRadius: 7, marginBottom: "0.5rem", background: "rgba(42,58,90,.25)", border: "1px solid rgba(126,174,207,.2)" }}>
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: c.blue, flexShrink: 0, marginTop: 6 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "0.92rem", marginBottom: "0.2rem" }}>{t.name}</div>
                    {t.desc && <div style={{ fontSize: "0.75rem", color: c.muted }}>{t.desc}</div>}
                  </div>
                  <span style={{ ...mono, fontSize: "0.62rem", padding: "0.18rem 0.5rem", borderRadius: 4, background: "rgba(126,174,207,.15)", color: c.blue, flexShrink: 0 }}>Rep {t.repIdx+1}/{t.reviewDates.length}</span>
                </div>
              ))
          }
        </div>
      )}

      {/* TOAST */}
      {toast && (
        <div className="su" style={{ position: "fixed", bottom: "2rem", right: "2rem", background: c.surface, border: `1px solid ${toast.type === "err" ? c.red : c.accent}`, borderRadius: 8, padding: "0.7rem 1.1rem", ...mono, fontSize: "0.72rem", color: toast.type === "err" ? c.red : c.accent, zIndex: 1000, boxShadow: "0 4px 20px rgba(0,0,0,.5)" }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
