// Keep graphs/stress_all_nodes aligned with the authoring node DB.
// Generated nodes use an OFFICIAL_ prefix so the operation is deterministic
// and idempotent when the DB grows.

const fs = require('fs');
const path = require('path');

const GENERATED_PREFIX = 'OFFICIAL_';
const GENERATED_COMMENT_ID = 'CMT_OfficialPlugins';
const CHAIN_ANCHOR_FROM = 'COL_314:Result';
const CHAIN_ANCHOR_TO = 'FINAL_Sat:Input';
const INPUT_MIGRATIONS = new Map([
  ['G_TextureSampleParameter2D:Tex', null],
  ['G_Desaturation:LuminanceFactors', null],
  ['G_SceneDepth:UVs', 'G_SceneDepth:Coordinates'],
  ['G_Logarithm10:Input', 'G_Logarithm10:X'],
  ['G_Logarithm2:Input', 'G_Logarithm2:X'],
  ['G_TextureSampleParameterCube:Tex', null],
  ['G_SubstrateSlabBSDF:Unknown', null],
]);
const OUTPUT_MIGRATIONS = new Map([
  ['G_ViewProperty:Value', 'G_ViewProperty:Property'],
]);

function generatedId(type) {
  return `${GENERATED_PREFIX}${type.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function sourceForInput(pin) {
  const type = String(pin.type ?? '');
  if (/Texture/i.test(type)) return 'SRC_TexObj:Texture';
  if (/Coordinates|UV/i.test(pin.name) || type === 'Float2') return 'SRC_UV:UVs';
  if (type === 'StaticBool' || type === 'Float1') return 'SRC_Scalar:Value';
  return 'SRC_Vec3:RGB';
}

function requiredParams(type, node) {
  const params = {};
  for (const param of node.params ?? []) {
    if (!param.required) continue;
    if (param.type === 'Name' || param.type === 'String') {
      params[param.name] = `Stress_${type}`;
    }
  }
  return params;
}

function numericOutput(node) {
  const outputs = node.outputs ?? [];
  return outputs.find((pin) => pin.name === 'RGB')
    ?? outputs.find((pin) => pin.name === 'Result')
    ?? outputs.find((pin) => /^Float/.test(String(pin.type ?? '')));
}

function textureOutput(node) {
  return (node.outputs ?? []).find((pin) => /Texture/i.test(String(pin.type ?? '')));
}

function syncGraph(db, inputGraph) {
  const graph = JSON.parse(JSON.stringify(inputGraph));
  const generatedNodeIds = new Set(
    graph.nodes.filter((node) => node.id.startsWith(GENERATED_PREFIX)).map((node) => node.id),
  );

  graph.nodes = graph.nodes.filter((node) => !generatedNodeIds.has(node.id));
  graph.connections = graph.connections.filter((connection) => {
    const fromId = connection.from.split(':', 1)[0];
    const toId = connection.to.split(':', 1)[0];
    return !generatedNodeIds.has(fromId) && !generatedNodeIds.has(toId);
  });
  graph.comments = (graph.comments ?? []).filter((comment) => comment.id !== GENERATED_COMMENT_ID);

  graph.connections = graph.connections.flatMap((connection) => {
    if (!INPUT_MIGRATIONS.has(connection.to)) return [connection];
    const replacement = INPUT_MIGRATIONS.get(connection.to);
    return replacement ? [{ ...connection, to: replacement }] : [];
  });
  graph.connections = graph.connections.map((connection) => ({
    ...connection,
    from: OUTPUT_MIGRATIONS.get(connection.from) ?? connection.from,
  }));

  // MaterialCache has instance-dependent pins. The old static fixture wired one
  // of its outputs into the collector, which is no longer a valid export promise.
  graph.connections = graph.connections.filter((connection) => !(
    connection.from === 'G_MaterialCache:BaseColor' && connection.to === 'COL_243:B'
  ));

  const presentTypes = new Set(graph.nodes.map((node) => node.type));
  const missingTypes = Object.keys(db.nodes).filter((type) => !presentTypes.has(type));
  const generatedContentIds = [];
  const collectedSources = [];

  for (const type of missingTypes) {
    const definition = db.nodes[type];
    const id = generatedId(type);
    const params = requiredParams(type, definition);
    const node = { id, type };
    if (Object.keys(params).length > 0) node.params = params;
    graph.nodes.push(node);
    generatedContentIds.push(id);

    if (!definition.dynamicPins) {
      for (const pin of definition.inputs ?? []) {
        graph.connections.push({ from: sourceForInput(pin), to: `${id}:${pin.name}` });
      }
    }

    const numeric = numericOutput(definition);
    if (numeric) {
      collectedSources.push(`${id}:${numeric.name}`);
      continue;
    }

    const texture = textureOutput(definition);
    if (texture) {
      const sampleId = `${id}_Sample`;
      graph.nodes.push({ id: sampleId, type: 'TextureSample' });
      graph.connections.push({ from: `${id}:${texture.name}`, to: `${sampleId}:Tex` });
      graph.connections.push({ from: 'SRC_UV:UVs', to: `${sampleId}:UVs` });
      collectedSources.push(`${sampleId}:RGB`);
      generatedContentIds.push(sampleId);
    }
  }

  graph.connections = graph.connections.filter((connection) => !(
    connection.from === CHAIN_ANCHOR_FROM && connection.to === CHAIN_ANCHOR_TO
  ));
  let previous = CHAIN_ANCHOR_FROM;
  collectedSources.forEach((source, index) => {
    const collectorId = `${GENERATED_PREFIX}COL_${index}`;
    graph.nodes.push({ id: collectorId, type: 'Add' });
    graph.connections.push({ from: previous, to: `${collectorId}:A` });
    graph.connections.push({ from: source, to: `${collectorId}:B` });
    previous = `${collectorId}:Result`;
  });
  graph.connections.push({ from: previous, to: CHAIN_ANCHOR_TO });

  if (generatedContentIds.length > 0) {
    graph.comments.push({
      id: GENERATED_COMMENT_ID,
      text: 'Official UE plugin expressions',
      color: '#2d5f6b',
      contains: generatedContentIds,
    });
  }

  const total = Object.keys(db.nodes).length;
  graph.description = String(graph.description ?? '')
    .replace(/every one of the ~?\d+ UE 5\.7 material node types in nodes-ue5\.7\.json appears at least once/, `all ${total} UE 5.7 authoring node definitions in nodes-ue5.7.json appear at least once`)
    .replace(/every one of the \d+ UE 5\.7 authoring node definitions in nodes-ue5\.7\.json appear at least once/, `all ${total} UE 5.7 authoring node definitions in nodes-ue5.7.json appear at least once`);

  return { graph, missingTypes };
}

function run(workflowRoot) {
  const dbPath = path.join(workflowRoot, 'agent-pack', 'nodes-ue5.7.json');
  const graphPath = path.join(workflowRoot, 'graphs', 'stress_all_nodes', 'stress_all_nodes.matgraph.json');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  const result = syncGraph(db, graph);
  fs.writeFileSync(graphPath, `${JSON.stringify(result.graph, null, 2)}\n`);
  console.log(`stress_all_nodes.matgraph.json: ${Object.keys(db.nodes).length} node types, ${result.missingTypes.length} generated coverage nodes`);
}

if (require.main === module) {
  try {
    const workflowRoot = process.argv[2]
      ? path.resolve(process.argv[2])
      : path.resolve(__dirname, '..', '..');
    run(workflowRoot);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = { syncGraph, run };
