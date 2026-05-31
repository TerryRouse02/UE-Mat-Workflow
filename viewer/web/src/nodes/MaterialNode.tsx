import { Handle, Position } from 'reactflow';
import { pinColor, catColor } from '../theme/colors';
import './styles.css';

export interface MaterialNodeData {
  label: string;
  id: string;
  subtitle?: string;
  category?: string;
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
  params?: Record<string, unknown>;
  warning?: string;
  isReserved?: boolean;
  isMF?: boolean;
}

export function MaterialNode({ data }: { data: MaterialNodeData }) {
  const cls = ['gnode'];
  if (data.warning) cls.push('gnode-warn');
  if (data.isReserved) cls.push('gnode-reserved');
  return (
    <div className={cls.join(' ')}>
      <div className="gnode-head">
        <span className="gnode-catdot" style={{ background: catColor(data.category) }} />
        <div className="gnode-titles">
          <div className="gnode-title">{data.label}</div>
          {data.subtitle && <div className="gnode-sub">{data.subtitle}</div>}
        </div>
        {data.warning && <span className="gnode-badge warn" title={data.warning}>!</span>}
        {data.isMF && <span className="gnode-badge mf" title="MaterialFunction call">ƒ</span>}
      </div>
      <div className="gnode-body">
        <div className="gnode-col gnode-in">
          {data.inputs.map(p => (
            <div key={p.name} className="gpin">
              <Handle id={p.name} type="target" position={Position.Left} />
              <span className="gpin-dot" style={{ background: pinColor(p.type) }} />
              <span className="gpin-name">{p.name}</span>
            </div>
          ))}
        </div>
        <div className="gnode-col gnode-out">
          {data.outputs.map(p => (
            <div key={p.name} className="gpin gpin-r">
              <span className="gpin-name">{p.name || '(out)'}</span>
              <span className="gpin-dot" style={{ background: pinColor(p.type) }} />
              <Handle id={p.name} type="source" position={Position.Right} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
