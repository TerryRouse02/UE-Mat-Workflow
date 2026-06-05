/* ============================================================================
   UE Material Workflow — mock data
   Pin types, node categories, the hero graph (~40 nodes), comment boxes,
   issues, files tree, functions, crawl datasets, env checks, log stream.
   ========================================================================== */

// ---- Pin types (color by data type, UE-flavored) -------------------------
const PIN_TYPES = {
  scalar: { label: "float",   color: "#9bd64e" },
  vec2:   { label: "float2",  color: "#4ec4d6" },
  vec3:   { label: "float3",  color: "#d6c64e" },
  color:  { label: "float4",  color: "#e0b84e" },
  bool:   { label: "bool",    color: "#d64e6b" },
  tex:    { label: "Texture", color: "#c06ed6" },
  matattr:{ label: "MatAttr", color: "#4e7bd6" },
  exec:   { label: "—",       color: "#8a93a3" },
};

// ---- Node categories (header accent) -------------------------------------
const CATEGORIES = {
  texture:  { label: "Texture",       color: "#b85fd0" },
  param:    { label: "Parameter",     color: "#4ea0d6" },
  math:     { label: "Math",          color: "#697384" },
  coord:    { label: "Coordinates",   color: "#d6a44e" },
  func:     { label: "Material Func",  color: "#5fc46e" },
  vector:   { label: "Vector Op",     color: "#8a7de0" },
  utility:  { label: "Utility",       color: "#5a93a0" },
  output:   { label: "Output",        color: "#d65e5e" },
};

// column-based layout helper
const CX = (col) => 90 + col * 250;
const CY = (row) => 70 + row * 116;

/* Each node:
   id, cat, title, sub(optional), col,row (or x,y), w(optional),
   ins:[{id,label,type}], outs:[{id,label,type}],
   params:[{k,v,code?}], meta:{...crawl metadata}, status?('warn'|'error'|'big')
*/
const NODES = [
  // --- column 0: inputs -------------------------------------------------
  { id: "texcoord", cat: "coord", title: "TexCoord[0]", col: 0, row: 0,
    outs: [{ id: "uv", label: "UV", type: "vec2" }],
    params: [{ k: "UTiling", v: "1.0" }, { k: "VTiling", v: "1.0" }],
    meta: m("Engine Node Export", "2026-05-20T11:02:00", "fresh", 1) },

  { id: "panner", cat: "coord", title: "Panner", col: 0, row: 1,
    ins: [{ id: "coord", label: "Coordinate", type: "vec2" }, { id: "time", label: "Time", type: "scalar" }, { id: "speed", label: "Speed", type: "vec2" }],
    outs: [{ id: "uv", label: "", type: "vec2" }],
    params: [{ k: "SpeedX", v: "0.02" }, { k: "SpeedY", v: "0.00" }],
    meta: m("Engine Node Export", "2026-05-20T11:02:00", "fresh", 3) },

  { id: "time", cat: "utility", title: "Time", col: 0, row: 2,
    outs: [{ id: "t", label: "", type: "scalar" }],
    params: [{ k: "Period", v: "0.0" }],
    meta: m("Engine Node Export", "2026-05-20T11:02:00", "fresh", 1) },

  { id: "p_basecolor", cat: "param", title: "BaseColor Tint", sub: "VectorParameter", col: 0, row: 3,
    outs: [{ id: "rgb", label: "RGB", type: "color" }, { id: "r", label: "R", type: "scalar" }],
    params: [{ k: "Default", v: "0.82, 0.74, 0.65, 1.0" }, { k: "Group", v: "Albedo" }],
    meta: m("Project Materials", "2026-06-04T09:10:00", "fresh", 1) },

  { id: "p_rough", cat: "param", title: "Roughness", sub: "ScalarParameter", col: 0, row: 4,
    outs: [{ id: "s", label: "", type: "scalar" }],
    params: [{ k: "Default", v: "0.55" }, { k: "Slider", v: "0.0 – 1.0" }, { k: "Group", v: "Surface" }],
    meta: m("Project Materials", "2026-06-04T09:10:00", "fresh", 1) },

  { id: "p_normint", cat: "param", title: "Normal Intensity", sub: "ScalarParameter", col: 0, row: 5,
    outs: [{ id: "s", label: "", type: "scalar" }],
    params: [{ k: "Default", v: "1.0" }, { k: "Group", v: "Surface" }],
    meta: m("Project Materials", "2026-06-04T09:10:00", "stale", 1) },

  // --- column 1: textures ----------------------------------------------
  { id: "t_albedo", cat: "texture", title: "T_Rock_Albedo", sub: "TextureSampleParameter2D", col: 1, row: 0.4,
    ins: [{ id: "uv", label: "UVs", type: "vec2" }],
    outs: [{ id: "rgb", label: "RGB", type: "color" }, { id: "r", label: "R", type: "scalar" }, { id: "g", label: "G", type: "scalar" }, { id: "b", label: "B", type: "scalar" }, { id: "a", label: "A", type: "scalar" }],
    params: [{ k: "Sampler", v: "Color" }, { k: "Resolution", v: "2048 × 2048" }, { k: "Compression", v: "BC7" }],
    meta: m("Project Materials", "2026-06-04T09:10:00", "fresh", 4) },

  { id: "t_normal", cat: "texture", title: "T_Rock_Normal", sub: "TextureSampleParameter2D", col: 1, row: 1.7,
    ins: [{ id: "uv", label: "UVs", type: "vec2" }],
    outs: [{ id: "rgb", label: "RGB", type: "vec3" }, { id: "a", label: "A", type: "scalar" }],
    params: [{ k: "Sampler", v: "Normal" }, { k: "Resolution", v: "2048 × 2048" }, { k: "Compression", v: "BC5" }],
    meta: m("Project Materials", "2026-06-04T09:10:00", "fresh", 4) },

  { id: "t_orm", cat: "texture", title: "T_Rock_ORM", sub: "TextureSampleParameter2D", col: 1, row: 3.0,
    ins: [{ id: "uv", label: "UVs", type: "vec2" }],
    outs: [{ id: "rgb", label: "RGB", type: "vec3" }, { id: "r", label: "AO", type: "scalar" }, { id: "g", label: "Rough", type: "scalar" }, { id: "b", label: "Metal", type: "scalar" }],
    params: [{ k: "Sampler", v: "Linear Color" }, { k: "Resolution", v: "2048 × 2048" }, { k: "Compression", v: "BC7" }],
    meta: m("Project Materials", "2026-06-04T09:10:00", "fresh", 4) },

  { id: "t_detail", cat: "texture", title: "T_Detail_Noise", sub: "TextureSample2D", col: 1, row: 4.3, status: "warn",
    ins: [{ id: "uv", label: "UVs", type: "vec2" }],
    outs: [{ id: "rgb", label: "RGB", type: "color" }, { id: "r", label: "R", type: "scalar" }],
    params: [{ k: "Sampler", v: "Color" }, { k: "Resolution", v: "512 × 512" }],
    meta: m("Project Materials", "2026-05-29T16:40:00", "stale", 4) },

  // --- column 2: functions / mixing ------------------------------------
  { id: "mf_detail", cat: "func", title: "MF_DetailBlend", sub: "MaterialFunctionCall", col: 2, row: 0.9, drillable: true,
    ins: [{ id: "base", label: "Base", type: "color" }, { id: "detail", label: "Detail", type: "color" }, { id: "mask", label: "Mask", type: "scalar" }],
    outs: [{ id: "out", label: "Result", type: "color" }],
    params: [{ k: "Function", v: "MF_DetailBlend", code: "/Game/Materials/Functions/MF_DetailBlend" }, { k: "Inputs", v: "3" }],
    meta: m("Project Material Functions", "2026-06-03T14:22:00", "fresh", 9) },

  { id: "mul_norm", cat: "vector", title: "Multiply", sub: "Normal × Intensity", col: 2, row: 2.3,
    ins: [{ id: "a", label: "A", type: "vec3" }, { id: "b", label: "B", type: "scalar" }],
    outs: [{ id: "out", label: "", type: "vec3" }],
    params: [{ k: "ConstA", v: "—" }, { k: "ConstB", v: "1.0" }],
    meta: m("Engine Node Export", "2026-05-20T11:02:00", "fresh", 2) },

  { id: "mf_unpack", cat: "func", title: "MF_UnpackNormal", sub: "MaterialFunctionCall", col: 2, row: 3.4, drillable: true,
    ins: [{ id: "in", label: "Packed", type: "vec3" }],
    outs: [{ id: "n", label: "Normal", type: "vec3" }],
    params: [{ k: "Function", v: "MF_UnpackNormal", code: "/Game/Materials/Functions/MF_UnpackNormal" }],
    meta: m("Project Material Functions", "2026-06-03T14:22:00", "fresh", 5) },

  { id: "frac", cat: "math", title: "Fresnel", col: 2, row: 4.5,
    ins: [{ id: "exp", label: "Exponent", type: "scalar" }, { id: "n", label: "Normal", type: "vec3" }],
    outs: [{ id: "out", label: "", type: "scalar" }],
    params: [{ k: "Exponent", v: "5.0" }, { k: "BaseReflect", v: "0.04" }],
    meta: m("Engine Node Export", "2026-05-20T11:02:00", "fresh", 6) },

  // --- column 3: combine -----------------------------------------------
  { id: "lerp_color", cat: "vector", title: "LinearInterpolate", sub: "Lerp — tint", col: 3, row: 0.9,
    ins: [{ id: "a", label: "A", type: "color" }, { id: "b", label: "B", type: "color" }, { id: "alpha", label: "Alpha", type: "scalar" }],
    outs: [{ id: "out", label: "", type: "color" }],
    params: [{ k: "ConstAlpha", v: "0.5" }],
    meta: m("Engine Node Export", "2026-05-20T11:02:00", "fresh", 3) },

  { id: "mul_rough", cat: "vector", title: "Multiply", sub: "Roughness", col: 3, row: 2.2,
    ins: [{ id: "a", label: "A", type: "scalar" }, { id: "b", label: "B", type: "scalar" }],
    outs: [{ id: "out", label: "", type: "scalar" }],
    params: [{ k: "ConstB", v: "1.0" }],
    meta: m("Engine Node Export", "2026-05-20T11:02:00", "fresh", 2) },

  { id: "add_ao", cat: "math", title: "Add", sub: "AO + Fresnel", col: 3, row: 3.5,
    ins: [{ id: "a", label: "A", type: "scalar" }, { id: "b", label: "B", type: "scalar" }],
    outs: [{ id: "out", label: "", type: "scalar" }],
    params: [{ k: "ConstA", v: "0.0" }],
    meta: m("Engine Node Export", "2026-05-20T11:02:00", "fresh", 2) },

  { id: "unknown_x", cat: "utility", title: "MF_WetnessOverlay", sub: "Unresolved function", col: 3, row: 4.6, status: "error",
    ins: [{ id: "in", label: "In", type: "color" }],
    outs: [{ id: "out", label: "Out", type: "color" }],
    params: [{ k: "Function", v: "MF_WetnessOverlay", code: "/Game/Materials/Functions/MF_WetnessOverlay  (not found)" }],
    meta: m("Project Material Functions", null, "missing", 0) },

  // --- column 4: output --------------------------------------------------
  { id: "mat_attr", cat: "utility", title: "MakeMaterialAttributes", col: 4, row: 2.0, w: 190,
    ins: [
      { id: "bc", label: "BaseColor", type: "color" },
      { id: "metal", label: "Metallic", type: "scalar" },
      { id: "spec", label: "Specular", type: "scalar" },
      { id: "rough", label: "Roughness", type: "scalar" },
      { id: "ao", label: "Ambient Occl.", type: "scalar" },
      { id: "normal", label: "Normal", type: "vec3" },
    ],
    outs: [{ id: "attr", label: "Attributes", type: "matattr" }],
    params: [{ k: "Shading", v: "Default Lit" }],
    meta: m("Engine Node Export", "2026-05-20T11:02:00", "fresh", 8) },

  { id: "output", cat: "output", title: "M_Rock_Cliff", sub: "Material Output", col: 5, row: 2.3, w: 184,
    ins: [{ id: "attr", label: "Material Attributes", type: "matattr" }],
    params: [{ k: "Blend Mode", v: "Opaque" }, { k: "Shading Model", v: "Default Lit" }, { k: "Two Sided", v: "false" }],
    meta: m("Project Materials", "2026-06-04T09:10:00", "fresh", 0) },
];

function m(dataset, ts, freshness, cost) {
  return { dataset, crawledAt: ts, freshness, cost };
}

// resolve col/row → x/y
NODES.forEach((n) => {
  if (n.x === undefined) n.x = CX(n.col);
  if (n.y === undefined) n.y = CY(n.row);
  if (!n.w) n.w = 184;
});

// ---- Edges (from node.outPin -> node.inPin), color by source pin type ---
const E = (f, fp, t, tp) => ({ from: f, fromPin: fp, to: t, toPin: tp });
const EDGES = [
  E("texcoord", "uv", "t_albedo", "uv"),
  E("texcoord", "uv", "t_orm", "uv"),
  E("panner", "uv", "t_detail", "uv"),
  E("time", "t", "panner", "time"),
  E("texcoord", "uv", "t_normal", "uv"),

  E("t_albedo", "rgb", "mf_detail", "base"),
  E("t_detail", "rgb", "mf_detail", "detail"),
  E("t_detail", "r", "mf_detail", "mask"),
  E("p_basecolor", "rgb", "lerp_color", "b"),
  E("mf_detail", "out", "lerp_color", "a"),
  E("frac", "out", "lerp_color", "alpha"),

  E("t_normal", "rgb", "mul_norm", "a"),
  E("p_normint", "s", "mul_norm", "b"),
  E("mul_norm", "out", "mf_unpack", "in"),

  E("t_orm", "g", "mul_rough", "a"),
  E("p_rough", "s", "mul_rough", "b"),
  E("t_orm", "r", "add_ao", "a"),
  E("frac", "out", "add_ao", "b"),

  E("mf_unpack", "n", "frac", "n"),
  E("unknown_x", "out", "lerp_color", "a"), // creates a duplicate-input issue

  E("lerp_color", "out", "mat_attr", "bc"),
  E("mul_rough", "out", "mat_attr", "rough"),
  E("add_ao", "out", "mat_attr", "ao"),
  E("mf_unpack", "n", "mat_attr", "normal"),
  E("t_orm", "b", "mat_attr", "metal"),

  E("mat_attr", "attr", "output", "attr"),
];

// ---- Comment boxes (nested supported via parent) ------------------------
const COMMENTS = [
  { id: "c_albedo", label: "Albedo / Tint", color: "#4ea0d6", x: 60, y: 18, w: 1020, h: 270 },
  { id: "c_detail", label: "Detail blend", color: "#5fc46e", x: 560, y: 36, w: 250, h: 150, parent: "c_albedo" },
  { id: "c_normal", label: "Normal pipeline", color: "#8a7de0", x: 60, y: 318, w: 760, h: 250 },
  { id: "c_surface", label: "Surface — Rough / AO / Fresnel", color: "#d6a44e", x: 60, y: 588, w: 1020, h: 230 },
];

// ---- Issues for the "what's wrong" health panel -------------------------
const ISSUES = [
  { id: "i1", sev: "error", node: "unknown_x", title: "無法解析的 Material Function",
    detail: "圖中參照了 MF_WetnessOverlay，但爬取到的 function 集合裡沒有它。" },
  { id: "i2", sev: "error", node: "lerp_color", title: "輸入 pin「A」重複連線",
    detail: "Pin A 同時接到兩條連線（MF_DetailBlend 與 MF_WetnessOverlay），只有一條會生效。" },
  { id: "i3", sev: "warn", node: "t_detail", title: "Texture sample 不是參數",
    detail: "T_Detail_Noise 是純 TextureSample2D — 不會被開放成 Material Instance 參數。" },
  { id: "i4", sev: "warn", node: "p_normint", title: "metadata 已過期",
    detail: "Normal Intensity 參數的 metadata 比來源母材質還舊，請重爬專案母材質。" },
  { id: "i5", sev: "info", node: "output", title: "Specular pin 未連接",
    detail: "MakeMaterialAttributes → Specular 沒有輸入；UE 會使用預設 0.5。" },
];

// ---- Files tree ---------------------------------------------------------
const FILES = {
  agent: [
    { proj: "Cliffside_Biome", items: [
      { id: "output", name: "M_Rock_Cliff", type: "material", status: "warn", nodes: 41, big: false, open: true },
      { id: "m_sand", name: "M_Sand_Dune", type: "material", status: "ok", nodes: 28, big: false },
      { id: "m_terrain", name: "M_Terrain_Blend", type: "material", status: "error", nodes: 612, big: true },
      { id: "m_water", name: "M_River_Water", type: "material", status: "ok", nodes: 96, big: false },
    ]},
    { proj: "Shared_Master", items: [
      { id: "m_master", name: "M_Master_Surface", type: "material", status: "ok", nodes: 184, big: false },
      { id: "m_decal", name: "M_Decal_Generic", type: "material", status: "warn", nodes: 47, big: false },
    ]},
  ],
  crawled: [
    { proj: "/Game (crawled mirror)", items: [
      { id: "cm1", name: "M_Foliage_Master", type: "material", status: "ok", nodes: 233, big: false, ro: true },
      { id: "cm2", name: "M_Landscape_Auto", type: "material", status: "ok", nodes: 740, big: true, ro: true },
      { id: "cm3", name: "M_Glass_Refract", type: "material", status: "ok", nodes: 58, big: false, ro: true },
      { id: "cm4", name: "M_Skin_Subsurface", type: "material", status: "warn", nodes: 121, big: false, ro: true },
    ]},
  ],
  functions: [
    { id: "f1", name: "MF_DetailBlend", type: "function", status: "ok", nodes: 9, usedBy: 14 },
    { id: "f2", name: "MF_UnpackNormal", type: "function", status: "ok", nodes: 5, usedBy: 31 },
    { id: "f3", name: "MF_TriplanarSample", type: "function", status: "ok", nodes: 22, usedBy: 8 },
    { id: "f4", name: "MF_WetnessOverlay", type: "function", status: "error", nodes: 0, usedBy: 3, missing: true },
  ],
};

// ---- Crawl datasets, env, logs now live in config_data.jsx -------------

Object.assign(window, {
  PIN_TYPES, CATEGORIES, NODES, EDGES, COMMENTS, ISSUES, FILES,
});
