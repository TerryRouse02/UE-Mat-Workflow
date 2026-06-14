import { useTranslation } from 'react-i18next';
import { MaterialNode, type MaterialNodeData } from './MaterialNode';

export interface MFCData {
  id: string;
  label: string;
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
  params?: Record<string, unknown>;
  onDoubleClick(): void;
  warning?: string;
}

export function MaterialFunctionCallNode({ data }: { data: MFCData }) {
  const { t } = useTranslation();
  const md: MaterialNodeData = {
    id: data.id, label: 'MaterialFunctionCall',
    subtitle: data.label,
    inputs: data.inputs, outputs: data.outputs,
    params: data.params, warning: data.warning, isReserved: true, isMF: true,
  };
  return (
    <div
      onDoubleClick={e => { e.stopPropagation(); data.onDoubleClick(); }}
      style={{ cursor: 'pointer' }}
      title={t('materialFunctionCallNode.doubleClickToEnter')}
    >
      <MaterialNode data={md} />
    </div>
  );
}
