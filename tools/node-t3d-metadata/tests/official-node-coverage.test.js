const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW_ROOT = path.resolve(__dirname, '..', '..', '..');

const OFFICIAL_PLUGIN_NODES = [
  'HeightfieldMinMaxTexture',
  'MaterialXAppend3Vector',
  'MaterialXAppend4Vector',
  'MaterialXBurn',
  'MaterialXContrast',
  'MaterialXDifference',
  'MaterialXDisjointOver',
  'MaterialXDodge',
  'MaterialXFractal3D',
  'MaterialXIn',
  'MaterialXLuminance',
  'MaterialXMask',
  'MaterialXMatte',
  'MaterialXMinus',
  'MaterialXMod',
  'MaterialXOut',
  'MaterialXOver',
  'MaterialXOverlay',
  'MaterialXPlace2D',
  'MaterialXPlus',
  'MaterialXPremult',
  'MaterialXRamp4',
  'MaterialXRampLeftRight',
  'MaterialXRampTopBottom',
  'MaterialXRange',
  'MaterialXRemap',
  'MaterialXRotate2D',
  'MaterialXScreen',
  'MaterialXSplitLeftRight',
  'MaterialXSplitTopBottom',
  'MaterialXSwizzle',
  'MaterialXTextureSampleParameterBlur',
  'MaterialXUnpremult',
  'PhysicalMaterialOutput',
  'SpriteTextureSampler',
];

const OFFICIAL_SPECIAL_TYPES = [
  'Aggregate',
  'Comment',
  'Composite',
  'Convert',
  'FunctionInput',
  'FunctionOutput',
  'LinearInterpolate',
  'MaterialFunctionCall',
  'MaterialSample',
  'Operator',
  'Parameter',
  'PinBase',
  'Reroute',
];

function read(relativePath) {
  return fs.readFileSync(path.join(WORKFLOW_ROOT, relativePath), 'utf8');
}

test('UE 5.7 authoring DB contains every discovered Epic plugin expression', () => {
  const db = JSON.parse(read('agent-pack/nodes-ue5.7.json'));
  const missing = OFFICIAL_PLUGIN_NODES.filter((name) => !db.nodes?.[name]);
  assert.deepEqual(missing, []);
  assert.equal(db.nodes.MaterialXRotate2D.deprecated, true);
  assert.equal(db.nodes.PhysicalMaterialOutput.dynamicPins, true);
});

test('UE 5.7 static pin snapshots match live engine reflection', () => {
  const db = JSON.parse(read('agent-pack/nodes-ue5.7.json'));
  const names = (pins) => (pins ?? []).map((pin) => pin.name);
  const expectedOutputs = {
    Constant4Vector: ['RGBA', 'R', 'G', 'B', 'A', 'RGB'],
    ParticleColor: ['RGB', 'R', 'G', 'B', 'A', 'RGBA'],
    ParticleDirection: ['XYZ'],
    ParticleSize: ['Size'],
    ViewProperty: ['Property', 'InvProperty'],
    ActorPositionWS: ['XYZ'],
    CameraPositionWS: ['XYZ'],
    ObjectOrientation: ['XYZ'],
    ObjectPositionWS: ['XYZ'],
    ParticlePositionWS: ['XYZ'],
    PixelNormalWS: ['XYZ'],
    VertexNormalWS: ['XYZ'],
    VertexTangentWS: ['XYZ'],
    WorldPosition: ['XYZ', 'XY', 'Z'],
    BreakMaterialAttributes: [
      'BaseColor', 'Metallic', 'Specular', 'Roughness', 'Anisotropy',
      'EmissiveColor', 'Opacity', 'OpacityMask', 'Normal', 'Tangent',
      'WorldPositionOffset', 'SubsurfaceColor', 'ClearCoat', 'ClearCoatRoughness',
      'AmbientOcclusion', 'Refraction', 'CustomizedUV0', 'CustomizedUV1',
      'CustomizedUV2', 'CustomizedUV3', 'CustomizedUV4', 'CustomizedUV5',
      'CustomizedUV6', 'CustomizedUV7', 'PixelDepthOffset', 'ShadingModel',
      'Displacement',
    ],
    DynamicParameter: ['Param1', 'Param2', 'Param3', 'Param4', 'RGB', 'RGBA'],
    VectorParameter: ['RGB', 'R', 'G', 'B', 'A', 'RGBA'],
    TextureSample: ['RGB', 'R', 'G', 'B', 'A', 'RGBA'],
    TextureSampleParameterSubUV: ['RGB', 'R', 'G', 'B', 'A', 'RGBA'],
    TextureSampleParameterCube: ['RGB', 'R', 'G', 'B', 'A', 'RGBA'],
    ParticleSubUV: ['RGB', 'R', 'G', 'B', 'A', 'RGBA'],
    VectorNoise: ['RGBA'],
    CameraVectorWS: ['XYZ'],
    LightVector: ['XYZ'],
    ObjectBounds: ['XYZ'],
    ReflectionVectorWS: ['XYZ'],
    PreSkinnedNormal: ['XYZ'],
    PreSkinnedPosition: ['XYZ'],
  };
  for (const [nodeType, expected] of Object.entries(expectedOutputs)) {
    assert.deepEqual(names(db.nodes[nodeType].outputs), expected, `${nodeType} outputs`);
  }

  const expectedInputs = {
    TextureSampleParameter2D: ['UVs', 'Apply View MipBias'],
    Desaturation: ['Input', 'Fraction'],
    SceneDepth: ['Coordinates'],
    Logarithm10: ['X'],
    Logarithm2: ['X'],
    TextureObjectParameter: ['Coordinates', 'Apply View MipBias'],
    TextureSample: ['UVs', 'Tex', 'Apply View MipBias'],
    TextureSampleParameterSubUV: ['UVs', 'Apply View MipBias'],
    TextureSampleParameterCube: ['UVs', 'Apply View MipBias'],
    ParticleSubUV: ['UVs', 'TextureObject', 'Apply View MipBias'],
    AntialiasedTextureMask: ['UVs', 'Apply View MipBias'],
  };
  for (const [nodeType, expected] of Object.entries(expectedInputs)) {
    assert.deepEqual(names(db.nodes[nodeType].inputs), expected, `${nodeType} inputs`);
  }
  assert.equal(names(db.nodes.SubstrateSlabBSDF.inputs).includes('Unknown'), false);
});

test('non-authoring official classes have an explicit handling record', () => {
  const db = JSON.parse(read('agent-pack/nodes-ue5.7.json'));
  assert.deepEqual(Object.keys(db.officialSpecialTypes ?? {}).sort(), OFFICIAL_SPECIAL_TYPES.sort());
  for (const name of OFFICIAL_SPECIAL_TYPES) {
    const entry = db.officialSpecialTypes[name];
    assert.match(entry.ueClass, /^\/Script\//, `${name} is missing ueClass`);
    assert.ok(entry.handling, `${name} is missing handling`);
    assert.ok(entry.reason, `${name} is missing reason`);
  }
});

test('node discovery counts explicit special handling as official coverage', () => {
  const source = read('tools/node-t3d-metadata/plugin-src/Source/UEMatExportMetadata/Private/UEMatExportMetadataCommandlet.cpp');
  assert.match(source, /officialSpecialTypes/);
  assert.match(source, /handledSpecial/);
  assert.match(source, /covered/);
  assert.match(source, /BuildClassOverrides\(\)/);
  assert.match(source, /BuildFunctionAssetOverrides\(\)/);
});

test('cross-module classes resolve from each DB entry ueClass hint', () => {
  const source = read('tools/node-t3d-metadata/plugin-src/Source/UEMatExportMetadata/Private/UEMatExportMetadataCommandlet.cpp');
  assert.match(source, /ResolveExpressionClass\(NodeType,\s*JsonStringField\(NodeObject,\s*TEXT\("ueClass"\)\)\)/);
});

test('node self-test normalizes unnamed outputs and matches inputs by exported property', () => {
  const source = read('tools/node-t3d-metadata/plugin-src/Source/UEMatExportMetadata/Private/UEMatExportMetadataCommandlet.cpp');
  assert.match(source, /Out\.OutputName\.IsNone\(\)\s*\?\s*FString\(\)/);
  assert.match(source, /RawInputName\.IsNone\(\)\s*\?\s*FString\(\)/);
  assert.match(source, /EngineInputNameOccurrences/);
  assert.match(source, /EngineInputPropertyNames/);
  assert.match(source, /EngineInputNames\.IndexOfByKey\(PropertyName\)/);
  assert.match(source, /MatchedEngineInputIndices/);
  assert.match(source, /FunctionAssetOverrides\.Contains\(NodeType\)/);
  assert.match(source, /IntentionalOutputlessNodeTypes/);
  assert.match(source, /PropertyNameForInputByAddress/);
  assert.match(source, /TFieldIterator<FStructProperty>/);
  assert.match(source, /ContainerPtrToValuePtr<FExpressionInput>/);
  assert.match(source, /EngineInputNameOccurrences/);
  assert.match(source, /MaterialLayerOutput/);
  for (const token of ['bIgnorePause', 'bBlend', 'bTurbulence']) {
    assert.ok(source.includes(token), `missing reflected param mapping ${token}`);
  }
  assert.match(source, /bDynamic\s*&&\s*NodeType\s*!=\s*TEXT\("Custom"\)/);
  assert.match(source, /ExportParamObjectsForNode\(NodeType, ReadParamObjects\(NodeObject\)\)/);
});

test('all metadata runners enable official material-expression plugins', () => {
  const required = ['Interchange', 'Paper2D', 'VirtualHeightfieldMesh', 'RenderTrace'];
  for (const script of [
    'Run-UEMatExportMetadata.ps1',
    'Run-NodeDiscovery.ps1',
    'Run-NodeSelfTest.ps1',
  ]) {
    const source = read(`tools/node-t3d-metadata/plugin-src/Scripts/${script}`);
    for (const plugin of required) {
      assert.ok(source.includes(plugin), `${script} does not enable ${plugin}`);
    }
    assert.match(source, /-EnablePlugins=/, `${script} does not forward -EnablePlugins`);
  }
});

test('node self-test runner forwards absolute artifact paths to Unreal', () => {
  const source = read('tools/node-t3d-metadata/plugin-src/Scripts/Run-NodeSelfTest.ps1');
  assert.match(source, /\$PSBoundParameters\.ContainsKey\("ExportMeta"\)/);
  assert.match(source, /\$NodeDb\s*=\s*\(Resolve-Path -LiteralPath \$NodeDb\)\.Path/);
  assert.match(source, /\$ExportMeta\s*=\s*\(Resolve-Path -LiteralPath \$ExportMeta\)\.Path/);
  assert.match(source, /\$Out\s*=\s*\[System\.IO\.Path\]::GetFullPath\(\$Out\)/);
});

test('PhysicalMaterialOutput is accepted as an outputless sink', () => {
  const source = read('viewer/server/db-loader.ts');
  assert.match(source, /'PhysicalMaterialOutput'/);
});
