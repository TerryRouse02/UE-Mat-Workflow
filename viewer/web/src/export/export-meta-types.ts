// UE export metadata contract. Pure types — no runtime imports.
export type ParamKind =
  | 'float' | 'int' | 'bool' | 'name' | 'string' | 'enum'
  | 'vector2' | 'vector3' | 'vector4' | 'texture';

export interface ParamMeta {
  property: string;                       // UE UProperty name
  kind: ParamKind;
  valueMap?: Record<string, string>;      // enum: our value -> UE literal
  components?: Record<string, string>;    // vectorN: UE struct key (R/G/B/A) -> our param name
}

export interface InputMeta {
  property: string;                       // UE FExpressionInput property; may be "A" or "Inputs(0)"
}

export interface OutputMeta {
  index: number;                          // UE OutputIndex
  mask?: string;                          // channel mask like "R", "G", "RG" (omit for full output)
}

export interface NodeExportMeta {
  ueClass: string;                        // e.g. "/Script/Engine.MaterialExpressionMultiply"
  inputs: Record<string, InputMeta>;      // our pin name -> input mapping
  outputs: Record<string, OutputMeta>;    // our pin name -> output mapping
  params: Record<string, ParamMeta>;      // our param name -> param mapping
  functionRefProperty?: string;           // MaterialFunctionCall only
  sample?: string;                        // raw copied T3D (reference only; not parsed)
  verified?: boolean;
  dynamicExport?: boolean;                // dynamic-pin node; emitter skips with a warning
}

export interface ExportMeta {
  schemaVersion: string;
  ueVersion: string;
  generatedAt?: string;
  source?: string;
  nodes: Record<string, NodeExportMeta>;
  reserved: Record<string, NodeExportMeta>;
}
