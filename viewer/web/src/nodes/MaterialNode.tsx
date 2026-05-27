import { Handle, Position } from 'reactflow';
import './styles.css';

export interface MaterialNodeData {
  label: string;
  id: string;
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
  params?: Record<string, unknown>;
  warning?: string;
  isReserved?: boolean;
}

export function MaterialNode({ data }: { data: MaterialNodeData }) {
  const cls = ['mat-node'];
  if (data.warning) cls.push('mat-warn');
  if (data.isReserved) cls.push('mat-reserved');

  return (
    <div className={cls.join(' ')}>
      <div className="mat-node-title">{data.label}</div>
      <div className="mat-node-body">
        <div className="mat-node-pins mat-inputs">
          {data.inputs.map((p) => (
            <div key={p.name} className="mat-pin">
              <Handle id={p.name} type="target" position={Position.Left} />
              <span className="mat-pin-name">{p.name}</span>
            </div>
          ))}
        </div>
        <div className="mat-node-pins mat-outputs">
          {data.outputs.map((p) => (
            <div key={p.name} className="mat-pin mat-pin-right">
              <span className="mat-pin-name">{p.name}</span>
              <Handle id={p.name} type="source" position={Position.Right} />
            </div>
          ))}
        </div>
      </div>
      {data.params && Object.keys(data.params).length > 0 && (
        <div className="mat-node-params">
          {Object.entries(data.params).map(([k, v]) => (
            <div key={k} className="mat-param"><span>{k}:</span> <code>{JSON.stringify(v)}</code></div>
          ))}
        </div>
      )}
      {data.warning && <div className="mat-warn-msg">{data.warning}</div>}
    </div>
  );
}
