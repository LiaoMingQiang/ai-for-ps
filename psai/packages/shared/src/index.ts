/** @psai/shared —— 插件与 Helper 共用的契约层。
 *  这里的每个模块都是单一事实源，两侧不得各自复制一份。 */

export * from './errors.js';
export * from './params.js';
export * from './paramspec.js';
export * from './prompts.js';
export * from './catalog.js';
export * from './job.js';
export * from './providers.js';
export * from './workflow.js';
export * from './settings.js';

/** 产品版本（插件与 Helper 必须一致，否则报 HELPER_VERSION_MISMATCH）。 */
export const PSAI_VERSION = '1.0.0';
/** SQLite schema 版本。 */
export const PSAI_SCHEMA_VERSION = 1;
/** Helper 默认监听端口。 */
export const HELPER_DEFAULT_PORT = 34117;
