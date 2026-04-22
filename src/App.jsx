import { useState, useEffect, useCallback } from "react";

const SHEET_NAME = "Recall - Spaced Repetition";
const MCP_URL = "https://drivemcp.googleapis.com/mcp/v1";

const PRESETS = {
  Standard:    [1, 3, 7, 14, 30, 60],
  Aggressive:  [1, 2, 4, 8, 16, 32],
  Relaxed:     [1, 7, 30, 90, 180],
  "Long-term": [1, 3, 7, 21, 60, 120, 365],
};

// ── Date helpers ──────────────────────────────────────────────────────────────
function todayStr() { return new Date().toISOString().split("T")[0]; }
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
function tomorrowStr() { return addDays(todayStr(), 1); }

// ── API helper (calls our serverless proxy) ───────────────────────────────────
async function callClaude(systemPrompt, userPrompt, googleToken) {
  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    mcp_servers: [{
      type: "url",
      url: MCP_URL,
      name: "gdrive",
      ...(googleToken ? { authorization_token: googleToken } : {})
    }],
  };

  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `API error ${res.status}`);
  }
  return (await res.json()).content;
}

function extractText(content) {
  return content.filter(b => b.type === "text").map(b => b.text).join("\n");
}
function parseJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const s = Math.max(clean.indexOf("{"), clean.indexOf("["));
  const e = Math.max(clean.lastIndexOf("}"), clean.lastIndexOf("]"));
  if (s === -1 || e === -1) return null;
  try { return JSON.parse(clean.slice(s, e + 1)); } catch { return null; }
}

// ── Topic helpers ─────────────────────────────────────────────────────────────
function buildTopic(name, desc, intervals, startDate) {
  return {
    id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
    name, desc, intervals, startDate,
    reviewDates: intervals.map(d => addDays(startDate, d)),
    doneDates: [],
    createdAt: new Date().toISOString(),
  };
}

function topicsToCSV(topics) {
  const header = "id,name,desc,intervals,startDate,reviewDates,doneDates,createdAt";
  const rows = topics.map(t => [
    t.id,
    `"${t.name.replace(/"/g, '""')}"`,
    `"${(t.desc||"").replace(/"/g,'""')}"`,
    `"${t.intervals.join("|")}"`,
    t.startDate,
    `"${t.reviewDates.join("|")}"`,
    `"${(t.doneDates||[]).join("|")}"`,
    t.createdAt,
  ].join(","));
  return [header, ...rows].join("\n");
}

function csvToTopics(csv) {
  if (!csv?.trim()) return [];
  return csv.trim().split("\n").slice(1).map(line => {
    const cols = []; let cur = "", inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === "," && !inQ) { cols.push(cur); cur = ""; }
      else cur += ch;
    }
    cols.push(cur);
    return {
      id: cols[0], name: cols[1], desc: cols[2],
      intervals: cols[3]?.split("|").map(Number).filter(Boolean) || [],
      startDate: cols[4],
      reviewDates: cols[5]?.split("|").filter(Boolean) || [],
      doneDates: cols[6]?.split("|").filter(Boolean) || [],
      createdAt: cols[7],
    };
  }).filter(t => t.id);
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab]         = useState("add");
  const [topics, setTopics]   = useState([]);
  const [sheetId, setSheetId] = useState(null);
  const [status, setStatus]   = useState("loading"); // loading | idle | saving | error
  const [statusMsg, setStatusMsg] = useState("Connecting to Google Drive…");
  const [toast, setToast]     = useState(null);

  // Form
  const [name, setName]               = useState("");
  const [desc, setDesc]               = useState("");
  const [preset, setPreset]           = useState("Standard");
  const [customIvs, setCustomIvs]     = useState("1,3,7,14,30,60");
  const [startDate, setStartDate]     = useState(todayStr());

  function showToast(msg, type = "ok") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  // ── Load from Sheets ────────────────────────────────────────────────────────
  const loadFromSheets = useCallback(async () => {
    setStatus("loading");
    setStatusMsg("Connecting to Google Drive…");
    try {
      const sys = `You are a Google Drive assistant.
Search for a Google Sheet named exactly "${SHEET_NAME}".
If found, return its file ID and the raw text content of Sheet1 (all rows as CSV).
If NOT found, create a new Google Sheet named "${SHEET_NAME}", add a header row:
id,name,desc,intervals,startDate,reviewDates,doneDates,createdAt
Then return its file ID and empty csvContent.
Respond ONLY in this exact JSON (no markdown, no extra text):
{"fileId":"...","csvContent":"...","created":true}`;

      const content = await callClaude(sys, `Find or create the sheet "${SHEET_NAME}" and return its data.`);
      const parsed = parseJSON(extractText(content));

      if (parsed?.fileId) {
        setSheetId(parsed.fileId);
        setTopics(csvToTopics(parsed.csvContent || ""));
        setStatus("idle");
        showToast(parsed.created ? "✓ Created new sheet in Drive" : `✓ Loaded from Google Sheets`);
      } else {
        throw new Error("No fileId in response");
      }
    } catch (e) {
      setStatus("error");
      setStatusMsg("Could not connect to Google Drive. Check your API key & Drive connection.");
    }
  }, []);

  useEffect(() => { loadFromSheets(); }, [loadFromSheets]);

  // ── Save to Sheets ──────────────────────────────────────────────────────────
  const saveToSheets = useCallback(async (updated, sid) => {
    const id = sid || sheetId;
    if (!id) return;
    setStatus("saving");
    try {
      const csv = topicsToCSV(updated);
      const sys = `You are a Google Sheets assistant.
Clear Sheet1 of the Google Sheet with file ID "${id}" completely, then write this exact CSV data starting from cell A1. Keep all formatting minimal.
Respond only with: {"ok":true}`;
      await callClaude(sys, `Write this CSV:\n\n${csv}`);
      setStatus("idle");
    } catch {
      setStatus("error");
      setStatusMsg("Failed to save. Retrying next action.");
      showToast("✗ Save failed", "err");
    }
  }, [sheetId]);

  // ── Add topic ───────────────────────────────────────────────────────────────
  async function addTopic() {
    if (!name.trim()) { showToast("⚠ Topic name required", "warn"); return; }
    const intervals = preset === "Custom"
      ? customIvs.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0)
      : PRESETS[preset];
    if (!intervals?.length) { showToast("⚠ Invalid intervals", "warn"); return; }

    const topic = buildTopic(name.trim(), desc.trim(), intervals, startDate);
    const updated = [...topics, topic];
    setTopics(updated);
    await saveToSheets(updated);
    showToast(`✓ "${topic.name}" saved to Drive`);
    setName(""); setDesc("");
  }

  async function deleteTopic(id) {
    const updated = topics.filter(t => t.id !== id);
    setTopics(updated);
    await saveToSheets(updated);
    showToast("Topic removed");
  }

  async function markDone(topicId, date) {
    const updated = topics.map(t => {
      if (t.id !== topicId) return t;
      const doneDates = [...(t.doneDates||[])];
      if (!doneDates.includes(date)) doneDates.push(date);
      return { ...t, doneDates };
    });
    setTopics(updated);
    await saveToSheets(updated);
    showToast("✓ Marked as reviewed!");
  }

  // ── Schedule ────────────────────────────────────────────────────────────────
  const today = todayStr(), tomorrow = tomorrowStr();
  const todayItems = [], tomorrowItems = [];
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

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: "'Segoe UI', system-ui, sans-serif", background: "#0f0e0c", minHeight: "100vh", color: "#f0ece4" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0f0e0c; }
        input, textarea, select { transition: border-color 0.2s; }
        input:focus, textarea:focus { border-color: #e8c87a !important; outline: none; }
        .topic-card:hover { border-color: #4a4540 !important; transform: translateY(-1px); }
        .topic-card:hover .del-btn { opacity: 1 !important; }
        .sched-card { transition: transform 0.15s; }
        .sched-card:hover { transform: translateX(3px); }
        .tab-btn { transition: all 0.2s; }
        .tab-btn:hover { color: #f0ece4 !important; }
        .submit-btn:hover { background: #f0d888 !important; transform: translateY(-1px); }
        .done-btn:hover { background: rgba(126,207,126,0.15) !important; }
        @keyframes fadeIn { from { opacity:0; transform: translateY(8px); } to { opacity:1; transform: translateY(0); } }
        @keyframes slideUp { from { opacity:0; transform: translateY(16px); } to { opacity:1; transform: translateY(0); } }
        .page-enter { animation: fadeIn 0.3s ease; }
        .toast-enter { animation: slideUp 0.3s ease; }
      `}</style>

      {/* HEADER */}
      <div style={{ padding: "1.5rem 2rem 0", borderBottom: "1px solid #2e2b27", display: "flex", alignItems: "flex-end", gap: "1rem", background: "radial-gradient(ellipse at 20% 0%, #1e1a0f 0%, transparent 60%)" }}>
        <div>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "1.7rem", color: "#e8c87a", letterSpacing: "-0.02em" }}>Recall</div>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.62rem", color: "#7a7060", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "0.3rem" }}>Spaced Repetition · Google Sheets</div>
        </div>
        <div style={{ display: "flex", marginLeft: "auto" }}>
          {["add","schedule"].map(t => (
            <button key={t} className="tab-btn" onClick={() => setTab(t)} style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.72rem", letterSpacing: "0.08em", textTransform: "uppercase", padding: "0.7rem 1.4rem", cursor: "pointer", border: "none", background: "transparent", color: tab === t ? "#e8c87a" : "#7a7060", borderBottom: tab === t ? "2px solid #e8c87a" : "2px solid transparent" }}>
              {t === "add" ? "Add Topics" : "Schedule"}
            </button>
          ))}
        </div>
      </div>

      {/* STATUS BANNER */}
      {status !== "idle" && (
        <div style={{ padding: "0.5rem 2rem" }}>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.7rem", padding: "0.5rem 1rem", borderRadius: "6px", background: status === "error" ? "rgba(201,90,74,0.15)" : "rgba(232,200,122,0.08)", color: status === "error" ? "#c95a4a" : "#e8c87a", border: `1px solid ${status === "error" ? "rgba(201,90,74,0.3)" : "rgba(232,200,122,0.2)"}`, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            {status === "loading" && <span>⟳ {statusMsg}</span>}
            {status === "saving" && <span>⟳ Saving to Google Sheets…</span>}
            {status === "error" && (
              <span>{statusMsg} <button onClick={loadFromSheets} style={{ marginLeft: "0.5rem", background: "none", border: "none", color: "#e8c87a", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: "0.7rem", textDecoration: "underline" }}>Retry</button></span>
            )}
          </div>
        </div>
      )}

      {/* ADD TAB */}
      {tab === "add" && (
        <div className="page-enter" style={{ padding: "2rem" }}>
          <div style={{ background: "#1a1916", border: "1px solid #2e2b27", borderRadius: "10px", padding: "1.5rem 1.8rem", maxWidth: 640, marginBottom: "2rem" }}>
            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "1.1rem", color: "#e8c87a", marginBottom: "1.2rem" }}>Add a new topic</div>

            <label style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.62rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "#7a7060", display: "block", marginBottom: "0.35rem" }}>Topic Name</label>
            <input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && addTopic()} placeholder="e.g. Dijkstra's Algorithm" style={{ background: "#211f1c", border: "1px solid #2e2b27", borderRadius: "6px", color: "#f0ece4", fontFamily: "'DM Sans', sans-serif", fontSize: "0.88rem", padding: "0.6rem 0.85rem", width: "100%", marginBottom: "1rem" }} />

            <label style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.62rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "#7a7060", display: "block", marginBottom: "0.35rem" }}>Description / Notes</label>
            <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="Source, notes, or context…" style={{ background: "#211f1c", border: "1px solid #2e2b27", borderRadius: "6px", color: "#f0ece4", fontFamily: "'DM Sans', sans-serif", fontSize: "0.88rem", padding: "0.6rem 0.85rem", width: "100%", minHeight: 72, resize: "vertical", marginBottom: "1rem" }} />

            <label style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.62rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "#7a7060", display: "block", marginBottom: "0.4rem" }}>Schedule Preset</label>
            <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
              {[...Object.keys(PRESETS), "Custom"].map(p => (
                <button key={p} onClick={() => setPreset(p)} style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.65rem", padding: "0.28rem 0.65rem", borderRadius: "4px", border: `1px solid ${preset === p ? "#e8c87a" : "#2e2b27"}`, background: preset === p ? "rgba(232,200,122,0.1)" : "#211f1c", color: preset === p ? "#e8c87a" : "#7a7060", cursor: "pointer", letterSpacing: "0.06em" }}>
                  {p}
                </button>
              ))}
            </div>
            {preset === "Custom"
              ? <input value={customIvs} onChange={e => setCustomIvs(e.target.value)} placeholder="1,3,7,14,30,60" style={{ background: "#211f1c", border: "1px solid #2e2b27", borderRadius: "6px", color: "#f0ece4", fontFamily: "'DM Mono', monospace", fontSize: "0.78rem", padding: "0.55rem 0.85rem", width: "100%", marginBottom: "0.4rem" }} />
              : <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.68rem", color: "#7a7060", marginBottom: "0.8rem" }}>Days: <span style={{ color: "#e8c87a" }}>{PRESETS[preset].join(", ")}</span></div>
            }

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginTop: "0.4rem" }}>
              <div>
                <label style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.62rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "#7a7060", display: "block", marginBottom: "0.35rem" }}>Start Date</label>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ background: "#211f1c", border: "1px solid #2e2b27", borderRadius: "6px", color: "#f0ece4", fontFamily: "'DM Sans', sans-serif", fontSize: "0.88rem", padding: "0.6rem 0.85rem", width: "100%" }} />
              </div>
            </div>

            <button className="submit-btn" onClick={addTopic} disabled={status === "saving"} style={{ marginTop: "1.2rem", padding: "0.7rem 1.8rem", background: "#e8c87a", color: "#0f0e0c", border: "none", borderRadius: "6px", fontFamily: "'DM Mono', monospace", fontSize: "0.75rem", fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer" }}>
              {status === "saving" ? "⟳ Saving…" : "+ Add Topic"}
            </button>
          </div>

          {/* Topics grid */}
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "1rem" }}>
            <span style={{ fontFamily: "'Playfair Display', serif", fontSize: "1rem" }}>All Topics</span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.62rem", background: "#2e2b27", color: "#7a7060", padding: "0.15rem 0.5rem", borderRadius: 100 }}>{topics.length}</span>
          </div>
          {topics.length === 0
            ? <div style={{ textAlign: "center", padding: "2.5rem", color: "#7a7060", fontSize: "0.85rem" }}>📚 No topics yet. Add one above!</div>
            : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "0.8rem", maxWidth: 960 }}>
                {topics.map(t => {
                  const nextDue = t.reviewDates.find(d => d >= today);
                  return (
                    <div key={t.id} className="topic-card" style={{ background: "#1a1916", border: "1px solid #2e2b27", borderRadius: "8px", padding: "1rem 1.2rem", position: "relative", transition: "all 0.2s" }}>
                      <button className="del-btn" onClick={() => deleteTopic(t.id)} style={{ position: "absolute", top: "0.6rem", right: "0.6rem", width: 20, height: 20, borderRadius: "50%", border: "1px solid #2e2b27", background: "transparent", color: "#7a7060", cursor: "pointer", fontSize: "0.7rem", opacity: 0, transition: "opacity 0.15s", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                      <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "0.93rem", marginBottom: "0.3rem" }}>{t.name}</div>
                      <div style={{ fontSize: "0.77rem", color: "#7a7060", lineHeight: 1.5, marginBottom: "0.7rem" }}>{t.desc || <em style={{ opacity: 0.5 }}>No description</em>}</div>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.62rem", padding: "0.18rem 0.5rem", borderRadius: "4px", background: "rgba(232,200,122,0.1)", color: "#e8c87a", border: "1px solid rgba(232,200,122,0.2)" }}>Days: {t.intervals.join(", ")}</span>
                        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.62rem", color: "#7a7060", marginLeft: "auto" }}>{nextDue ? "Next: " + fmtDate(nextDue) : "✓ Complete"}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          }
        </div>
      )}

      {/* SCHEDULE TAB */}
      {tab === "schedule" && (
        <div className="page-enter" style={{ padding: "2rem" }}>
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "2rem" }}>
            {[["Topics", topics.length, "#e8c87a"], ["Today", todayItems.length, "#7ecf7e"], ["Tomorrow", tomorrowItems.length, "#7eaecf"], ["Next 7 Days", next7, "#e8c87a"]].map(([label, val, color]) => (
              <div key={label} style={{ background: "#1a1916", border: "1px solid #2e2b27", borderRadius: "8px", padding: "0.7rem 1.1rem" }}>
                <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "1.5rem", color, lineHeight: 1 }}>{val}</div>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.62rem", color: "#7a7060", letterSpacing: "0.08em", textTransform: "uppercase", marginTop: "0.25rem" }}>{label}</div>
              </div>
            ))}
          </div>

          {/* Today */}
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.8rem", marginBottom: "0.8rem" }}>
            <span style={{ fontFamily: "'Playfair Display', serif", fontSize: "1.2rem", color: "#7ecf7e" }}>Today</span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.7rem", color: "#7a7060" }}>{fmtDate(today)}</span>
          </div>
          {todayItems.length === 0
            ? <div style={{ textAlign: "center", padding: "1.5rem", color: "#7a7060", fontSize: "0.82rem" }}>🎉 Nothing due today!</div>
            : todayItems.map(t => {
                const isDone = (t.doneDates||[]).includes(today);
                return (
                  <div key={t.id} className="sched-card" style={{ display: "flex", alignItems: "flex-start", gap: "0.8rem", padding: "0.9rem 1.1rem", borderRadius: "7px", marginBottom: "0.5rem", background: "rgba(58,90,58,0.25)", border: "1px solid rgba(126,207,126,0.2)", opacity: isDone ? 0.45 : 1 }}>
                    <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#7ecf7e", flexShrink: 0, marginTop: 6 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "0.92rem", marginBottom: "0.2rem" }}>{t.name}</div>
                      {t.desc && <div style={{ fontSize: "0.75rem", color: "#7a7060" }}>{t.desc}</div>}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.3rem", flexShrink: 0 }}>
                      <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.62rem", padding: "0.18rem 0.5rem", borderRadius: "4px", background: "rgba(126,207,126,0.15)", color: "#7ecf7e" }}>Rep {t.repIdx+1}/{t.reviewDates.length}</span>
                      {!isDone
                        ? <button className="done-btn" onClick={() => markDone(t.id, today)} style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.62rem", padding: "0.22rem 0.55rem", borderRadius: "4px", border: "1px solid rgba(126,207,126,0.3)", background: "transparent", color: "#7ecf7e", cursor: "pointer" }}>Mark Done</button>
                        : <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.62rem", color: "#7ecf7e" }}>✓ Done</span>
                      }
                    </div>
                  </div>
                );
              })
          }

          <div style={{ height: 1, background: "#2e2b27", margin: "1.5rem 0", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.62rem", color: "#7a7060", letterSpacing: "0.12em", textTransform: "uppercase", background: "#0f0e0c", padding: "0 1rem" }}>tomorrow</span>
          </div>

          {/* Tomorrow */}
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.8rem", marginBottom: "0.8rem" }}>
            <span style={{ fontFamily: "'Playfair Display', serif", fontSize: "1.2rem", color: "#7eaecf" }}>Tomorrow</span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.7rem", color: "#7a7060" }}>{fmtDate(tomorrow)}</span>
          </div>
          {tomorrowItems.length === 0
            ? <div style={{ textAlign: "center", padding: "1.5rem", color: "#7a7060", fontSize: "0.82rem" }}>Nothing scheduled for tomorrow.</div>
            : tomorrowItems.map(t => (
                <div key={t.id} className="sched-card" style={{ display: "flex", alignItems: "flex-start", gap: "0.8rem", padding: "0.9rem 1.1rem", borderRadius: "7px", marginBottom: "0.5rem", background: "rgba(42,58,90,0.25)", border: "1px solid rgba(126,174,207,0.2)" }}>
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#7eaecf", flexShrink: 0, marginTop: 6 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "0.92rem", marginBottom: "0.2rem" }}>{t.name}</div>
                    {t.desc && <div style={{ fontSize: "0.75rem", color: "#7a7060" }}>{t.desc}</div>}
                  </div>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "0.62rem", padding: "0.18rem 0.5rem", borderRadius: "4px", background: "rgba(126,174,207,0.15)", color: "#7eaecf", flexShrink: 0 }}>Rep {t.repIdx+1}/{t.reviewDates.length}</span>
                </div>
              ))
          }
        </div>
      )}

      {toast && (
        <div className="toast-enter" style={{ position: "fixed", bottom: "2rem", right: "2rem", background: "#1a1916", border: `1px solid ${toast.type === "err" ? "#c95a4a" : "#e8c87a"}`, borderRadius: "8px", padding: "0.7rem 1.1rem", fontFamily: "'DM Mono', monospace", fontSize: "0.72rem", color: toast.type === "err" ? "#c95a4a" : "#e8c87a", zIndex: 1000, boxShadow: "0 4px 20px rgba(0,0,0,0.5)" }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
