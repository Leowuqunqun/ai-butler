/**
 * AI 管家的容器层：配置 → patch 叠加 → 插件解析 → 拉起 cordis 容器。
 *
 * 命令行入口见同目录的 `cli.ts`（`butler` 这个命令）。
 *
 * @module @butler/cli
 */

export {
  parseConfig,
  readConfigFile,
  mergeRows,
  loadConfig,
  ConfigError,
  type PluginRow,
  type ConfigFile,
  type LoadedConfig,
} from './config.js';

export {
  resolveSpecifier,
  importPlugin,
  ResolveError,
  type ResolveContext,
} from './resolve.js';

export { boot, SELF_DIR, type BootOptions, type Booted, type BootFailure } from './boot.js';

export {
  channelSecretNeed,
  injectChannelSecrets,
  readSecrets,
  saveSecret,
  secretOf,
  secretsFileOf,
  type ChannelSecretNeed,
} from './secrets.js';

export {
  askForSecret,
  ensureChannelToken,
  type ChannelTokenOptions,
  type SecretPrompt,
  type SecretPageOptions,
} from './onboarding.js';

export {
  autostartPlan,
  autostartOn,
  autostartOff,
  autostartStatus,
  formatPlan,
  type AutostartOptions,
  type AutostartPlan,
  type CommandRunner,
} from './autostart.js';

export {
  doctor,
  formatDoctor,
  type DoctorCheck,
  type DoctorOptions,
  type DoctorReport,
  type DoctorSlot,
} from './doctor.js';
