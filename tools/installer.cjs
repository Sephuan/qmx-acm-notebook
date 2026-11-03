'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { build, Platform, Arch } = require('electron-builder');
const root = path.resolve(__dirname, '..');

async function main() {
  const platform = process.env.QMX_PLATFORM || process.platform;
  const arch = process.env.QMX_ARCH || process.arch;
  if (!['win32', 'linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported build platform or architecture');
  if (platform !== process.platform) throw new Error('安装包请在目标平台构建；跨平台目录打包可使用 pnpm package。');
  const app = path.join(root, 'release', `QMX-Notebook-${platform}-${arch}`);
  const executable = platform === 'darwin' ? path.join('QMX-Notebook.app', 'Contents', 'MacOS', 'QMX-Notebook') : platform === 'win32' ? 'QMX-Notebook.exe' : 'QMX-Notebook';
  if (!fs.existsSync(path.join(app, executable))) throw new Error('请先运行 pnpm package。');
  if (platform !== 'win32') {
    const target = platform === 'darwin' ? Platform.MAC : Platform.LINUX;
    const files = await build({ prepackaged: platform === 'darwin' ? path.join(app, 'QMX-Notebook.app') : app,
      targets: target.createTarget(platform === 'darwin' ? ['dmg', 'zip'] : ['tar.gz'], arch === 'arm64' ? Arch.arm64 : Arch.x64),
      config: { appId: 'org.qmx.acm.notebook', productName: 'QMX Notebook', executableName: 'QMX-Notebook',
        artifactName: 'QMX-Notebook-${version}-${os}-${arch}.${ext}', directories: { output: path.join(root, 'release', 'installer') },
        mac: { category: 'public.app-category.education', identity: null }, linux: { category: 'Education', executableName: 'QMX-Notebook' } }
    });
    console.log('Package output:', files.join('\n')); return;
  }
  const files = await build({
    prepackaged: app,
    targets: Platform.WINDOWS.createTarget(['nsis'], arch === 'arm64' ? Arch.arm64 : Arch.x64),
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
