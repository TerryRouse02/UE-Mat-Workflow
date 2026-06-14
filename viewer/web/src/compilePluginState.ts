import type { EnvStatus } from '../../server/crawl-types';
import i18n from './i18n';

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
  const platform = onMac ? 'macOS (.dylib)' : 'Windows (.dll)';
  const hint = !platformOk
    ? i18n.t('compilePluginState.hintNeedPlatform')
    : !engineOk
      ? i18n.t('compilePluginState.hintNeedEngine')
      : i18n.t('compilePluginState.hintBuild', { platform });
  return { enabled, emphasize: pluginMissing, hint };
}
