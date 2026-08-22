/**
 * UXP 入口。
 *
 * 这里只做一件事：把 manifest 里声明的三个入口注册给宿主，并把面板根节点交给应用层。
 * 入口 id 必须与 manifest.json 完全一致（由 tools/validate-manifest.mjs 校验）。
 */

import { mountMainPanel, mountComfyWebPanel, openSettings, bootPlugin, teardownPlugin } from './app/main.js';

interface UxpEntrypoints {
  setup(config: unknown): void;
}

function getEntrypoints(): UxpEntrypoints | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const uxp = (globalThis as { require?: (m: string) => { entrypoints?: UxpEntrypoints } }).require?.('uxp');
    return uxp?.entrypoints ?? null;
  } catch {
    return null;
  }
}

const entrypoints = getEntrypoints();

if (entrypoints) {
  entrypoints.setup({
    plugin: {
      create(): void {
        void bootPlugin();
      },
      destroy(): void {
        teardownPlugin();
      }
    },
    panels: {
      psaiMain: {
        create(root: HTMLElement): void {
          void mountMainPanel(root);
        }
      },
      psaiComfyWeb: {
        create(root: HTMLElement): void {
          void mountComfyWebPanel(root);
        }
      }
    },
    commands: {
      psaiOpenSettings(): void {
        void openSettings();
      }
    }
  });
} else {
  // 非 Photoshop 环境（例如用浏览器打开 index.html 做样式预览）：直接挂到根节点上。
  const root = document.getElementById('psai-root');
  if (root) void mountMainPanel(root);
}
