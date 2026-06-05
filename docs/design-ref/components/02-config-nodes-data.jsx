/* =========================================================================
   Config / Crawl + Nodes-tab data  (Traditional Chinese primary)
   ========================================================================= */

// ---- Static project paths (section 1) -----------------------------------
const PROJECT_PATHS = {
  uproject: "D:/Projects/Cliffside/Cliffside.uproject",
  engineRoot: "C:/Program Files/Epic Games/UE_5.7",
  mfRoot: "/Game",
};

// ---- Environment checklist — 6 checks, a GATE (section 2) ----------------
// state machine flips e_dll to fail when env "not ready" scenario is on.
function envChecks(ready) {
  return [
    { id: "os",     label: "Windows 平台",                 en: "Windows platform",        ok: true,  detail: "Windows 11 · build 26100" },
    { id: "cfg",    label: "local.config.json 存在",        en: "config present",          ok: true,  detail: ".uemat/local.config.json" },
    { id: "ue",     label: "UE 引擎已找到",                  en: "UnrealEditor-Cmd.exe",    ok: true,  detail: "UE_5.7/Engine/Binaries/Win64" },
    { id: "uproj",  label: ".uproject 存在",                en: ".uproject exists",        ok: true,  detail: "Cliffside.uproject" },
    { id: "dll",    label: "外掛 DLL 已編譯",                en: "plugin DLL compiled",     ok: ready, detail: ready ? "UEMatBridge.dll · 2026-06-01" : "找不到已編譯的 DLL — 請於 UE 重建外掛" },
    { id: "shadow", label: "無 shadow plugin 複本",          en: "no shadow plugin copy",   ok: true,  detail: "未偵測到重複外掛" },
  ];
}

// ---- Four crawl kinds, two tiers (section 3) ----------------------------
// freshness is held in App state; here we describe each kind.
const CRAWL_KINDS = {
  projMF: {
    tier: "primary", label: "重爬專案 Material Function", en: "Re-crawl Project Material Functions",
    desc: "擷取你 /Game 專案 Material Function 的 pin 簽章", refresh: "更新 Nodes 分頁，並即時重新解析開啟中的圖",
    count: 142, dur: 5200,
  },
  projMat: {
    tier: "primary", label: "重爬專案母材質", en: "Re-crawl Project Materials",
    desc: "把每個 /Game 母材質從 UE 匯出成可開啟的圖", refresh: "填入 Files 分頁的「專案母材質（爬取）」",
    count: 318, dur: 6400,
  },
  nodeExport: {
    tier: "advanced", label: "重爬節點導出", en: "Re-crawl Node Export",
    desc: "重建節點型別資料庫（UE 原生節點）", refresh: "更新 Nodes 分頁的節點型別",
    count: 487, dur: 4200,
  },
  engineMF: {
    tier: "advanced", label: "重爬引擎 Material Function", en: "Re-crawl Engine Material Functions",
    desc: "重建 /Engine MF 索引（官方原生）", refresh: "更新 Nodes 分頁的引擎 MF",
    count: 906, dur: 5600,
  },
};

// initial per-kind freshness (projMat = Never → Files crawled section empty)
const INITIAL_FRESHNESS = {
  projMF: "2026-06-03T14:22:00",
  projMat: null,
  nodeExport: "2026-05-20T11:02:00",
  engineMF: "2026-05-20T11:02:00",
};

// ---- Per-kind log streams ------------------------------------------------
function crawlLog(kind) {
  const boot = [
    { t: 0.0, lvl: "info", msg: "啟動 UnrealEditor-Cmd.exe -run=UEMatBridge …" },
    { t: 0.3, lvl: "dim",  msg: "LogInit: Build 5.7.0-39250847+++UE5" },
    { t: 1.1, lvl: "dim",  msg: "LogPython: bridge module loaded (uemat 0.9.4)" },
    { t: 2.4, lvl: "dim",  msg: "LogAssetRegistry: scanning content roots…" },
  ];
  const tails = {
    projMF: [
      { t: 3.2, lvl: "info", msg: "MF root = /Game · 142 material functions queued" },
      { t: 3.9, lvl: "ok",   msg: "MF_DetailBlend — 3 inputs / 1 output mapped" },
      { t: 4.3, lvl: "ok",   msg: "MF_UnpackNormal — 1 input / 1 output mapped" },
      { t: 4.6, lvl: "warn", msg: "MF_WetnessOverlay — 來源資產遺失，標記為 unresolved" },
      { t: 5.0, lvl: "ok",   msg: "寫入 142 筆 MF 簽章；重新解析 3 個開啟中的圖" },
      { t: 5.2, lvl: "ok",   msg: "完成 — 已即時刷新 Nodes 分頁" },
    ],
    projMat: [
      { t: 3.2, lvl: "info", msg: "MF root = /Game · 列舉 318 個母材質" },
      { t: 4.0, lvl: "ok",   msg: "M_Foliage_Master — 匯出 233 nodes" },
      { t: 4.7, lvl: "warn", msg: "M_Landscape_Auto — 740 nodes（大圖，延遲幾何）" },
      { t: 5.4, lvl: "ok",   msg: "M_Glass_Refract — 匯出 58 nodes" },
      { t: 5.9, lvl: "ok",   msg: "M_Skin_Subsurface — 匯出 121 nodes" },
      { t: 6.2, lvl: "ok",   msg: "寫入 4 個母材質鏡像 → Files・專案母材質（爬取）" },
    ],
    nodeExport: [
      { t: 3.2, lvl: "info", msg: "匯出 UE 5.7 原生節點型別 …" },
      { t: 4.0, lvl: "ok",   msg: "487 個節點型別、1 240 個 pin 定義" },
      { t: 4.2, lvl: "ok",   msg: "重建節點型別資料庫完成" },
    ],
    engineMF: [
      { t: 3.2, lvl: "info", msg: "索引 /Engine Material Functions …" },
      { t: 4.6, lvl: "ok",   msg: "906 個引擎 MF 已索引" },
      { t: 5.6, lvl: "ok",   msg: "/Engine MF 索引重建完成" },
    ],
  };
  return [...boot, ...(tails[kind] || [])];
}

// done summary per kind
const CRAWL_DONE = {
  projMF:     { updated: 142, errors: 0, warnings: 1 },
  projMat:    { updated: 4,   errors: 0, warnings: 1 },
  nodeExport: { updated: 487, errors: 0, warnings: 0 },
  engineMF:   { updated: 906, errors: 0, warnings: 0 },
};

// error scenario (shown when a crawl is forced to fail)
const CRAWL_ERROR = {
  exit: 6,
  title: "編輯器以 exit code 6 結束",
  cause: "UnrealEditor-Cmd 啟動後 180 秒內未回應 bridge 握手。常見原因是專案正開在另一個 UE 實例，鎖住了資產登錄檔。",
  fixSelf: true,
  fixText: "關閉其他開啟中的 Unreal Editor，再重試一次即可。",
  logTail: [
    { t: 0.0, lvl: "info",  msg: "啟動 UnrealEditor-Cmd.exe -run=UEMatBridge …" },
    { t: 0.3, lvl: "dim",   msg: "LogInit: Build 5.7.0-39250847+++UE5" },
    { t: 2.4, lvl: "warn",  msg: "LogAssetRegistry: content root 已被其他程序鎖定" },
    { t: 180.0, lvl: "error", msg: "bridge handshake timeout (180s) — 中止" },
    { t: 180.1, lvl: "error", msg: "Process exited with code 6" },
  ],
};

// =========================================================================
// Nodes tab — node-type & MF-signature browser
// =========================================================================
const NODE_TYPES = [
  { id: "nt_texsample", name: "TextureSample", cat: "texture", src: "engine",
    ins: [{ l: "UVs", t: "vec2" }, { l: "Tex", t: "tex" }], outs: [{ l: "RGB", t: "color" }, { l: "R", t: "scalar" }, { l: "G", t: "scalar" }, { l: "B", t: "scalar" }, { l: "A", t: "scalar" }], used: 64 },
  { id: "nt_lerp", name: "LinearInterpolate", cat: "vector", src: "engine",
    ins: [{ l: "A", t: "color" }, { l: "B", t: "color" }, { l: "Alpha", t: "scalar" }], outs: [{ l: "Result", t: "color" }], used: 51 },
  { id: "nt_mul", name: "Multiply", cat: "vector", src: "engine",
    ins: [{ l: "A", t: "vec3" }, { l: "B", t: "vec3" }], outs: [{ l: "Result", t: "vec3" }], used: 120 },
  { id: "nt_add", name: "Add", cat: "math", src: "engine",
    ins: [{ l: "A", t: "scalar" }, { l: "B", t: "scalar" }], outs: [{ l: "Result", t: "scalar" }], used: 98 },
  { id: "nt_fresnel", name: "Fresnel", cat: "math", src: "engine",
    ins: [{ l: "Exponent", t: "scalar" }, { l: "Normal", t: "vec3" }], outs: [{ l: "Result", t: "scalar" }], used: 22 },
  { id: "nt_panner", name: "Panner", cat: "coord", src: "engine",
    ins: [{ l: "Coordinate", t: "vec2" }, { l: "Time", t: "scalar" }, { l: "Speed", t: "vec2" }], outs: [{ l: "Result", t: "vec2" }], used: 19 },
  { id: "nt_texcoord", name: "TexCoord", cat: "coord", src: "engine",
    ins: [], outs: [{ l: "UV", t: "vec2" }], used: 140 },
  { id: "nt_scalarparam", name: "ScalarParameter", cat: "param", src: "engine",
    ins: [], outs: [{ l: "", t: "scalar" }], used: 210 },
  { id: "nt_vectorparam", name: "VectorParameter", cat: "param", src: "engine",
    ins: [], outs: [{ l: "RGB", t: "color" }], used: 88 },
  { id: "nt_makeattr", name: "MakeMaterialAttributes", cat: "utility", src: "engine",
    ins: [{ l: "BaseColor", t: "color" }, { l: "Metallic", t: "scalar" }, { l: "Roughness", t: "scalar" }, { l: "Normal", t: "vec3" }], outs: [{ l: "Attributes", t: "matattr" }], used: 37 },
];

const MF_SIGS = [
  { id: "mf_detail", name: "MF_DetailBlend", src: "project", path: "/Game/Materials/Functions", used: 14,
    ins: [{ l: "Base", t: "color" }, { l: "Detail", t: "color" }, { l: "Mask", t: "scalar" }], outs: [{ l: "Result", t: "color" }] },
  { id: "mf_unpack", name: "MF_UnpackNormal", src: "project", path: "/Game/Materials/Functions", used: 31,
    ins: [{ l: "Packed", t: "vec3" }], outs: [{ l: "Normal", t: "vec3" }] },
  { id: "mf_triplanar", name: "MF_TriplanarSample", src: "project", path: "/Game/Materials/Functions", used: 8,
    ins: [{ l: "Texture", t: "tex" }, { l: "Position", t: "vec3" }, { l: "Tiling", t: "scalar" }], outs: [{ l: "RGB", t: "color" }] },
  { id: "mf_wetness", name: "MF_WetnessOverlay", src: "project", path: "/Game/Materials/Functions", used: 3, missing: true,
    ins: [{ l: "In", t: "color" }], outs: [{ l: "Out", t: "color" }] },
  { id: "mf_worldalign", name: "WorldAlignedTexture", src: "engine", path: "/Engine/Functions", used: 12,
    ins: [{ l: "TextureObject", t: "tex" }, { l: "WorldPosition", t: "vec3" }], outs: [{ l: "XY", t: "color" }, { l: "XYZ", t: "color" }] },
  { id: "mf_camerafade", name: "CameraDepthFade", src: "engine", path: "/Engine/Functions", used: 6,
    ins: [{ l: "FadeDistance", t: "scalar" }], outs: [{ l: "Result", t: "scalar" }] },
];

Object.assign(window, {
  PROJECT_PATHS, envChecks, CRAWL_KINDS, INITIAL_FRESHNESS, crawlLog, CRAWL_DONE, CRAWL_ERROR, NODE_TYPES, MF_SIGS,
});
