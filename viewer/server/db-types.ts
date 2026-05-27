export interface PinDef {
  name: string;
  type: string; // free-form: "Float1|2|3|4", "Float3", "Texture2D", "matchInput"
  required?: boolean;
}

export interface ParamDef {
  name: string;
  type: string; // "Float", "Name", "Enum", "TextureRef", ...
  default?: unknown;
  values?: string[]; // for Enum
  required?: boolean;
  when?: string; // human-readable condition like "A unconnected"
}

export interface NodeDef {
  category: string;
  description: string;
  inputs: PinDef[];
  outputs: PinDef[];
  params?: ParamDef[];
  verified: boolean;
}

export interface NodeDB {
  schemaVersion: string;
  ueVersion: string;
  generatedAt: string;
  source: string;
  nodes: Record<string, NodeDef>;
  reservedTypes: string[];
}
