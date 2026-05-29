# Verification

Run these commands from `D:\Agent_Dev\UE-Mat-Workflow`.

## Tooling Layout

```powershell
node tools\node-t3d-metadata\validate-tooling.js
node tools\node-t3d-metadata\plugin-src\validate-plugin.js
```

Expected output:

```text
Node T3D metadata tooling bundle is organized and documented.
UEMatExportMetadata plugin source layout is valid.
```

## Metadata Audit

```powershell
node -e "const fs=require('fs'); const db=JSON.parse(fs.readFileSync('agent-pack/nodes-ue5.7.json','utf8')); const exp=JSON.parse(fs.readFileSync('agent-pack/nodes-ue5.7.export.json','utf8')); const dbKeys=Object.keys(db.nodes||{}); const nodeKeys=Object.keys(exp.nodes||{}); const reserved=Object.keys(exp.reserved||{}); const missing=dbKeys.filter(k=>!(k in exp.nodes)); const orphans=nodeKeys.filter(k=>!(k in db.nodes)); const dynamic=nodeKeys.filter(k=>exp.nodes[k].dynamicExport); const verified=nodeKeys.filter(k=>exp.nodes[k].verified===true); const unresolved=nodeKeys.filter(k=>exp.nodes[k].verified!==true && !exp.nodes[k].dynamicExport); const bad=[]; for (const k of [...nodeKeys, ...reserved.map(k=>'reserved:'+k)]) { const m=k.startsWith('reserved:') ? exp.reserved[k.slice(9)] : exp.nodes[k]; for (const f of ['ueClass','inputs','outputs','params']) { if (f==='ueClass' ? typeof m[f] !== 'string' : !m[f] || typeof m[f] !== 'object' || Array.isArray(m[f])) bad.push(k+'.'+f); } } console.log('db='+dbKeys.length+' export='+nodeKeys.length+' reserved='+reserved.length+' missing='+missing.length+' orphans='+orphans.length+' verified='+verified.length+' dynamic='+dynamic.length+' unresolved='+unresolved.length+' badShape='+bad.length); if (missing.length || orphans.length || unresolved.length || bad.length) process.exit(1);"
```

Expected current result:

```text
db=142 export=142 reserved=3 missing=0 orphans=0 verified=138 dynamic=4 unresolved=0 badShape=0
```

## UE Commandlet Log

Check `Logs\UE\UEMatExportMetadata_Commandlet.log` for:

```text
Warnings: 0
Success - 0 error(s), 0 warning(s)
```

## Viewer Test

If dependencies are installed:

```powershell
cd viewer
.\node_modules\.bin\vitest.cmd run tests\export-meta.test.ts
```

If `viewer\node_modules` is missing, install dependencies with the repo package manager first. On this machine, registry access may block `corepack pnpm install --frozen-lockfile`; report that as an environment blocker rather than claiming Vitest passed.
