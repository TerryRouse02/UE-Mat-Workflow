import type { EnvStatus } from '../../server/crawl-types';

// Drives the "編譯插件" button in the Config tab's env-check step. Pure + node-free
// so the gating matrix is unit-tested without React (see tests/compile-plugin-state).

export interface CompilePluginAction {
  /** RunUAT BuildPlugin needs a supported host OS and a resolved UE engine root. */
  enabled: boolean;
  /** The compiled-plugin binary is missing → building it is the obvious next step. */
  emphasize: boolean;
  /** zh-TW tooltip / disabled reason. */
  hint: string;
}

// The compile spawns RunUAT BuildPlugin on THIS machine, so it needs a Windows/macOS
// host and a valid engine root; the project / .uplugin paths are not required just to
// build. The button stays available even when the plugin already exists (engine
// upgrades change the ABI and require a rebuild — see CLAUDE.md gotchas), but it is
// only emphasized while the compiled-plugin check is failing.
export function compilePluginAction(env: EnvStatus | null): CompilePluginAction {
  const platformOk = env?.checks?.platform?.ok === true;
  const engineOk = env?.checks?.engine?.ok === true;
  const pluginMissing = env?.checks?.plugin?.ok === false;
  const onMac = env?.platform === 'darwin';
  const enabled = platformOk && engineOk;
  const hint = !platformOk
    ? '需要 Windows 或 macOS 才能編譯插件'
    : !engineOk
      ? '請先在上方填入有效的 UE 引擎根目錄'
      : `用 RunUAT 為 ${onMac ? 'macOS（.dylib）' : 'Windows（.dll）'} 編譯插件二進位`;
  return { enabled, emphasize: pluginMissing, hint };
}
