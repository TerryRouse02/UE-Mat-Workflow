import { useState } from 'react';
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

function isCodeLike(v: unknown): v is string {
  return typeof v === 'string' && (v.includes('\n') || v.length > 40);
}

function CodeBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="mat-code">
      <pre>{value}</pre>
      <button
        className="mat-copy-btn"
        onClick={onCopy}
        onMouseDown={(e) => e.stopPropagation()}
        title="Copy to clipboard"
      >{copied ? '✓ Copied' : '⧉ Copy'}</button>
    </div>
  );
}

export function MaterialNode({ data }: { data: MaterialNodeData }) {
  const cls = ['mat-node'];
  if (data.warning) cls.push('mat-warn');
  if (data.isReserved) cls.push('mat-reserved');

  return (
    <div className={cls.join(' ')}>
      <div className="mat-node-title">{data.label}</div>
      <div className="mat-node-body">
        {data.inputs.length > 0 && (
          <div className="mat-node-pins mat-inputs">
            {data.inputs.map((p) => (
              <div key={p.name} className="mat-pin">
                <Handle id={p.name} type="target" position={Position.Left} />
                <span className="mat-pin-name">{p.name}</span>
                {p.type && p.type !== 'Float' && (
                  <span className="mat-pin-type">: {p.type}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {data.outputs.length > 0 && (
          <div className="mat-node-pins mat-outputs">
            {data.outputs.map((p) => (
              <div key={p.name} className="mat-pin mat-pin-right">
                {p.type && p.type !== 'Float' && (
                  <span className="mat-pin-type">{p.type} :</span>
                )}
                <span className="mat-pin-name">{p.name}</span>
                <Handle id={p.name} type="source" position={Position.Right} />
              </div>
            ))}
          </div>
        )}
      </div>
      {data.params && Object.keys(data.params).length > 0 && (
        <div className="mat-node-params">
          {Object.entries(data.params).map(([k, v]) => (
            <div key={k} className="mat-param">
              <span>{k}:</span>{' '}
              {isCodeLike(v)
                ? <CodeBlock value={v} />
                : <code>{JSON.stringify(v)}</code>}
            </div>
          ))}
        </div>
      )}
      {data.warning && <div className="mat-warn-msg">{data.warning}</div>}
    </div>
  );
}
