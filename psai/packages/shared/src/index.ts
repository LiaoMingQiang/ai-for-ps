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
export * from './runninghub.js';
export * from './settings.js';

/**
 * 产品版本（插件与 Helper 必须一致，否则报 HELPER_VERSION_MISMATCH）。
 *
 * 停在 0.9.0：docs/ACCEPTANCE.md 的 62 项真机验收还没在 Photoshop 里跑完。
 * 那份清单自己写着「未跑完不得标 1.0.0」，规矩是自己定的就得自己守。
 * 全部跑通之后再改成 1.0.0。
 */
export const PSAI_VERSION = '0.9.18';
/** SQLite schema 版本。 */
export const PSAI_SCHEMA_VERSION = 1;
/** Helper 默认监听端口。 */
export const HELPER_DEFAULT_PORT = 34117;
