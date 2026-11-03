'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { build, Platform, Arch } = require('electron-builder');
const root = path.resolve(__dirname, '..');

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows 安装包请在 Windows 上构建。');
  const app = path.join(root, 'release', 'QMX-Notebook-win32-x64');
  if (!fs.existsSync(path.join(app, 'QMX-Notebook.exe'))) throw new Error('请先运行 pnpm package。');
  const files = await build({
    prepackaged: app,
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    config: {
      appId: 'org.qmx.acm.notebook',
      productName: 'QMX Notebook',
      executableName: 'QMX-Notebook',
      artifactName: 'QMX-Notebook-Setup-${version}.${ext}',
      directories: { output: path.join(root, 'release', 'installer') },
      win: { target: ['nsis'], signAndEditExecutable: false },
      nsis: {
        oneClick: false,
        perMachine: false,
        allowElevation: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: '拾题 QMX Notebook',
        runAfterFinish: true,
        deleteAppDataOnUninstall: false,
        installerLanguages: ['zh_CN', 'en_US'],
        language: '2052'
      }
    }
  });
  console.log('Installer output:', files.join('\n'));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
