/**
 * after-pack.cjs: electron-builder hook, run after the app is assembled and before it is signed.
 *
 * codesign refuses a bundle carrying Finder metadata or resource forks ("resource fork, Finder
 * information, or similar detritus not allowed"). A checkout inside an iCloud-synced folder picks those
 * attributes up on every file, so they are cleared from the packed app on macOS before signing.
 */

const { execFileSync } = require('node:child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  execFileSync('/usr/bin/xattr', ['-cr', context.appOutDir]);
};
