import { useState, useEffect, useRef, useMemo } from "react";
import {
  loadPantry, addItems, removeItems, syncEnabled, KINDS, EMPTY_PANTRY,
  staleItems, daysSince, pantryNames, ingredientName, STALE_DAYS,
} from "./pantry.js";
import { loadFavorites, saveFavorite, removeFavorite, isFavorite } from "./favorites.js";
import { loadHistory, recordCook, feedbackHints, RATING_OPTIONS } from "./feedback.js";

/* ── Design tokens ──────────────────────────────────────── */
const ZEN = {
  bg: "#F7F3EE", surface: "#EDEAE4", border: "#D8D2C8",
  text: "#2C2825", muted: "#8C8680", faint: "#C5BFB7",
};
const SANS = "'DM Sans',sans-serif";
const SERIF = "'Lora',serif";

const STEPS = [
  { key: "protein", label: "Protein", emoji: "🥩", color: "#8B4A3A",
    items: ["Poultry","Red Meat","Pork","Ground Meat & Sausage","Fish","Shrimp & Shellfish","Plant-based"] },
  { key: "veggie", label: "Veggie", emoji: "🥦", color: "#3D6E52",
    items: ["Leafy Greens","Broccoli & Cabbage","Peppers, Eggplant & Asparagus","Squash","Beans & Corn","Root Veg"] },
  { key: "carb", label: "Carb", emoji: "🍚", color: "#7A5C2E",
    items: ["Rice","Noodles","Bread","Potatoes","Grains","Legumes"] },
  { key: "style", label: "Cuisine", emoji: "🌏", color: "#4A5A7A",
    items: ["Asian","Italian & Mediterranean","French & Continental","Latin American","Middle Eastern","American"] },
];

const DIFF = [
  { key: "easy",   label: "Easy",   icon: "🙂", desc: "~20 min, one pan",     color: "#3D6E52" },
  { key: "medium", label: "Medium", icon: "👨‍🍳", desc: "30–45 min, some prep", color: "#7A5C2E" },
  { key: "hard",   label: "Hard",   icon: "🔥", desc: "1 hr+, multi-step",    color: "#8B4A3A" },
];

const SEG_COLORS = ["#C4856A","#7EAB8A","#C4A46A","#8A9BBF","#B07A6E","#6E9E80","#A0876E","#7A8FB0"];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/* ── Shared style helpers ───────────────────────────────── */
// Common button reset so every CTA doesn't repeat the same 6 props.
function btn(extra) {
  return { border:"none", cursor:"pointer", fontFamily:SANS, fontWeight:500,
           WebkitTapHighlightColor:"transparent", touchAction:"manipulation", ...extra };
}

// Injected once at the app root instead of on every screen mount.
const GLOBAL_CSS =
  "@import url('https://fonts.googleapis.com/css2?family=Lora:wght@400;600&family=DM+Sans:wght@400;500&display=swap');" +
  "*{box-sizing:border-box;margin:0;padding:0;}" +
  "input:focus,textarea:focus{outline:none!important;border-color:#7A5C2E!important}" +
  "@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}" +
  "@keyframes softPulse{from{opacity:0.85;transform:scale(0.99)}to{opacity:1;transform:scale(1.02)}}" +
  "@keyframes slideUp{from{transform:translateY(60px);opacity:0}to{transform:translateY(0);opacity:1}}" +
  "@keyframes slideIn{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}" +
  "@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}" +
  "@keyframes bounce{from{transform:translateY(0)}to{transform:translateY(-8px)}}" +
  "@keyframes pillPop{from{opacity:0;transform:scale(0.88) translateY(8px)}to{opacity:1;transform:scale(1) translateY(0)}}" +
  "@keyframes gentleSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}";

function GlobalStyle() { return <style>{GLOBAL_CSS}</style>; }

/* ── Recipe API ─────────────────────────────────────────── */
/* The Gemini key now lives on the server (see api/_core.js), so the browser
   just posts the chosen ingredients and gets recipes back. Nothing secret
   ships in this bundle. */
async function fetchRecipes(payload, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("/api/recipes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not generate recipes.");
    if (!Array.isArray(data.recipes) || data.recipes.length === 0) {
      throw new Error("No recipes came back — please try again.");
    }
    return data.recipes;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("That took too long — please try again.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ── Text helpers for share modal ──────────────────────── */
// Every list is guarded — a recipe missing a field must not crash Save/Share.
function buildShoppingText(recipe, servings) {
  return [recipe.name + " — Shopping List", "Serves " + servings, "", ...(recipe.shoppingList || []).map(i => "• " + i)].join("\n");
}
function buildRecipeText(recipe, servings) {
  return [
    recipe.name, "Serves " + servings, (recipe.tags || []).join(" · "), "",
    recipe.description || "", "", "SHOPPING LIST",
    ...(recipe.shoppingList || []).map(i => "• " + i), "", "STEPS",
    ...(recipe.steps || []).map((s, i) => (i + 1) + ". " + s),
  ].join("\n");
}

/* ══════════════════════════════════════════════════════════
   PIE WHEEL
══════════════════════════════════════════════════════════ */
const WHEEL_SIZE = 280;

/* Wraps a wheel label onto at most two lines instead of chopping it mid-word
   ("Shrimp & Sh…"). Splits at the space that leaves the most even halves. */
function wrapLabel(text, maxChars = 13) {
  if (text.length <= maxChars) return [text];
  const words = text.split(" ");
  if (words.length === 1) return [text]; // one long word — shrink instead
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" "), b = words.slice(i).join(" ");
    const score = Math.abs(a.length - b.length) + Math.max(0, a.length - maxChars) * 3 + Math.max(0, b.length - maxChars) * 3;
    if (!best || score < best.score) best = { score, lines: [a, b] };
  }
  return best.lines;
}

function PieWheel({ items, color, phase, winner, onSpinEnd }) {
  const SIZE = WHEEL_SIZE;
  const cx = SIZE / 2, cy = SIZE / 2, r = SIZE / 2 - 4;
  const n = items.length;
  const segAngle = 360 / n;
  const rotationRef = useRef(0);
  const wheelRef = useRef(null);
  const spinStateRef = useRef({ active: false, speed: 0, lastTs: null });
  const rafRef = useRef(null);
  const [displayRot, setDisplayRot] = useState(0);

  // Geometry only depends on the item list — compute segment paths/labels once.
  const segments = useMemo(() => {
    const polar = (angleDeg, radius) => {
      const rad = ((angleDeg - 90) * Math.PI) / 180;
      return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
    };
    return items.map((item, i) => {
      const start = i * segAngle, end = start + segAngle;
      const p1 = polar(start, r), p2 = polar(end, r);
      const d = "M " + cx + " " + cy + " L " + p1.x + " " + p1.y + " A " + r + " " + r + " 0 " + (segAngle > 180 ? 1 : 0) + " 1 " + p2.x + " " + p2.y + " Z";
      const lp = polar(i * segAngle + segAngle / 2, r * 0.62);

      // Labels on the left half would render upside down, so flip them 180°.
      let labelAngle = i * segAngle + segAngle / 2 - 90;
      const facing = ((labelAngle % 360) + 360) % 360;
      if (facing > 90 && facing < 270) labelAngle += 180;

      return { item, d, lp, labelAngle, lines: wrapLabel(item) };
    });
  }, [items, segAngle, cx, cy, r]);

  useEffect(() => {
    if (phase === "spinning") {
      spinStateRef.current = { active: true, speed: 8, lastTs: null };
      function frame(ts) {
        const s = spinStateRef.current;
        if (!s.active) return;
        if (!s.lastTs) s.lastTs = ts;
        const dt = Math.min(ts - s.lastTs, 50);
        s.lastTs = ts;
        rotationRef.current = (rotationRef.current + s.speed * (dt / 16)) % 36000;
        setDisplayRot(rotationRef.current);
        rafRef.current = requestAnimationFrame(frame);
      }
      rafRef.current = requestAnimationFrame(frame);
      return () => { spinStateRef.current.active = false; cancelAnimationFrame(rafRef.current); };
    }
    if (phase === "stopping" && winner) {
      spinStateRef.current.active = false;
      cancelAnimationFrame(rafRef.current);
      const wi = items.indexOf(winner);
      const curMod = rotationRef.current % 360;
      const segCenter = wi * segAngle + segAngle / 2;
      let targetMod = ((-segCenter) % 360 + 360) % 360;
      let travelDelta = (targetMod - curMod + 360) % 360;
      if (travelDelta < 90) travelDelta += 360;
      travelDelta += 720;
      const finalRot = rotationRef.current + travelDelta;
      if (wheelRef.current) {
        wheelRef.current.style.transition = "transform 1.4s cubic-bezier(0.25,0.1,0.1,1)";
        wheelRef.current.style.transform = "rotate(" + finalRot + "deg)";
        rotationRef.current = finalRot;
      }
      const t = setTimeout(() => onSpinEnd && onSpinEnd(), 1500);
      return () => clearTimeout(t);
    }
    if (phase === "idle") {
      spinStateRef.current.active = false;
      cancelAnimationFrame(rafRef.current);
      if (wheelRef.current) {
        wheelRef.current.style.transition = "none";
        wheelRef.current.style.transform = "rotate(" + rotationRef.current + "deg)";
      }
    }
  }, [phase, winner]);

  useEffect(() => {
    if (phase === "spinning" && wheelRef.current) {
      wheelRef.current.style.transition = "none";
      wheelRef.current.style.transform = "rotate(" + displayRot + "deg)";
    }
  }, [displayRot, phase]);

  return (
    <div style={{ position:"relative", width:SIZE, height:SIZE+32, display:"flex", flexDirection:"column", alignItems:"center" }}>
      <div style={{ width:0, height:0, borderLeft:"12px solid transparent", borderRight:"12px solid transparent", borderTop:"26px solid " + color, position:"absolute", top:0, left:"50%", transform:"translateX(-50%)", zIndex:10 }} />
      <div ref={wheelRef} style={{ width:SIZE, height:SIZE, borderRadius:"50%", overflow:"hidden", boxShadow:"0 4px 24px rgba(44,40,37,0.14)", marginTop:6, willChange:"transform" }}>
        <svg width={SIZE} height={SIZE} viewBox={"0 0 " + SIZE + " " + SIZE}>
          {segments.map((seg, i) => (
            <g key={i}>
              <path d={seg.d} fill={SEG_COLORS[i % SEG_COLORS.length]} stroke="#fff" strokeWidth="1.5" />
              <text x={seg.lp.x} y={seg.lp.y} textAnchor="middle" dominantBaseline="middle"
                transform={"rotate(" + seg.labelAngle + "," + seg.lp.x + "," + seg.lp.y + ")"}
                fontSize={seg.lines.some(l => l.length > 13) ? 9 : n > 6 ? 10 : 12}
                fontFamily={SANS} fontWeight="500" fill="#fff"
                style={{ pointerEvents:"none", userSelect:"none" }}>
                {seg.lines.map((line, li) => (
                  <tspan key={li} x={seg.lp.x} dy={li === 0 ? (seg.lines.length > 1 ? "-0.55em" : "0") : "1.1em"}>{line}</tspan>
                ))}
              </text>
            </g>
          ))}
          <circle cx={cx} cy={cy} r={22} fill={ZEN.bg} stroke="#fff" strokeWidth="2" />
          <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" fontSize="18">🍽️</text>
        </svg>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   SPIN SCREEN
══════════════════════════════════════════════════════════ */
function SpinScreen({ step, stepIdx, total, onDone }) {
  const { label, emoji, color, items } = step;
  const [phase, setPhase] = useState("idle");
  const [winner, setWinner] = useState(null);
  const tappedRef = useRef(false);

  function handleSpin() { if (phase !== "idle") return; tappedRef.current = false; setPhase("spinning"); }
  function handleStop() {
    if (phase !== "spinning" || tappedRef.current) return;
    tappedRef.current = true;
    const w = pick(items); setWinner(w); setPhase("stopping");
  }
  function handleSpinEnd() { setPhase("done"); }

  return (
    <div style={{ minHeight:"100vh", background:ZEN.bg, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"40px 28px", position:"relative" }}>
      <div style={{ position:"absolute", top:28, display:"flex", gap:10 }}>
        {STEPS.map((s, i) => <div key={s.key} style={{ width:i===stepIdx?32:10, height:10, borderRadius:5, background:i<stepIdx?color:i===stepIdx?color:ZEN.border, opacity:i<stepIdx?0.4:1, transition:"all 0.4s" }} />)}
      </div>
      <div style={{ fontSize:11, letterSpacing:"3px", color:ZEN.muted, fontFamily:SANS, marginBottom:12, textTransform:"uppercase" }}>{stepIdx+1} of {total}</div>
      <div style={{ fontSize:56, marginBottom:8, lineHeight:1 }}>{emoji}</div>
      <h2 style={{ fontFamily:SERIF, fontSize:34, fontWeight:400, color:ZEN.text, margin:"0 0 32px", letterSpacing:1 }}>{label}</h2>
      <PieWheel items={items} color={color} phase={phase} winner={winner} onSpinEnd={handleSpinEnd} />
      <div style={{ marginTop:40, height:72, display:"flex", alignItems:"center", justifyContent:"center" }}>
        {phase === "idle" && <button onTouchStart={handleSpin} onClick={handleSpin} style={btn({ background:color, color:"#fff", borderRadius:50, padding:"18px 60px", fontSize:20, boxShadow:"0 4px 28px "+color+"44" })}>Spin</button>}
        {phase === "spinning" && <button onTouchStart={handleStop} onClick={handleStop} style={btn({ background:color, color:"#fff", borderRadius:50, padding:"18px 60px", fontSize:20, boxShadow:"0 4px 28px "+color+"55", animation:"softPulse 1.2s ease infinite alternate" })}>Stop</button>}
        {phase === "stopping" && <p style={{ color:ZEN.muted, fontSize:16, fontFamily:SANS }}>Landing…</p>}
        {phase === "done" && winner && (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:14, animation:"fadeIn 0.5s ease" }}>
            <p style={{ color, fontSize:22, fontFamily:SERIF, fontWeight:600 }}>✓ {winner}</p>
            <button onTouchStart={() => onDone(winner)} onClick={() => onDone(winner)} style={btn({ background:color, color:"#fff", borderRadius:50, padding:"16px 52px", fontSize:19, boxShadow:"0 4px 24px "+color+"44" })}>Next →</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   RESPIN MODAL
══════════════════════════════════════════════════════════ */
function RespinModal({ step, onSave, onClose }) {
  const { label, emoji, color, items } = step;
  const [reelPhase, setReelPhase] = useState("idle");
  const [lockedItem, setLockedItem] = useState(null);
  const [manual, setManual] = useState("");
  const [tab, setTab] = useState("spin");
  const tappedRef = useRef(false);

  function startSpin() { setLockedItem(null); tappedRef.current = false; setReelPhase("spinning"); }
  function handleStop() {
    if (reelPhase !== "spinning" || tappedRef.current) return;
    tappedRef.current = true;
    const w = pick(items); setLockedItem(w); setReelPhase("stopping");
  }

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(44,40,37,0.55)", display:"flex", alignItems:"flex-end", justifyContent:"center", zIndex:100 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background:ZEN.bg, borderRadius:"24px 24px 0 0", padding:"28px 24px 40px", width:"100%", maxWidth:480, animation:"slideUp 0.3s ease" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}><span style={{ fontSize:28 }}>{emoji}</span><span style={{ fontFamily:SERIF, fontSize:22, color:ZEN.text }}>{label}</span></div>
          <button onClick={onClose} style={{ background:"none", border:"none", fontSize:22, color:ZEN.muted, cursor:"pointer" }}>✕</button>
        </div>
        <div style={{ display:"flex", gap:8, marginBottom:24 }}>
          {["spin","manual"].map(t => <button key={t} onClick={() => setTab(t)} style={btn({ flex:1, padding:"10px", borderRadius:10, background:tab===t?color:ZEN.surface, color:tab===t?"#fff":ZEN.muted, fontSize:15 })}>{t === "spin" ? "Re-spin" : "Type it in"}</button>)}
        </div>
        {tab === "spin" && (
          <div style={{ display:"flex", flexDirection:"column", gap:12, alignItems:"center" }}>
            <PieWheel items={items} color={color} phase={reelPhase} winner={lockedItem} onSpinEnd={() => setReelPhase("locked")} />
            <div style={{ height:52, display:"flex", alignItems:"center", justifyContent:"center" }}>
              {reelPhase === "idle" && <button onTouchStart={startSpin} onClick={startSpin} style={btn({ background:color, color:"#fff", borderRadius:50, padding:"12px 40px", fontSize:16 })}>Spin</button>}
              {reelPhase === "spinning" && <button onTouchStart={handleStop} onClick={handleStop} style={btn({ background:color, color:"#fff", borderRadius:50, padding:"12px 40px", fontSize:16, animation:"softPulse 1.2s ease infinite alternate" })}>Stop</button>}
              {reelPhase === "stopping" && <p style={{ color:ZEN.muted, fontSize:15, fontFamily:SANS }}>Landing…</p>}
              {reelPhase === "locked" && lockedItem && <p style={{ color, fontSize:16, fontFamily:SERIF, fontWeight:600 }}>✓ {lockedItem}</p>}
            </div>
            {reelPhase === "locked" && lockedItem && (
              <div style={{ width:"100%", display:"flex", flexDirection:"column", gap:10, alignItems:"center" }}>
                <button onTouchStart={() => onSave(lockedItem)} onClick={() => onSave(lockedItem)} style={btn({ width:"100%", background:color, color:"#fff", borderRadius:12, padding:"14px", fontSize:17 })}>Use "{lockedItem}"</button>
                <button onTouchStart={startSpin} onClick={startSpin} style={{ background:"none", border:"none", color:ZEN.muted, fontSize:14, fontFamily:SANS, cursor:"pointer", textDecoration:"underline" }}>Spin again</button>
              </div>
            )}
          </div>
        )}
        {tab === "manual" && (
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            <div style={{ display:"flex", flexWrap:"wrap", gap:8, maxHeight:200, overflowY:"auto" }}>
              {items.map(it => <button key={it} onClick={() => setManual(it)} style={{ background:manual===it?color:ZEN.surface, color:manual===it?"#fff":ZEN.text, border:"1.5px solid "+(manual===it?color:ZEN.border), borderRadius:20, padding:"8px 16px", fontFamily:SANS, fontSize:15, cursor:"pointer" }}>{it}</button>)}
            </div>
            <input value={manual} onChange={e => setManual(e.target.value)} placeholder="Or type your own…" style={{ width:"100%", padding:"12px 14px", border:"1.5px solid "+ZEN.border, borderRadius:10, background:ZEN.surface, color:ZEN.text, fontFamily:SANS, fontSize:16, outline:"none" }} />
            <button onClick={() => manual.trim() && onSave(manual.trim())} disabled={!manual.trim()} style={btn({ background:manual.trim()?color:ZEN.border, color:manual.trim()?"#fff":ZEN.muted, borderRadius:12, padding:"14px", fontSize:17, cursor:manual.trim()?"pointer":"default" })}>Save</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   SHARE MODAL
══════════════════════════════════════════════════════════ */
function ShareModal({ title, text, onClose }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
    } else {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand("copy"); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch(e) {}
      document.body.removeChild(ta);
    }
  }
  function handleShare() { if (navigator.share) navigator.share({ title, text }).catch(() => {}); }

  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(44,40,37,0.6)", display:"flex", alignItems:"flex-end", justifyContent:"center", zIndex:200 }}>
      <div onClick={e => e.stopPropagation()} style={{ background:ZEN.bg, borderRadius:"24px 24px 0 0", padding:"28px 24px 48px", width:"100%", maxWidth:520, animation:"slideUp 0.3s ease", maxHeight:"80vh", display:"flex", flexDirection:"column", gap:16 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <h3 style={{ fontFamily:SERIF, fontSize:20, fontWeight:400, color:ZEN.text }}>{title}</h3>
          <button onClick={onClose} style={{ background:"none", border:"none", fontSize:22, color:ZEN.muted, cursor:"pointer" }}>✕</button>
        </div>
        <pre style={{ fontFamily:SANS, fontSize:14, color:ZEN.text, background:"#fff", border:"1px solid "+ZEN.border, borderRadius:12, padding:"14px 16px", overflowY:"auto", flex:1, whiteSpace:"pre-wrap", wordBreak:"break-word", lineHeight:1.7 }}>{text}</pre>
        <div style={{ display:"flex", gap:10 }}>
          <button onTouchStart={handleCopy} onClick={handleCopy} style={btn({ flex:1, background:copied?"#3D6E52":ZEN.text, color:"#fff", borderRadius:12, padding:"14px", fontSize:16 })}>{copied ? "Copied ✓" : "Copy text"}</button>
          {typeof navigator !== "undefined" && navigator.share && <button onTouchStart={handleShare} onClick={handleShare} style={btn({ flex:1, background:"transparent", color:ZEN.text, border:"1.5px solid "+ZEN.border, borderRadius:12, padding:"14px", fontSize:16 })}>Share</button>}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   SUMMARY SCREEN
══════════════════════════════════════════════════════════ */
/* Servings and difficulty rarely change night to night, so remember the last
   choice instead of resetting to 2/Medium on every spin. */
const PREFS_KEY = "dinner-spinner-prefs";
function readPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch { return {}; }
}
function writePrefs(patch) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...patch })); } catch { /* quota */ }
}

/* toppings/diff/servings are owned by App, not this screen — otherwise leaving
   for the pantry or a recipe and coming back would wipe what you typed. */
function SummaryScreen({ results, setResults, onGenerate, onPantry, pantryCount, prefs, setPrefs, header }) {
  const { toppings, diff, servings } = prefs;
  const [editing, setEditing] = useState(null);
  const submittingRef = useRef(false);
  const editingStep = editing ? STEPS.find(s => s.key === editing) : null;

  const setToppings = v => setPrefs(p => ({ ...p, toppings: v }));
  const setDiff = v => { setPrefs(p => ({ ...p, diff: v })); writePrefs({ diff: v }); };
  const setServings = v => { setPrefs(p => ({ ...p, servings: v })); writePrefs({ servings: v }); };

  function handleGetRecipes() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    onGenerate({ toppings, diff, servings }, results);
    setTimeout(() => { submittingRef.current = false; }, 5000);
  }

  return (
    <div style={{ minHeight:"100vh", background:ZEN.bg, fontFamily:SANS, position:"relative" }}>
      {header}
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", padding:"32px 24px 120px", gap:28 }}>
      <div style={{ textAlign:"center" }}>
        <p style={{ fontSize:13, letterSpacing:"2px", color:ZEN.muted, marginBottom:10, textTransform:"uppercase" }}>Ready to cook</p>
        <h1 style={{ fontFamily:SERIF, fontSize:32, fontWeight:400, color:ZEN.text, letterSpacing:1 }}>Today's ingredients</h1>
      </div>
      <div style={{ display:"flex", gap:12, flexWrap:"wrap", justifyContent:"center", maxWidth:480 }}>
        {STEPS.map(s => (
          <button key={s.key} onClick={() => setEditing(s.key)} style={{ background:"#fff", border:"2px solid "+s.color+"33", borderRadius:50, padding:"12px 22px", display:"flex", alignItems:"center", gap:10, cursor:"pointer", boxShadow:"0 2px 8px rgba(44,40,37,0.06)", animation:"fadeIn 0.4s ease", WebkitTapHighlightColor:"transparent", touchAction:"manipulation" }}>
            <span style={{ fontSize:22 }}>{s.emoji}</span>
            <span style={{ fontFamily:SERIF, fontSize:18, color:ZEN.text }}>{results[s.key]}</span>
            <span style={{ fontSize:13, color:ZEN.faint }}>✎</span>
          </button>
        ))}
      </div>
      <p style={{ fontSize:14, color:ZEN.muted, marginTop:-12 }}>Tap any ingredient to change it</p>
      <div style={{ width:"100%", maxWidth:440 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:6 }}>
          <label style={{ fontSize:14, color:ZEN.muted }}>Ingredients you want to try to use</label>
          <span style={{ fontSize:12, color:ZEN.faint, fontStyle:"italic" }}>optional</span>
        </div>
        <textarea value={toppings} onChange={e => setToppings(e.target.value)} placeholder="Just for tonight — garlic, lemon, that half tin of coconut milk… recipes will try to work them in but no promises." rows={3} style={{ width:"100%", background:"#fff", border:"1.5px solid "+ZEN.border, borderRadius:12, color:ZEN.text, fontSize:15, fontFamily:SANS, padding:"12px 14px", resize:"vertical", lineHeight:1.6 }} />
        <button onClick={onPantry} style={btn({ background:"none", color:ZEN.muted, padding:"10px 0 0", fontSize:14, fontWeight:400, textDecoration:"underline" })}>
          🥫 {pantryCount ? "Using " + pantryCount + " pantry item" + (pantryCount === 1 ? "" : "s") : "Set up your pantry"}
        </button>
      </div>
      <div style={{ width:"100%", maxWidth:440 }}>
        <div style={{ fontSize:14, color:ZEN.muted, marginBottom:10 }}>How much effort tonight?</div>
        <div style={{ display:"flex", gap:10 }}>
          {DIFF.map(d => {
            const sel = diff === d.key;
            return <button key={d.key} onClick={() => setDiff(d.key)} style={btn({ flex:1, background:sel?d.color:"#fff", border:"1.5px solid "+(sel?d.color:ZEN.border), color:sel?"#fff":ZEN.text, borderRadius:12, padding:"12px 6px", fontSize:15 })}><div style={{ fontSize:22, marginBottom:4 }}>{d.icon}</div>{d.label}<div style={{ fontSize:12, marginTop:3, opacity:0.75, fontWeight:400 }}>{d.desc}</div></button>;
          })}
        </div>
      </div>
      <div style={{ width:"100%", maxWidth:440 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <span style={{ fontSize:14, color:ZEN.muted }}>Servings</span>
          <span style={{ fontSize:18, fontFamily:SERIF, color:ZEN.text, fontWeight:600 }}>{servings} people</span>
        </div>
        <input type="range" min={1} max={8} step={1} value={servings}
          onChange={e => setServings(Number(e.target.value))}
          style={{ width:"100%", accentColor:"#7A5C2E", height:6, cursor:"pointer" }} />
        <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:ZEN.faint, marginTop:4 }}>
          {[1,2,3,4,5,6,7,8].map(n => <span key={n}>{n}</span>)}
        </div>
      </div>
      </div>
      {editing && editingStep && <RespinModal step={editingStep} onSave={val => { setResults(r => ({ ...r, [editing]: val })); setEditing(null); }} onClose={() => setEditing(null)} />}
      <div style={{ position:"fixed", bottom:0, left:0, right:0, padding:"16px 24px 32px", background:"linear-gradient(to top, "+ZEN.bg+" 60%, transparent)", display:"flex", justifyContent:"center", zIndex:50 }}>
        <div onTouchStart={e => { e.preventDefault(); handleGetRecipes(); }} onClick={handleGetRecipes} role="button" style={{ background:ZEN.text, WebkitTapHighlightColor:"transparent", touchAction:"manipulation", color:"#fff", borderRadius:14, padding:"18px 0", fontSize:19, fontFamily:SANS, fontWeight:500, cursor:"pointer", textAlign:"center", width:"100%", maxWidth:440, boxShadow:"0 4px 24px rgba(44,40,37,0.22)", userSelect:"none", WebkitUserSelect:"none" }}>Get recipes →</div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   RECIPES SCREEN
══════════════════════════════════════════════════════════ */
function RecipesScreen({ recipes, onBack, onRestart, onSelect, header }) {
  const accents = ["#8B4A3A","#3D6E52"];
  return (
    <div style={{ minHeight:"100vh", background:ZEN.bg, fontFamily:SANS }}>
      {header}
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", padding:"32px 24px 80px", gap:24 }}>
      <div style={{ textAlign:"center" }}>
        <p style={{ fontSize:13, letterSpacing:"2px", color:ZEN.muted, marginBottom:10, textTransform:"uppercase" }}>Choose one</p>
        <h1 style={{ fontFamily:SERIF, fontSize:32, fontWeight:400, color:ZEN.text, letterSpacing:1 }}>Tonight's recipes</h1>
      </div>
      <div style={{ width:"100%", maxWidth:480, display:"flex", flexDirection:"column", gap:16 }}>
        {recipes.map((r, i) => {
          const c = accents[i % accents.length];
          return (
            <div key={i} style={{ background:"#fff", border:"1.5px solid "+ZEN.border, borderLeft:"5px solid "+c, borderRadius:16, padding:"22px 24px", animation:"slideIn 0.4s ease "+(i*0.15)+"s both", boxShadow:"0 2px 12px rgba(44,40,37,0.06)" }}>
              <div style={{ fontSize:13, letterSpacing:"1px", color:c, fontFamily:SANS, fontWeight:500, marginBottom:8, textTransform:"uppercase" }}>Option {i+1}</div>
              <div style={{ fontSize:22, fontFamily:SERIF, color:ZEN.text, marginBottom:10, lineHeight:1.3 }}>{r.name}</div>
              <div style={{ fontSize:17, color:ZEN.muted, lineHeight:1.7, marginBottom:14 }}>{r.description}</div>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:20 }}>
                {(r.tags||[]).map(tag => <span key={tag} style={{ fontSize:13, color:c, background:c+"12", borderRadius:20, padding:"4px 12px", fontFamily:SANS }}>{tag}</span>)}
              </div>
              <button onTouchStart={() => onSelect(r)} onClick={() => onSelect(r)} style={btn({ width:"100%", background:c, color:"#fff", borderRadius:12, padding:"14px", fontSize:17 })}>Cook this →</button>
            </div>
          );
        })}
      </div>
      <button onClick={onBack} style={{ background:"#fff", border:"1.5px solid "+ZEN.border, color:ZEN.muted, borderRadius:12, padding:"13px 32px", fontSize:16, fontFamily:SANS, cursor:"pointer" }}>← Back to ingredients</button>
      <button onClick={onRestart} style={{ background:"none", border:"none", color:ZEN.faint, fontSize:14, fontFamily:SANS, cursor:"pointer", textDecoration:"underline" }}>Start over</button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   GROCERY LIST
══════════════════════════════════════════════════════════ */
/* Your own errands list, independent of any recipe. Rendered in two places:
   inside the recipe shopping list (as "Also need") and on its own from the
   header, so "we're out of milk" doesn't require spinning up a dinner first.
   One component so the two can't drift apart. */
const GROCERY_COLOR = "#3D6E52";

function GroceryList({ pantry, setPantry }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null); // { added, duplicates, similar }
  const items = pantry.shopping || [];

  async function handleAdd(e, { force = false } = {}) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const res = await addItems(KINDS.SHOPPING, text, { force });
      setPantry(res.pantry);
      // Typo-suspects stay in the box so they can be fixed in place.
      setDraft(res.similar.length && !force ? res.similar.map(x => x.name).join(", ") : "");
      setNotice(res.added.length || res.duplicates.length || res.similar.length ? res : null);
    } finally { setBusy(false); }
  }

  async function handleRemove(name) {
    setNotice(null);
    setPantry(await removeItems(KINDS.SHOPPING, name));
  }

  return (
    <>
      <form onSubmit={handleAdd} style={{ display:"flex", gap:8 }}>
        <input value={draft} onChange={e => { setDraft(e.target.value); setNotice(null); }} maxLength={400}
          placeholder="milk, paper towels, coffee…"
          style={{ flex:1, padding:"12px 14px", border:"1.5px solid "+ZEN.border, borderRadius:10, background:"#fff", color:ZEN.text, fontFamily:SANS, fontSize:16, outline:"none" }} />
        <button type="submit" disabled={!draft.trim() || busy}
          style={btn({ background:draft.trim()?GROCERY_COLOR:ZEN.border, color:draft.trim()?"#fff":ZEN.muted, borderRadius:10, padding:"12px 20px", fontSize:16, cursor:draft.trim()?"pointer":"default" })}>Add</button>
      </form>
      <p style={{ fontSize:12, color:ZEN.faint, fontFamily:SANS, margin:"8px 0 0" }}>Separate several with commas.</p>

      {notice && (
        <div style={{ display:"flex", flexDirection:"column", gap:6, fontFamily:SANS, fontSize:13, marginTop:10 }}>
          {notice.added.length > 0 && <span style={{ color:GROCERY_COLOR }}>✓ Added {notice.added.join(", ")}</span>}
          {notice.duplicates.length > 0 && <span style={{ color:ZEN.muted }}>Already on your list: {notice.duplicates.join(", ")}</span>}
          {notice.similar.map(x => (
            <span key={x.name} style={{ color:"#8B4A3A", display:"flex", flexWrap:"wrap", alignItems:"center", gap:6 }}>
              “{x.name}” looks like a typo of “{x.to}”.
              <button onClick={e => handleAdd(e, { force: true })}
                style={btn({ background:"none", color:"#8B4A3A", fontSize:13, padding:0, textDecoration:"underline" })}>Add it anyway</button>
            </span>
          ))}
        </div>
      )}

      {items.map(item => (
        <div key={item.name} style={{ display:"flex", alignItems:"center", gap:16, padding:"13px 0", borderBottom:"1px solid "+ZEN.surface }}>
          <button onClick={() => handleRemove(item.name)} aria-label={"Got " + item.name}
            style={{ width:26, height:26, borderRadius:6, flexShrink:0, background:"#fff", border:"2px solid "+ZEN.border, cursor:"pointer", padding:0 }} />
          <span style={{ flex:1, fontSize:18, color:ZEN.text }}>{item.name}</span>
          <button onClick={() => handleRemove(item.name)} aria-label={"Remove " + item.name}
            style={{ background:"none", border:"none", color:ZEN.faint, fontSize:16, cursor:"pointer", padding:"0 4px" }}>✕</button>
        </div>
      ))}
      {items.length > 0 && <p style={{ fontSize:12, color:ZEN.faint, marginTop:10 }}>Tick or ✕ to clear an item once you’ve got it.</p>}
    </>
  );
}

/* The same list on its own, reachable from the header and the welcome screen. */
function GroceryModal({ pantry, setPantry, onClose }) {
  const count = (pantry.shopping || []).length;
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(44,40,37,0.6)", display:"flex", alignItems:"flex-end", justifyContent:"center", zIndex:300 }}>
      <div onClick={e => e.stopPropagation()} style={{ background:ZEN.bg, borderRadius:"24px 24px 0 0", padding:"26px 24px 40px", width:"100%", maxWidth:520, maxHeight:"88vh", display:"flex", flexDirection:"column", gap:16, animation:"slideUp 0.3s ease" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:26 }}>🛒</span>
            <span style={{ fontFamily:SERIF, fontSize:22, color:ZEN.text }}>Grocery list</span>
          </div>
          <button onClick={onClose} style={{ background:"none", border:"none", fontSize:22, color:ZEN.muted, cursor:"pointer" }}>✕</button>
        </div>

        <p style={{ fontSize:14, color:ZEN.muted, fontFamily:SANS, lineHeight:1.5, margin:0 }}>
          Anything you need from the shop. Nothing here has to be about dinner, and it keeps between visits.
        </p>

        <div style={{ flex:1, overflowY:"auto", minHeight:80 }}>
          <GroceryList pantry={pantry} setPantry={setPantry} />
          {count === 0 && (
            <p style={{ fontSize:15, color:ZEN.faint, fontFamily:SANS, textAlign:"center", padding:"24px 0", fontStyle:"italic" }}>Nothing on the list yet.</p>
          )}
        </div>

        <p style={{ fontSize:12, color:ZEN.faint, fontFamily:SANS, textAlign:"center", margin:0 }}>
          {syncEnabled ? "☁️ Synced across your devices" : "💾 Saved on this device only"}
        </p>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   SHOPPING LIST SCREEN
══════════════════════════════════════════════════════════ */
function ShoppingListScreen({ recipe, onCook, onBack, servings, onAddToPantry, header, pantry, setPantry }) {
  const [checked, setChecked] = useState(new Set());
  const [showShare, setShowShare] = useState(false);
  const [stashed, setStashed] = useState(null);
  function toggle(i) { setChecked(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; }); }

  const total = recipe.shoppingList?.length || 0;
  const done = checked.size;

  // Checking things off already means "I have this", so reuse that as the
  // signal for what to file into the pantry. Quantities are stripped first.
  async function stash(kind) {
    const names = [...checked]
      .map(i => ingredientName(recipe.shoppingList[i]))
      .filter(Boolean);
    if (!names.length) return;
    const res = await onAddToPantry(kind, names);
    setStashed({ kind, count: res.added.length, skipped: res.duplicates.length + res.similar.length });
    setChecked(new Set());
  }

  return (
    <div style={{ minHeight:"100vh", background:ZEN.bg, fontFamily:SANS }}>
      {header}
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", padding:"28px 24px 100px" }}>
      <div style={{ width:"100%", maxWidth:480 }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:ZEN.muted, fontFamily:SANS, fontSize:15, cursor:"pointer", marginBottom:24, padding:0 }}>← Back to recipes</button>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 }}>
          <p style={{ fontSize:13, letterSpacing:"2px", color:ZEN.muted, textTransform:"uppercase" }}>Shopping list</p>
          <button onTouchStart={() => setShowShare(true)} onClick={() => setShowShare(true)} style={{ background:"none", border:"1.5px solid "+ZEN.border, borderRadius:8, padding:"5px 12px", fontSize:13, color:ZEN.muted, fontFamily:SANS, cursor:"pointer", WebkitTapHighlightColor:"transparent", touchAction:"manipulation" }}>↑ Save / Share</button>
        </div>
        <h1 style={{ fontFamily:SERIF, fontSize:28, fontWeight:400, color:ZEN.text, lineHeight:1.3, marginBottom:6 }}>{recipe.name}</h1>
        <p style={{ fontSize:15, color:ZEN.muted, marginBottom:24 }}>{done === total && total > 0 ? "All good to go ✓" : done + " of " + total + " checked"}</p>
        <div style={{ width:"100%", height:4, background:ZEN.surface, borderRadius:2, marginBottom:28, overflow:"hidden" }}>
          <div style={{ height:"100%", borderRadius:2, background:"#3D6E52", width:total>0?(done/total*100)+"%":"0%", transition:"width 0.3s" }} />
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
          {recipe.shoppingList?.map((item, i) => {
            const ticked = checked.has(i);
            return (
              <div key={i} onClick={() => toggle(i)} style={{ display:"flex", alignItems:"center", gap:16, padding:"13px 0", borderBottom:"1px solid "+ZEN.surface, cursor:"pointer", animation:"fadeIn 0.3s ease "+(i*0.04)+"s both" }}>
                <div style={{ width:26, height:26, borderRadius:6, flexShrink:0, background:ticked?"#3D6E52":"#fff", border:"2px solid "+(ticked?"#3D6E52":ZEN.border), display:"flex", alignItems:"center", justifyContent:"center", transition:"all 0.2s" }}>
                  {ticked && <span style={{ color:"#fff", fontSize:14, fontWeight:700 }}>✓</span>}
                </div>
                <span style={{ fontSize:18, color:ticked?ZEN.faint:ZEN.text, textDecoration:ticked?"line-through":"none" }}>{item}</span>
              </div>
            );
          })}
        </div>
        {/* Your own errands list, the same one the header opens. Persists
            between recipes, since "we're out of milk" has nothing to do with
            tonight's dinner. */}
        <div style={{ marginTop:30, borderTop:"1px solid "+ZEN.border, paddingTop:22 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:10 }}>
            <span style={{ fontSize:13, letterSpacing:"2px", color:ZEN.muted, textTransform:"uppercase" }}>Also need</span>
            <span style={{ fontSize:12, color:ZEN.faint, fontStyle:"italic" }}>your own list</span>
          </div>
          <GroceryList pantry={pantry} setPantry={setPantry} />
        </div>

        {/* Filing bought items into the pantry keeps it current without a separate chore. */}
        {done > 0 && (
          <div style={{ marginTop:24, background:"#fff", border:"1.5px solid "+ZEN.border, borderRadius:14, padding:"16px 18px", display:"flex", flexDirection:"column", gap:10 }}>
            <span style={{ fontSize:14, color:ZEN.text, fontFamily:SANS }}>Add the {done} checked item{done === 1 ? "" : "s"} to your pantry?</span>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
              <button onClick={() => stash(KINDS.STAPLE)} style={btn({ background:"#7A5C2E", color:"#fff", borderRadius:8, padding:"9px 14px", fontSize:14 })}>🧂 As staples</button>
              <button onClick={() => stash(KINDS.USE_SOON)} style={btn({ background:"#8B4A3A", color:"#fff", borderRadius:8, padding:"9px 14px", fontSize:14 })}>⏳ Use up soon</button>
            </div>
          </div>
        )}
        {stashed && (
          <p style={{ marginTop:14, fontSize:14, color:"#3D6E52", fontFamily:SANS }}>
            ✓ Added {stashed.count} to {stashed.kind === KINDS.STAPLE ? "staples" : "use up soon"}
            {stashed.skipped > 0 ? " (" + stashed.skipped + " already there)" : ""}
          </p>
        )}
      </div>
      </div>
      {showShare && <ShareModal title={recipe.name + " — Shopping List"} text={buildShoppingText(recipe, servings)} onClose={() => setShowShare(false)} />}
      <div style={{ position:"fixed", bottom:0, left:0, right:0, padding:"16px 24px 32px", background:"linear-gradient(to top, "+ZEN.bg+" 70%, transparent)", display:"flex", justifyContent:"center" }}>
        <button onTouchStart={onCook} onClick={onCook} style={btn({ background:ZEN.text, color:"#fff", borderRadius:14, padding:"16px 48px", fontSize:18, width:"100%", maxWidth:440, boxShadow:"0 4px 20px rgba(44,40,37,0.18)" })}>Let's cook →</button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   RECIPE STEPS SCREEN
══════════════════════════════════════════════════════════ */
function RecipeStepsScreen({ recipe, onBack, servings, saved, onToggleSave, header, onDone }) {
  const [doneSteps, setDoneSteps] = useState(new Set());
  const [showShare, setShowShare] = useState(false);
  function toggle(i) { setDoneSteps(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; }); }
  const allDone = (recipe.steps?.length || 0) > 0 && doneSteps.size === recipe.steps.length;

  return (
    <div style={{ minHeight:"100vh", background:ZEN.bg, fontFamily:SANS }}>
      {header}
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", padding:"28px 24px 80px" }}>
      <div style={{ width:"100%", maxWidth:480 }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:ZEN.muted, fontFamily:SANS, fontSize:15, cursor:"pointer", marginBottom:24, padding:0 }}>← Back to shopping list</button>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 }}>
          <p style={{ fontSize:13, letterSpacing:"2px", color:ZEN.muted, textTransform:"uppercase" }}>How to make it</p>
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={onToggleSave} aria-label={saved ? "Remove from favourites" : "Save to favourites"}
              style={btn({ background:saved?"#8B4A3A":"none", border:"1.5px solid "+(saved?"#8B4A3A":ZEN.border), borderRadius:8, padding:"5px 12px", fontSize:13, color:saved?"#fff":ZEN.muted, fontWeight:400 })}>
              {saved ? "♥ Saved" : "♡ Save"}
            </button>
            <button onTouchStart={() => setShowShare(true)} onClick={() => setShowShare(true)} style={{ background:"none", border:"1.5px solid "+ZEN.border, borderRadius:8, padding:"5px 12px", fontSize:13, color:ZEN.muted, fontFamily:SANS, cursor:"pointer", WebkitTapHighlightColor:"transparent", touchAction:"manipulation" }}>↑ Share</button>
          </div>
        </div>
        <h1 style={{ fontFamily:SERIF, fontSize:28, fontWeight:400, color:ZEN.text, lineHeight:1.3, marginBottom:28 }}>{recipe.name}</h1>
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {recipe.steps?.map((step, i) => {
            const done = doneSteps.has(i);
            return (
              <div key={i} onClick={() => toggle(i)} style={{ display:"flex", gap:16, background:done?ZEN.surface:"#fff", border:"1.5px solid "+ZEN.border, borderRadius:14, padding:"18px", cursor:"pointer", opacity:done?0.5:1, animation:"fadeIn 0.3s ease "+(i*0.06)+"s both" }}>
                <div style={{ width:30, height:30, borderRadius:"50%", flexShrink:0, background:done?"#3D6E52":ZEN.surface, border:"2px solid "+(done?"#3D6E52":ZEN.border), display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, color:done?"#fff":ZEN.muted, fontWeight:600, marginTop:2, transition:"all 0.2s" }}>{done ? "✓" : i+1}</div>
                <p style={{ fontSize:18, color:ZEN.text, lineHeight:1.7, margin:0 }}>{step}</p>
              </div>
            );
          })}
        </div>
          {/* Highlighted once every step is ticked, but always available —
              nobody should be trapped here because they skipped a checkbox. */}
          <button onClick={onDone}
            style={btn({ marginTop:26, width:"100%", background:allDone?ZEN.text:"#fff", border:"1.5px solid "+(allDone?ZEN.text:ZEN.border), color:allDone?"#fff":ZEN.muted, borderRadius:14, padding:"16px", fontSize:17 })}>
            {allDone ? "✓ All done — finish up →" : "I'm done cooking →"}
          </button>
        </div>
      </div>
      {showShare && <ShareModal title={recipe.name} text={buildRecipeText(recipe, servings)} onClose={() => setShowShare(false)} />}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   LOADING SCREEN
══════════════════════════════════════════════════════════ */
const LOADING_MESSAGES = ["Spinning up your recipes…","Checking the pantry…","Consulting the chef…","Almost there…"];

function LoadingScreen({ results, error }) {
  const [msgIdx, setMsgIdx] = useState(0);
  useEffect(() => { const id = setInterval(() => setMsgIdx(i => (i+1) % LOADING_MESSAGES.length), 1800); return () => clearInterval(id); }, []);
  return (
    <div style={{ minHeight:"100vh", background:ZEN.bg, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"40px 28px", gap:28, fontFamily:SANS }}>
      <div style={{ fontSize:72, animation:"spin 2.4s linear infinite", lineHeight:1 }}>🍽️</div>
      <div style={{ display:"flex", gap:10, flexWrap:"wrap", justifyContent:"center", maxWidth:360 }}>
        {STEPS.map((s, i) => results[s.key] ? (
          <div key={s.key} style={{ background:"#fff", border:"2px solid "+s.color+"44", borderRadius:50, padding:"10px 18px", display:"flex", alignItems:"center", gap:8, animation:"pillPop 0.4s ease "+(i*0.1)+"s both" }}>
            <span style={{ fontSize:18 }}>{s.emoji}</span>
            <span style={{ fontFamily:SERIF, fontSize:16, color:ZEN.text }}>{results[s.key]}</span>
          </div>
        ) : null)}
      </div>
      <p style={{ fontSize:18, color:ZEN.muted, textAlign:"center", fontStyle:"italic" }}>{LOADING_MESSAGES[msgIdx]}</p>
      <div style={{ display:"flex", gap:8 }}>
        {[0,1,2].map(i => <div key={i} style={{ width:8, height:8, borderRadius:"50%", background:ZEN.faint, animation:"bounce "+(0.6+i*0.15)+"s ease-in-out infinite alternate" }} />)}
      </div>
      {error && <p style={{ color:"#8B4A3A", fontSize:15, textAlign:"center" }}>{error}</p>}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   WELCOME SCREEN
══════════════════════════════════════════════════════════ */
function WelcomeScreen({ onStart, onQuickPick, onPantry, pantryCount, onGrocery, groceryCount, onFavorites, favoriteCount }) {
  return (
    <div style={{ minHeight:"100vh", background:ZEN.bg, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"40px 28px", gap:0 }}>
      <div style={{ animation:"gentleSpin 18s linear infinite", fontSize:88, marginBottom:28, lineHeight:1 }}>🍽️</div>
      <h1 style={{ fontFamily:SERIF, fontSize:42, fontWeight:400, color:ZEN.text, letterSpacing:2, marginBottom:12, textAlign:"center", animation:"fadeIn 0.6s ease" }}>Dinner Spinner</h1>
      <p style={{ fontSize:17, color:ZEN.muted, fontFamily:SANS, marginBottom:48, textAlign:"center", lineHeight:1.6, animation:"fadeIn 0.7s ease" }}>Spin to discover tonight's meal</p>
      <button onTouchStart={onStart} onClick={onStart} style={btn({ background:"#8B4A3A", color:"#fff", borderRadius:50, padding:"20px 64px", fontSize:21, boxShadow:"0 6px 32px rgba(139,74,58,0.35)", animation:"fadeIn 0.9s ease", marginBottom:16 })}>Let's get cookin' 🔥</button>
      <button onTouchStart={onQuickPick} onClick={onQuickPick} style={btn({ background:"transparent", color:ZEN.muted, border:"1.5px solid "+ZEN.border, borderRadius:50, padding:"14px 40px", fontSize:16, fontWeight:400, animation:"fadeIn 1.1s ease", marginBottom:14 })}>🎲 Surprise me</button>
      <div style={{ display:"flex", gap:6, animation:"fadeIn 1.3s ease" }}>
        <button onTouchStart={onPantry} onClick={onPantry} style={btn({ background:"none", color:ZEN.faint, borderRadius:50, padding:"8px 14px", fontSize:15, fontWeight:400 })}>
          🥫 My pantry{pantryCount ? " (" + pantryCount + ")" : ""}
        </button>
        <button onTouchStart={onGrocery} onClick={onGrocery} style={btn({ background:"none", color:ZEN.faint, borderRadius:50, padding:"8px 14px", fontSize:15, fontWeight:400 })}>
          🛒 Grocery list{groceryCount ? " (" + groceryCount + ")" : ""}
        </button>
        <button onTouchStart={onFavorites} onClick={onFavorites} style={btn({ background:"none", color:ZEN.faint, borderRadius:50, padding:"8px 14px", fontSize:15, fontWeight:400 })}>
          ♥ Saved{favoriteCount ? " (" + favoriteCount + ")" : ""}
        </button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   CONFIRM MODAL
══════════════════════════════════════════════════════════ */
/* Guards anything that throws away the current session. Uses the app's own
   styling rather than window.confirm, which looks foreign and can't be themed. */
function ConfirmModal({ title, body, confirmLabel, onConfirm, onClose }) {
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(44,40,37,0.6)", display:"flex", alignItems:"center", justifyContent:"center", padding:24, zIndex:400 }}>
      <div onClick={e => e.stopPropagation()} style={{ background:ZEN.bg, borderRadius:18, padding:"26px 24px", width:"100%", maxWidth:380, display:"flex", flexDirection:"column", gap:14, animation:"fadeIn 0.2s ease", boxShadow:"0 12px 40px rgba(44,40,37,0.3)" }}>
        <h3 style={{ fontFamily:SERIF, fontSize:21, fontWeight:400, color:ZEN.text }}>{title}</h3>
        <p style={{ fontFamily:SANS, fontSize:15, color:ZEN.muted, lineHeight:1.6, margin:0 }}>{body}</p>
        <div style={{ display:"flex", gap:10, marginTop:6 }}>
          <button onClick={onClose} style={btn({ flex:1, background:"#fff", border:"1.5px solid "+ZEN.border, color:ZEN.text, borderRadius:12, padding:"13px", fontSize:16 })}>Stay here</button>
          <button onClick={onConfirm} style={btn({ flex:1, background:"#8B4A3A", color:"#fff", borderRadius:12, padding:"13px", fontSize:16 })}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   DONE SCREEN
══════════════════════════════════════════════════════════ */
/* Closes the loop after cooking: capture a verdict (which steers future
   suggestions), offer to save it, and file leftovers — then head home. */
function DoneScreen({ recipe, saved, onToggleSave, onFinish, onLeftovers, header }) {
  const [rating, setRating] = useState(null);
  const [note, setNote] = useState("");
  const [leftovers, setLeftovers] = useState("");
  const [filed, setFiled] = useState(false);

  async function fileLeftovers() {
    const res = await onLeftovers(leftovers);
    if (res?.added.length) { setFiled(true); setLeftovers(""); }
  }

  return (
    <div style={{ minHeight:"100vh", background:ZEN.bg, fontFamily:SANS }}>
      {header}
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", padding:"36px 24px 110px" }}>
        <div style={{ width:"100%", maxWidth:460, display:"flex", flexDirection:"column", gap:26 }}>

          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:56, lineHeight:1, marginBottom:12 }}>🍽️</div>
            <p style={{ fontSize:13, letterSpacing:"2px", color:ZEN.muted, textTransform:"uppercase", marginBottom:8 }}>Nicely done</p>
            <h1 style={{ fontFamily:SERIF, fontSize:28, fontWeight:400, color:ZEN.text, lineHeight:1.3 }}>{recipe?.name}</h1>
          </div>

          <div>
            <div style={{ fontSize:15, color:ZEN.text, marginBottom:10 }}>How was it?</div>
            <div style={{ display:"flex", gap:8 }}>
              {RATING_OPTIONS.map(o => {
                const on = rating === o.key;
                return (
                  <button key={o.key} onClick={() => setRating(o.key)}
                    style={btn({ flex:1, background:on?o.color:"#fff", border:"1.5px solid "+(on?o.color:ZEN.border), color:on?"#fff":ZEN.text, borderRadius:12, padding:"12px 6px", fontSize:14 })}>
                    <div style={{ fontSize:24, marginBottom:4 }}>{o.icon}</div>
                    {o.label}
                    <div style={{ fontSize:11, marginTop:3, opacity:0.75, fontWeight:400 }}>{o.hint}</div>
                  </button>
                );
              })}
            </div>
            <p style={{ fontSize:12, color:ZEN.faint, marginTop:8, lineHeight:1.5 }}>
              Used to shape future suggestions — loved dishes nudge the style, disliked ones get avoided.
            </p>
          </div>

          {rating && (
            <div style={{ animation:"fadeIn 0.3s ease" }}>
              <label style={{ fontSize:14, color:ZEN.muted, display:"block", marginBottom:6 }}>Anything to remember for next time?</label>
              <input value={note} onChange={e => setNote(e.target.value)} maxLength={200}
                placeholder="too salty, halve the chilli, great for guests…"
                style={{ width:"100%", padding:"12px 14px", border:"1.5px solid "+ZEN.border, borderRadius:10, background:"#fff", color:ZEN.text, fontFamily:SANS, fontSize:15, outline:"none" }} />
            </div>
          )}

          <div style={{ borderTop:"1px solid "+ZEN.border, paddingTop:22, display:"flex", flexDirection:"column", gap:16 }}>
            <button onClick={onToggleSave}
              style={btn({ background:saved?"#8B4A3A":"#fff", border:"1.5px solid "+(saved?"#8B4A3A":ZEN.border), color:saved?"#fff":ZEN.text, borderRadius:12, padding:"13px", fontSize:16 })}>
              {saved ? "♥ Saved to your recipes" : "♡ Save this recipe"}
            </button>

            <div>
              <label style={{ fontSize:14, color:ZEN.muted, display:"block", marginBottom:6 }}>Leftover ingredients to use up?</label>
              <div style={{ display:"flex", gap:8 }}>
                <input value={leftovers} onChange={e => { setLeftovers(e.target.value); setFiled(false); }} maxLength={400}
                  placeholder="half the cabbage, sour cream…"
                  style={{ flex:1, padding:"12px 14px", border:"1.5px solid "+ZEN.border, borderRadius:10, background:"#fff", color:ZEN.text, fontFamily:SANS, fontSize:15, outline:"none" }} />
                <button onClick={fileLeftovers} disabled={!leftovers.trim()}
                  style={btn({ background:leftovers.trim()?"#8B4A3A":ZEN.border, color:leftovers.trim()?"#fff":ZEN.muted, borderRadius:10, padding:"12px 18px", fontSize:15, cursor:leftovers.trim()?"pointer":"default" })}>Add</button>
              </div>
              {filed && <p style={{ fontSize:13, color:"#3D6E52", marginTop:8 }}>✓ Added to “use up soon”</p>}
            </div>
          </div>
        </div>
      </div>

      <div style={{ position:"fixed", bottom:0, left:0, right:0, padding:"16px 24px 32px", background:"linear-gradient(to top, "+ZEN.bg+" 70%, transparent)", display:"flex", justifyContent:"center", zIndex:50 }}>
        <button onClick={() => onFinish(rating, note)}
          style={btn({ background:ZEN.text, color:"#fff", borderRadius:14, padding:"17px", fontSize:18, width:"100%", maxWidth:440, boxShadow:"0 4px 20px rgba(44,40,37,0.18)" })}>
          {rating ? "Save & finish →" : "Finish →"}
        </button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   APP HEADER
══════════════════════════════════════════════════════════ */
/* Slim persistent bar. Pantry and favourites open as overlays rather than
   screens so opening one never loses the recipe you're cooking. Deliberately
   not shown on the welcome or spin screens — those are focused sequences. */
function AppHeader({ onHome, onPantry, pantryCount, onGrocery, groceryCount, onFavorites, favoriteCount, onIngredients }) {
  const icon = extra => btn({ background:"none", color:ZEN.muted, borderRadius:8, padding:"7px 10px", fontSize:14, fontWeight:400, whiteSpace:"nowrap", ...extra });
  return (
    <div style={{ position:"sticky", top:0, zIndex:40, background:ZEN.bg, borderBottom:"1px solid "+ZEN.border,
                  display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, padding:"10px 14px" }}>
      <button onClick={onHome} title="Start over"
        style={btn({ display:"flex", alignItems:"center", gap:7, background:"none", fontFamily:SERIF, fontSize:16, color:ZEN.text, whiteSpace:"nowrap", padding:"4px 2px" })}>
        <span style={{ fontSize:18 }}>🍽️</span> Dinner Spinner
      </button>
      <div style={{ display:"flex", alignItems:"center", gap:2 }}>
        {onIngredients && <button onClick={onIngredients} style={icon()}>✎ Ingredients</button>}
        <button onClick={onPantry} style={icon()}>🥫{pantryCount ? " " + pantryCount : ""}</button>
        <button onClick={onGrocery} title="Grocery list" style={icon()}>🛒{groceryCount ? " " + groceryCount : ""}</button>
        <button onClick={onFavorites} style={icon()}>♥{favoriteCount ? " " + favoriteCount : ""}</button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   FAVOURITES MODAL
══════════════════════════════════════════════════════════ */
function FavoritesModal({ favorites, onClose, onOpen, onRemove }) {
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(44,40,37,0.6)", display:"flex", alignItems:"flex-end", justifyContent:"center", zIndex:300 }}>
      <div onClick={e => e.stopPropagation()} style={{ background:ZEN.bg, borderRadius:"24px 24px 0 0", padding:"26px 24px 40px", width:"100%", maxWidth:520, maxHeight:"88vh", display:"flex", flexDirection:"column", gap:16, animation:"slideUp 0.3s ease" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:24 }}>♥</span>
            <span style={{ fontFamily:SERIF, fontSize:22, color:ZEN.text }}>Saved recipes</span>
          </div>
          <button onClick={onClose} style={{ background:"none", border:"none", fontSize:22, color:ZEN.muted, cursor:"pointer" }}>✕</button>
        </div>

        <div style={{ flex:1, overflowY:"auto", minHeight:100 }}>
          {favorites.length === 0 ? (
            <p style={{ fontSize:15, color:ZEN.faint, fontFamily:SANS, fontStyle:"italic", textAlign:"center", padding:"36px 16px", lineHeight:1.6 }}>
              Nothing saved yet. Tap ♡ Save on any recipe you want to keep.
            </p>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              {favorites.map((f, i) => (
                <div key={(f.recipe?.name || "") + i} style={{ background:"#fff", border:"1.5px solid "+ZEN.border, borderLeft:"5px solid #8B4A3A", borderRadius:14, padding:"16px 18px" }}>
                  <div style={{ fontSize:19, fontFamily:SERIF, color:ZEN.text, lineHeight:1.3, marginBottom:6 }}>{f.recipe?.name}</div>
                  <div style={{ fontSize:14, color:ZEN.muted, fontFamily:SANS, lineHeight:1.6, marginBottom:12 }}>{f.recipe?.description}</div>
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                    <button onClick={() => onOpen(f)} style={btn({ background:"#8B4A3A", color:"#fff", borderRadius:10, padding:"9px 16px", fontSize:14 })}>Cook this →</button>
                    <button onClick={() => onRemove(f.recipe)} style={btn({ background:"none", color:ZEN.muted, border:"1.5px solid "+ZEN.border, borderRadius:10, padding:"9px 14px", fontSize:14, fontWeight:400 })}>Remove</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   PANTRY MODAL
══════════════════════════════════════════════════════════ */
const PANTRY_TABS = [
  { kind: KINDS.STAPLE, listKey: "staples", label: "Staples", emoji: "🧂", color: "#7A5C2E",
    blurb: "Always in your kitchen. Recipes use these freely and leave them off the shopping list.",
    placeholder: "soy sauce, olive oil, cumin…" },
  { kind: KINDS.USE_SOON, listKey: "useSoon", label: "Use up soon", emoji: "⏳", color: "#8B4A3A",
    blurb: "Recipes will try to work these in where they fit.",
    placeholder: "half tin coconut milk, cilantro…" },
];

function PantryModal({ pantry, setPantry, onClose }) {
  const [tab, setTab] = useState(KINDS.STAPLE);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null); // { added, duplicates, similar }
  const active = PANTRY_TABS.find(t => t.kind === tab);
  const items = pantry[active.listKey] || [];
  const stale = staleItems(pantry);

  async function handleAdd(e, { force = false } = {}) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const res = await addItems(tab, text, { force });
      setPantry(res.pantry);
      // Keep any typo-suspects in the box so they can be corrected in place;
      // clear everything else since it landed.
      setDraft(res.similar.length && !force ? res.similar.map(s => s.name).join(", ") : "");
      setNotice(res.added.length || res.duplicates.length || res.similar.length ? res : null);
    } finally { setBusy(false); }
  }

  async function handleRemove(name) {
    setNotice(null);
    setPantry(await removeItems(tab, name));
  }

  async function clearStale() {
    setNotice(null);
    setPantry(await removeItems(KINDS.USE_SOON, stale.map(i => i.name)));
  }

  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(44,40,37,0.6)", display:"flex", alignItems:"flex-end", justifyContent:"center", zIndex:300 }}>
      <div onClick={e => e.stopPropagation()} style={{ background:ZEN.bg, borderRadius:"24px 24px 0 0", padding:"26px 24px 40px", width:"100%", maxWidth:520, maxHeight:"88vh", display:"flex", flexDirection:"column", gap:16, animation:"slideUp 0.3s ease" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:26 }}>🥫</span>
            <span style={{ fontFamily:SERIF, fontSize:22, color:ZEN.text }}>My pantry</span>
          </div>
          <button onClick={onClose} style={{ background:"none", border:"none", fontSize:22, color:ZEN.muted, cursor:"pointer" }}>✕</button>
        </div>

        <div style={{ display:"flex", gap:8 }}>
          {PANTRY_TABS.map(t => {
            const on = tab === t.kind;
            const count = (pantry[t.listKey] || []).length;
            return (
              <button key={t.kind} onClick={() => setTab(t.kind)} style={btn({ flex:1, padding:"10px", borderRadius:10, background:on?t.color:ZEN.surface, color:on?"#fff":ZEN.muted, fontSize:15 })}>
                {t.emoji} {t.label}{count ? " (" + count + ")" : ""}
              </button>
            );
          })}
        </div>

        <p style={{ fontSize:14, color:ZEN.muted, fontFamily:SANS, lineHeight:1.5, margin:0 }}>{active.blurb}</p>

        <form onSubmit={handleAdd} style={{ display:"flex", gap:8 }}>
          <input value={draft} onChange={e => { setDraft(e.target.value); setNotice(null); }} placeholder={active.placeholder} maxLength={400}
            style={{ flex:1, padding:"12px 14px", border:"1.5px solid "+ZEN.border, borderRadius:10, background:"#fff", color:ZEN.text, fontFamily:SANS, fontSize:16, outline:"none" }} />
          <button type="submit" disabled={!draft.trim() || busy}
            style={btn({ background:draft.trim()?active.color:ZEN.border, color:draft.trim()?"#fff":ZEN.muted, borderRadius:10, padding:"12px 20px", fontSize:16, cursor:draft.trim()?"pointer":"default" })}>Add</button>
        </form>
        <p style={{ fontSize:12, color:ZEN.faint, fontFamily:SANS, margin:"-8px 0 0" }}>Separate several with commas.</p>

        {notice && (
          <div style={{ display:"flex", flexDirection:"column", gap:6, fontFamily:SANS, fontSize:13 }}>
            {notice.added.length > 0 && <span style={{ color:"#3D6E52" }}>✓ Added {notice.added.join(", ")}</span>}
            {notice.duplicates.length > 0 && <span style={{ color:ZEN.muted }}>Already in your pantry: {notice.duplicates.join(", ")}</span>}
            {notice.similar.map(s => (
              <span key={s.name} style={{ color:"#8B4A3A", display:"flex", flexWrap:"wrap", alignItems:"center", gap:6 }}>
                “{s.name}” looks like a typo of “{s.to}”.
                <button onClick={e => handleAdd(e, { force: true })}
                  style={btn({ background:"none", color:"#8B4A3A", fontSize:13, padding:0, textDecoration:"underline" })}>Add it anyway</button>
              </span>
            ))}
          </div>
        )}

        {tab === KINDS.USE_SOON && stale.length > 0 && (
          <div style={{ background:"#F5EDE8", border:"1.5px solid #8B4A3A33", borderRadius:12, padding:"12px 14px", display:"flex", flexDirection:"column", gap:8 }}>
            <span style={{ fontFamily:SANS, fontSize:13, color:ZEN.text, lineHeight:1.5 }}>
              {stale.length} item{stale.length === 1 ? "" : "s"} {stale.length === 1 ? "has" : "have"} been here over {STALE_DAYS} days. Still have {stale.length === 1 ? "it" : "them"}?
            </span>
            <button onClick={clearStale} style={btn({ background:"#8B4A3A", color:"#fff", borderRadius:8, padding:"8px 14px", fontSize:13, alignSelf:"flex-start" })}>
              Clear {stale.length === 1 ? "it" : "them"}
            </button>
          </div>
        )}

        <div style={{ flex:1, overflowY:"auto", minHeight:80 }}>
          {items.length === 0 ? (
            <p style={{ fontSize:15, color:ZEN.faint, fontFamily:SANS, textAlign:"center", padding:"24px 0", fontStyle:"italic" }}>Nothing here yet.</p>
          ) : (
            <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
              {items.map(item => {
                const age = tab === KINDS.USE_SOON ? daysSince(item.addedAt) : null;
                const old = age !== null && age >= STALE_DAYS;
                return (
                  <span key={item.name} style={{ display:"inline-flex", alignItems:"center", gap:6, background:"#fff", border:"1.5px solid "+(old?"#8B4A3A55":ZEN.border), borderRadius:20, padding:"7px 8px 7px 14px", fontFamily:SANS, fontSize:15, color:ZEN.text }}>
                    {item.name}
                    {age !== null && <span style={{ fontSize:12, color:old?"#8B4A3A":ZEN.faint }}>{age === 0 ? "today" : age + "d"}</span>}
                    <button onClick={() => handleRemove(item.name)} aria-label={"Remove " + item.name}
                      style={{ background:"none", border:"none", color:ZEN.faint, fontSize:16, cursor:"pointer", lineHeight:1, padding:"0 4px" }}>✕</button>
                  </span>
                );
              })}
            </div>
          )}
        </div>

        <p style={{ fontSize:12, color:ZEN.faint, fontFamily:SANS, textAlign:"center", margin:0 }}>
          {syncEnabled ? "☁️ Synced across your devices" : "💾 Saved on this device only"}
        </p>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   ROOT
══════════════════════════════════════════════════════════ */
export default function App() {
  const [screen, setScreen] = useState("welcome");
  const [stepIdx, setStepIdx] = useState(0);
  const [results, setResults] = useState({});
  const [recipes, setRecipes] = useState(null);
  const [lastServings, setLastServings] = useState(2);
  const [error, setError] = useState(null);
  const [activeRecipe, setActiveRecipe] = useState(null);
  const [pantry, setPantry] = useState(EMPTY_PANTRY);
  const [history, setHistory] = useState(() => loadHistory());
  const [showPantry, setShowPantry] = useState(false);
  const [showGrocery, setShowGrocery] = useState(false);
  const [showFavorites, setShowFavorites] = useState(false);
  const [confirmHome, setConfirmHome] = useState(false);
  const [favorites, setFavorites] = useState([]);
  // Held here rather than in SummaryScreen so leaving and returning keeps them.
  const [prefs, setPrefs] = useState(() => {
    const saved = readPrefs();
    return {
      toppings: "",
      diff: DIFF.some(d => d.key === saved.diff) ? saved.diff : "medium",
      servings: Number(saved.servings) >= 1 && Number(saved.servings) <= 8 ? Number(saved.servings) : 2,
    };
  });
  const latestResultsRef = useRef({});

  // Load once on startup. Neither loader rejects — both fall back to the local
  // copy if Supabase is unreachable — so no error branch is needed here.
  useEffect(() => {
    loadPantry().then(setPantry);
    loadFavorites().then(setFavorites);
  }, []);

  // Shared by the pantry modal and the shopping list's "add to pantry" action.
  async function handleAddToPantry(kind, names) {
    const res = await addItems(kind, names);
    setPantry(res.pantry);
    return res;
  }

  // Ends the cooking session: store the verdict, then reset to the welcome screen.
  function finishCooking(rating, note) {
    if (rating) setHistory(recordCook({ recipe: activeRecipe, rating, note, results }));
    restart();
  }

  async function toggleSaveRecipe() {
    if (!activeRecipe) return;
    setFavorites(isFavorite(favorites, activeRecipe)
      ? await removeFavorite(activeRecipe)
      : await saveFavorite(activeRecipe, lastServings));
  }

  function handleStepDone(value) {
    const key = STEPS[stepIdx].key;
    const next = { ...results, [key]: value };
    setResults(next);
    latestResultsRef.current = next;
    if (stepIdx < STEPS.length - 1) {
      setStepIdx(i => i + 1);
    } else {
      setScreen("summary");
    }
  }

  async function handleGenerate({ toppings, diff, servings = 2 }, currentResults) {
    const res = currentResults || latestResultsRef.current || results;
    setError(null);
    setLastServings(servings);
    setScreen("loading");
    try {
      const diffLabel = DIFF.find(d => d.key === diff)?.label || "Medium";
      const parsed = await fetchRecipes({
        results: res, toppings, diffLabel, servings,
        pantry: pantryNames(pantry),
        feedback: feedbackHints(history),
      });
      setRecipes(parsed);
      setScreen("recipes");
    } catch (e) {
      setError(e.message || "Something went wrong — please try again.");
      setScreen("summary");
    }
  }

  function restart() {
    setScreen("welcome");
    setStepIdx(0);
    setResults({});
    setRecipes(null);
    setError(null);
    setActiveRecipe(null);
    setConfirmHome(false);
    setPrefs(p => ({ ...p, toppings: "" }));
    latestResultsRef.current = {};
  }

  /* Going home throws away the current spin, so ask first — unless there's
     genuinely nothing to lose, where a prompt would just be noise. */
  const hasSession = STEPS.some(s => results[s.key]) || Boolean(activeRecipe) || Boolean(recipes);
  function requestHome() {
    if (hasSession) setConfirmHome(true);
    else restart();
  }

  function handleQuickPick() {
    const q = {};
    STEPS.forEach(s => { q[s.key] = pick(s.items); });
    setResults(q);
    latestResultsRef.current = q;
    setScreen("summary");
  }

  const pantryCount = pantry.staples.length + pantry.useSoon.length;
  const groceryCount = (pantry.shopping || []).length;

  // Only offer "Ingredients" once a spin has actually produced some.
  const hasIngredients = STEPS.every(s => results[s.key]);
  const header = (
    <AppHeader
      onHome={requestHome}
      onPantry={() => setShowPantry(true)} pantryCount={pantryCount}
      onGrocery={() => setShowGrocery(true)} groceryCount={groceryCount}
      onFavorites={() => setShowFavorites(true)} favoriteCount={favorites.length}
      onIngredients={hasIngredients && screen !== "summary" ? () => setScreen("summary") : null}
    />
  );

  let view = null;
  if (screen === "welcome") view = <WelcomeScreen onStart={() => setScreen("spin")} onQuickPick={handleQuickPick} onPantry={() => setShowPantry(true)} pantryCount={pantryCount} onGrocery={() => setShowGrocery(true)} groceryCount={groceryCount} onFavorites={() => setShowFavorites(true)} favoriteCount={favorites.length} />;
  else if (screen === "spin") view = <SpinScreen key={stepIdx} step={STEPS[stepIdx]} stepIdx={stepIdx} total={STEPS.length} onDone={handleStepDone} />;
  else if (screen === "loading") view = <LoadingScreen results={results} error={error} />;
  else if (screen === "summary") view = (
    <>
      <SummaryScreen results={results} setResults={setResults} onGenerate={handleGenerate} onPantry={() => setShowPantry(true)} pantryCount={pantryCount} prefs={prefs} setPrefs={setPrefs} header={header} />
      {/* Sits above the fixed "Get recipes" bar (zIndex 50) — otherwise the error is hidden behind it. */}
      {error && <div style={{ position:"fixed", bottom:110, left:"50%", transform:"translateX(-50%)", zIndex:60, maxWidth:"90vw", textAlign:"center", background:"#8B4A3A", color:"#fff", padding:"10px 20px", borderRadius:8, fontSize:15, fontFamily:SANS, boxShadow:"0 4px 16px rgba(44,40,37,0.25)" }}>{error}</div>}
    </>
  );
  else if (screen === "recipes") view = <RecipesScreen recipes={recipes} onBack={() => setScreen("summary")} onRestart={requestHome} onSelect={r => { setActiveRecipe(r); setScreen("shopping"); }} header={header} />;
  else if (screen === "shopping") view = (
    <ShoppingListScreen recipe={activeRecipe} onBack={() => setScreen(recipes ? "recipes" : "welcome")} onCook={() => setScreen("steps")}
      servings={lastServings} onAddToPantry={handleAddToPantry} header={header}
      pantry={pantry} setPantry={setPantry} />
  );
  else if (screen === "steps") view = <RecipeStepsScreen recipe={activeRecipe} onBack={() => setScreen("shopping")} servings={lastServings} saved={isFavorite(favorites, activeRecipe)} onToggleSave={toggleSaveRecipe} header={header} onDone={() => setScreen("done")} />;
  else if (screen === "done") view = (
    <DoneScreen recipe={activeRecipe} saved={isFavorite(favorites, activeRecipe)} onToggleSave={toggleSaveRecipe}
      onFinish={finishCooking} onLeftovers={text => handleAddToPantry(KINDS.USE_SOON, text)} header={header} />
  );

  return (
    <>
      <GlobalStyle />
      {view}
      {confirmHome && (
        <ConfirmModal
          title="Start over?"
          body={activeRecipe && !isFavorite(favorites, activeRecipe)
            ? "This clears tonight's ingredients and recipe. “" + activeRecipe.name + "” isn't saved — tap Stay here and hit ♥ Save first if you want to keep it."
            : "This clears tonight's ingredients and recipes and takes you back to the start. Your pantry and saved recipes are kept."}
          confirmLabel="Start over"
          onConfirm={restart}
          onClose={() => setConfirmHome(false)} />
      )}
      {showPantry && <PantryModal pantry={pantry} setPantry={setPantry} onClose={() => setShowPantry(false)} />}
      {showGrocery && <GroceryModal pantry={pantry} setPantry={setPantry} onClose={() => setShowGrocery(false)} />}
      {showFavorites && (
        <FavoritesModal favorites={favorites} onClose={() => setShowFavorites(false)}
          onRemove={async r => setFavorites(await removeFavorite(r))}
          onOpen={f => { setActiveRecipe(f.recipe); setLastServings(f.servings || 2); setShowFavorites(false); setScreen("shopping"); }} />
      )}
    </>
  );
}
