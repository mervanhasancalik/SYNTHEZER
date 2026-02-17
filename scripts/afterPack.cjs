/**
 * afterPack.cjs — electron-builder afterPack hook
 *
 * Injects the compiled Asset Catalog (Assets.car) into the macOS .app bundle
 * for dark mode + tinted icon support (macOS Sequoia / macOS 15+).
 *
 * If Assets.car exists (compiled via scripts/generate-icons.sh with Xcode),
 * it is copied into Contents/Resources/ and CFBundleIconName is set in Info.plist.
 *
 * If Assets.car doesn't exist, the standard icon.icns is used (no dark mode icons).
 */
const fs = require('fs');
const path = require('path');
const plist = require('plist');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  const resourcesDir = path.join(appPath, 'Contents', 'Resources');
  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');

  const assetsCar = path.join(__dirname, '..', 'assets', 'Assets.car');

  if (!fs.existsSync(assetsCar)) {
    console.log('[afterPack] No Assets.car found — using standard icon.icns');
    console.log('[afterPack] Run: ./scripts/generate-icons.sh (with Xcode) to enable dark mode icons');
    return;
  }

  console.log('[afterPack] Injecting Assets.car for dark mode + tinted icon support...');

  // Copy Assets.car into the app bundle
  fs.copyFileSync(assetsCar, path.join(resourcesDir, 'Assets.car'));

  // Update Info.plist to reference the Asset Catalog icon
  if (fs.existsSync(infoPlistPath)) {
    const plistContent = fs.readFileSync(infoPlistPath, 'utf-8');
    const plistObj = plist.parse(plistContent);

    // CFBundleIconName tells macOS to look in the Asset Catalog for the icon
    plistObj['CFBundleIconName'] = 'AppIcon';

    // Keep CFBundleIconFile as fallback for older macOS versions
    // (electron-builder already sets this to the .icns file)

    fs.writeFileSync(infoPlistPath, plist.build(plistObj), 'utf-8');
    console.log('[afterPack] Updated Info.plist with CFBundleIconName = AppIcon');
  }

  console.log('[afterPack] Dark mode + tinted icon support injected successfully');
};
