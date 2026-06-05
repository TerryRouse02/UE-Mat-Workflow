/* ===================== Node canvas (hero) ===================== */
const HEAD = 27, ROW = 18, BODYTOP = 6, PINY = 9;

function nodeMap() { const m = {}; NODES.forEach(n => m[n.id] = n); return m; }
const NMAP = nodeMap();

function pinIndex(node, pinId, side) {
  if (side === "out") {
    const oi = (node.outs || []).findIndex(p => p.id === pinId);
    return (node.ins ? node.ins.length : 0) + (oi < 0 ? 0 : oi);
  }
  const ii = (node.ins || []).findIndex(p => p.id === pinId);
  return ii < 0 ? 0 : ii;
}
function pinPos(node, pinId, side) {
  const idx = pinIndex(node, pinId, side);
  const y = node.y + HEAD + BODYTOP + idx * ROW + PINY;
  const x = side === "out" ? node.x + node.w : node.x;
  return { x, y };
}
function pinType(node, pinId, side) {
  const arr = side === "out" ? node.outs : node.ins;
  const p = (arr || []).find(p => p.id === pinId);
  return p ? p.type : "exec";
}

function Edges({ selId, hoverId }) {
  const active = selId || hoverId;
  return (
    <svg className="edges" width="3000" height="2000">
      {EDGES.map((e, i) => {
        const a = NMAP[e.from], b = NMAP[e.to];
        if (!a || !b) return null;
        const s = pinPos(a, e.fromPin, "out"), t = pinPos(b, e.toPin, "in");
        const dx = Math.max(45, Math.abs(t.x - s.x) * 0.5);
        const d = `M${s.x},${s.y} C${s.x + dx},${s.y} ${t.x - dx},${t.y} ${t.x},${t.y}`;
        const col = PIN_TYPES[pinType(a, e.fromPin, "out")].color;
        const touch = (id) => id && (e.from === id || e.to === id);
        const hot = touch(hoverId) || (selId && touch(selId));
        const state = hot ? " hot" : (active ? " dim" : "");
        return (
          <g key={i}>
            <path className={"edge" + state} d={d} stroke={col} />
            <path className={"edge-flow" + state} d={d} stroke={col} style={{ animationDelay: (-i * 0.13) + "s" }} />
          </g>
        );
      })}
    </svg>
  );
}

function NodeView({ node, idx, entering, sel, flash, onSelect, onHover }) {
  const cat = CATEGORIES[node.cat];
  const dotColor = node.status === "error" ? "var(--error)" : node.status === "warn" ? "var(--warn)" : cat.color;
  return (
    <div className={"node" + (entering ? " entering" : "") + (sel ? " sel" : "") + (flash ? " flash" : "")}
      style={{ left: node.x, top: node.y, width: node.w, "--cat": dotColor, transitionDelay: entering ? Math.min((idx || 0) * 16, 460) + "ms" : "0ms" }}
      onMouseDown={(e) => { e.stopPropagation(); onSelect(node.id); }}
      onMouseEnter={() => onHover(node.id)} onMouseLeave={() => onHover(null)}>
      <div className="nhead">
        <span className="ndot" />
        <span className="ntitle">{node.title}</span>
        {node.drillable && <Icon name="layers" size={11} style={{ opacity: .55, color: "var(--text-mute)" }} />}
      </div>
      <div className="nbody">
        {(node.ins || []).map(p => (
          <div className="prow inp" key={"i" + p.id}>
            <span className={"pin " + (p.type === "matattr" ? "tri" : "dot")} style={{ "--pc": PIN_TYPES[p.type].color, background: p.type === "matattr" ? undefined : PIN_TYPES[p.type].color }} />
            <span className="plabel">{p.label}</span>
          </div>
        ))}
        {(node.outs || []).map(p => (
          <div className="prow outp" key={"o" + p.id}>
            <span className="plabel">{p.label || PIN_TYPES[p.type].label}</span>
            <span className={"pin " + (p.type === "matattr" ? "tri" : "dot")} style={{ "--pc": PIN_TYPES[p.type].color, background: p.type === "matattr" ? undefined : PIN_TYPES[p.type].color }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function CommentBoxes() {
  return COMMENTS.map(c => (
    <div key={c.id} className="cbox" style={{ left: c.x, top: c.y, width: c.w, height: c.h, borderColor: c.color, background: c.color + "0e" }}>
      <span className="cbtitle" style={{ background: c.color }}>{c.label}</span>
    </div>
  ));
}

function Minimap({ tx, ty, scale, vw, vh }) {
  const xs = NODES.map(n => n.x), ys = NODES.map(n => n.y);
  const minX = Math.min(...xs) - 40, minY = Math.min(...ys) - 60;
  const maxX = Math.max(...NODES.map(n => n.x + n.w)) + 40, maxY = Math.max(...NODES.map(n => n.y + 120)) + 40;
  const gw = maxX - minX, gh = maxY - minY;
  const MW = 186, MH = 118;
  const k = Math.min(MW / gw, MH / gh);
  const ox = (MW - gw * k) / 2, oy = (MH - gh * k) / 2 + 8;
  // viewport rect in graph space
  const vx0 = -tx / scale, vy0 = -ty / scale;
  return (
    <div className="minimap">
      <div className="mm-head">Minimap</div>
      {NODES.map(n => {
        const c = n.status === "error" ? "var(--error)" : n.status === "warn" ? "var(--warn)" : "var(--text-mute)";
        const op = n.status ? .95 : .5;
        return <div key={n.id} className="mm-node" style={{ left: ox + (n.x - minX) * k, top: oy + (n.y - minY) * k, width: Math.max(3, n.w * k), height: Math.max(3, 60 * k), background: c, opacity: op }} />;
      })}
      <div className="mm-view" style={{ left: ox + (vx0 - minX) * k, top: oy + (vy0 - minY) * k, width: (vw / scale) * k, height: (vh / scale) * k }} />
    </div>
  );
}

const LEGEND = ["scalar", "vec2", "vec3", "color", "tex", "matattr"];

function Canvas({ selId, onSelect, flashId, mode, fileError }) {
  const [t, setT] = React.useState({ tx: 60, ty: 30, scale: 0.82 });
  const [panning, setPanning] = React.useState(false);
  const [hoverId, setHover] = React.useState(null);
  const wrapRef = React.useRef(null);
  const drag = React.useRef(null);
  const [dims, setDims] = React.useState({ w: 900, h: 600 });
  const [entering, setEntering] = React.useState(true);

  // play node-assemble once on mount (default state is visible → safe if paused)
  React.useEffect(() => {
    let r2;
    const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setEntering(false)); });
    const to = setTimeout(() => setEntering(false), 300); // fallback if rAF is throttled
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); clearTimeout(to); };
  }, []);

  React.useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); return () => ro.disconnect();
  }, []);

  // focus a node when flashId changes
  React.useEffect(() => {
    if (!flashId) return;
    const n = NMAP[flashId]; if (!n) return;
    setT(prev => ({ ...prev, tx: dims.w / 2 - (n.x + n.w / 2) * prev.scale, ty: dims.h / 2 - (n.y + 40) * prev.scale }));
  }, [flashId]); // eslint-disable-line

  const onWheel = (e) => {
    e.preventDefault();
    const rect = wrapRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    setT(prev => {
      const ns = Math.min(1.8, Math.max(0.25, prev.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
      const k = ns / prev.scale;
      return { scale: ns, tx: mx - (mx - prev.tx) * k, ty: my - (my - prev.ty) * k };
    });
  };
  const onDown = (e) => { if (e.button !== 0 && e.button !== 1) return; setPanning(true); drag.current = { x: e.clientX, y: e.clientY, tx: t.tx, ty: t.ty }; };
  const onMove = (e) => { if (!drag.current) return; setT(p => ({ ...p, tx: drag.current.tx + (e.clientX - drag.current.x), ty: drag.current.ty + (e.clientY - drag.current.y) })); };
  const onUp = () => { setPanning(false); drag.current = null; };
  const zoom = (f) => setT(p => { const ns = Math.min(1.8, Math.max(0.25, p.scale * f)); const k = ns / p.scale; return { scale: ns, tx: dims.w / 2 - (dims.w / 2 - p.tx) * k, ty: dims.h / 2 - (dims.h / 2 - p.ty) * k }; });
  const fit = () => setT({ tx: 60, ty: 30, scale: 0.82 });

  if (fileError) return <CanvasError />;

  return (
    <div className="canvas-wrap" ref={wrapRef} onWheel={onWheel}>
      <div className="grid-bg" style={{ backgroundSize: `${26 * t.scale}px ${26 * t.scale}px`, backgroundPosition: `${t.tx}px ${t.ty}px` }} />
      <div className={"viewport" + (panning ? " panning" : "")} onMouseDown={(e) => { onDown(e); onSelect(null); }} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}>
        <div className="scene" style={{ transform: `translate(${t.tx}px,${t.ty}px) scale(${t.scale})` }}>
          <CommentBoxes />
          <Edges selId={selId} hoverId={hoverId} />
          {NODES.map((n, i) => <NodeView key={n.id} node={n} idx={i} entering={entering} sel={selId === n.id} flash={flashId === n.id} onSelect={onSelect} onHover={setHover} />)}
        </div>
      </div>

      <div className="zoom-ind">{Math.round(t.scale * 100)}%</div>
      <div className="legend">
        {LEGEND.map(k => <span className="lg" key={k}><i style={{ background: PIN_TYPES[k].color }} />{PIN_TYPES[k].label}</span>)}
      </div>
      <div className="canvas-ctl">
        <button onClick={() => zoom(1.2)} title="Zoom in"><Icon name="plus" size={15} /></button>
        <button onClick={() => zoom(0.83)} title="Zoom out"><Icon name="minus" size={15} /></button>
        <button onClick={fit} title="Fit"><Icon name="zoomfit" size={15} /></button>
      </div>
      <Minimap tx={t.tx} ty={t.ty} scale={t.scale} vw={dims.w} vh={dims.h} />
    </div>
  );
}

function CanvasError() {
  return (
    <div className="canvas-wrap">
      <div className="grid-bg" />
      <div className="canvas-msg">
        <div className="card">
          <div className="big-ico" style={{ background: "rgba(224,89,78,.14)", color: "var(--error)" }}><Icon name="warn" size={26} /></div>
          <h2>Couldn’t parse this graph</h2>
          <p><b style={{ color: "var(--text)" }}>M_Terrain_Blend.json</b> failed schema validation at node <span style={{ fontFamily: "var(--font-mono)", color: "var(--error)" }}>#412</span>.</p>
          <div className="codeblock" style={{ textAlign: "left", color: "var(--error)", marginTop: 14 }}>SchemaError: node[412].outputs[0].type{"\n"}  expected one of (float, float2, float3,{"\n"}  float4, Texture, MaterialAttributes){"\n"}  got "vec4f"  ← unknown pin type</div>
          <div className="actions" style={{ marginTop: 18 }}>
            <button className="btn">View raw JSON</button>
            <button className="btn primary">Re-import from clipboard</button>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Canvas, NMAP, CATEGORIES, PIN_TYPES });
