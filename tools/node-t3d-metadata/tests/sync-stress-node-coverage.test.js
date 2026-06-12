const test = require('node:test');
const assert = require('node:assert/strict');
const { syncGraph } = require('../sync-stress-node-coverage.js');

function fixture() {
  return {
    db: {
      nodes: {
        Existing: { inputs: [], outputs: [{ name: 'Result', type: 'Float1' }] },
        NewMath: { inputs: [{ name: 'A', type: 'Float3' }], outputs: [{ name: 'Result', type: 'Float3' }] },
        NewTexture: { inputs: [], outputs: [{ name: 'Texture', type: 'Texture2D' }] },
        NewSink: { inputs: [], outputs: [], dynamicPins: true },
      },
    },
    graph: {
      schemaVersion: '1.0',
      ueVersion: '5.7',
      type: 'Material',
      name: 'stress_all_nodes',
      description: 'every one of the ~299 UE 5.7 material node types in nodes-ue5.7.json appears at least once',
      nodes: [
        { id: 'SRC_Scalar', type: 'Constant' },
        { id: 'SRC_Vec3', type: 'Constant3Vector' },
        { id: 'SRC_UV', type: 'TextureCoordinate' },
        { id: 'SRC_TexObj', type: 'TextureObject' },
        { id: 'G_Existing', type: 'Existing' },
        { id: 'COL_314', type: 'Add' },
        { id: 'FINAL_Sat', type: 'Saturate' },
      ],
      connections: [
        { from: 'COL_314:Result', to: 'FINAL_Sat:Input' },
        { from: 'G_MaterialCache:BaseColor', to: 'COL_243:B' },
        { from: 'SRC_UV:UVs', to: 'G_SceneDepth:UVs' },
        { from: 'SRC_TexObj:Texture', to: 'G_TextureSampleParameter2D:Tex' },
        { from: 'G_ViewProperty:Value', to: 'COL_76:B' },
      ],
      comments: [],
    },
  };
}

test('syncGraph adds missing node types, bridges texture outputs, and is idempotent', () => {
  const { db, graph } = fixture();
  const first = syncGraph(db, graph);
  assert.deepEqual(first.missingTypes, ['NewMath', 'NewTexture', 'NewSink']);
  assert.ok(first.graph.nodes.some((node) => node.id === 'OFFICIAL_NewMath' && node.type === 'NewMath'));
  assert.ok(first.graph.nodes.some((node) => node.id === 'OFFICIAL_NewTexture_Sample' && node.type === 'TextureSample'));
  assert.ok(first.graph.nodes.some((node) => node.id === 'OFFICIAL_NewSink' && node.type === 'NewSink'));
  assert.ok(first.graph.connections.some((connection) => connection.from === 'OFFICIAL_NewTexture:Texture' && connection.to === 'OFFICIAL_NewTexture_Sample:Tex'));
  assert.ok(first.graph.connections.some((connection) => connection.to === 'FINAL_Sat:Input' && connection.from.startsWith('OFFICIAL_COL_')));
  assert.equal(first.graph.connections.some((connection) => connection.from === 'G_MaterialCache:BaseColor'), false);
  assert.ok(first.graph.connections.some((connection) => connection.to === 'G_SceneDepth:Coordinates'));
  assert.equal(first.graph.connections.some((connection) => connection.to === 'G_TextureSampleParameter2D:Tex'), false);
  assert.ok(first.graph.connections.some((connection) => connection.from === 'G_ViewProperty:Property'));
  assert.match(first.graph.description, /all 4 UE 5\.7 authoring node definitions/);

  const second = syncGraph(db, first.graph);
  assert.deepEqual(second.graph, first.graph);
});
