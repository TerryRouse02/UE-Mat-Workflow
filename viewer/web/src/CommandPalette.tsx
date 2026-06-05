// Stub — replaced by Task I (command palette + toast restyle)
export interface CommandPaletteProps {
  onClose(): void;
  onJump(id: string): void;
  onCmd(id: string): void;
  nodes: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  db: any;      // eslint-disable-line @typescript-eslint/no-explicit-any
  connection: string;
  envReady: boolean;
}

export function CommandPalette(_props: CommandPaletteProps): null {
  return null;
}
