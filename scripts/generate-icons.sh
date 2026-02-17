#!/usr/bin/env bash
# generate-icons.sh — Regenerate macOS icon assets from source PNGs
#
# Usage:  ./scripts/generate-icons.sh
#
# Requires: sips, iconutil (ships with macOS)
# Optional: xcrun actool (requires full Xcode for Asset Catalog compilation)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ASSETS="$PROJECT_DIR/assets"
SRC="$PROJECT_DIR/MacIcons/SYNTHEZERICONMAC Exports"
DEFAULT_ICON="$SRC/SYNTHEZERICONMAC-iOS-Default-1024x1024@1x.png"

if [ ! -f "$DEFAULT_ICON" ]; then
  echo "ERROR: Source icon not found at: $DEFAULT_ICON"
  exit 1
fi

echo "==> Generating icon.png (1024x1024)..."
cp "$DEFAULT_ICON" "$ASSETS/icon.png"

echo "==> Generating icon-256.png (256x256)..."
sips -z 256 256 "$DEFAULT_ICON" --out "$ASSETS/icon-256.png" >/dev/null

echo "==> Generating .iconset..."
ICONSET="$ASSETS/AppIcon.iconset"
mkdir -p "$ICONSET"
sips -z   16   16 "$DEFAULT_ICON" --out "$ICONSET/icon_16x16.png"      >/dev/null
sips -z   32   32 "$DEFAULT_ICON" --out "$ICONSET/icon_16x16@2x.png"   >/dev/null
sips -z   32   32 "$DEFAULT_ICON" --out "$ICONSET/icon_32x32.png"      >/dev/null
sips -z   64   64 "$DEFAULT_ICON" --out "$ICONSET/icon_32x32@2x.png"   >/dev/null
sips -z  128  128 "$DEFAULT_ICON" --out "$ICONSET/icon_128x128.png"    >/dev/null
sips -z  256  256 "$DEFAULT_ICON" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z  256  256 "$DEFAULT_ICON" --out "$ICONSET/icon_256x256.png"    >/dev/null
sips -z  512  512 "$DEFAULT_ICON" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z  512  512 "$DEFAULT_ICON" --out "$ICONSET/icon_512x512.png"    >/dev/null
sips -z 1024 1024 "$DEFAULT_ICON" --out "$ICONSET/icon_512x512@2x.png" >/dev/null

echo "==> Converting .iconset -> icon.icns..."
iconutil -c icns "$ICONSET" -o "$ASSETS/icon.icns"
rm -rf "$ICONSET"

echo "==> Copying icon variants to assets/..."
cp "$SRC/SYNTHEZERICONMAC-iOS-Default-1024x1024@1x.png"     "$ASSETS/icon-default.png"
cp "$SRC/SYNTHEZERICONMAC-iOS-Dark-1024x1024@1x.png"        "$ASSETS/icon-dark.png"
cp "$SRC/SYNTHEZERICONMAC-iOS-ClearLight-1024x1024@1x.png"  "$ASSETS/icon-clear-light.png"
cp "$SRC/SYNTHEZERICONMAC-iOS-ClearDark-1024x1024@1x.png"   "$ASSETS/icon-clear-dark.png"
cp "$SRC/SYNTHEZERICONMAC-iOS-TintedLight-1024x1024@1x.png" "$ASSETS/icon-tinted-light.png"
cp "$SRC/SYNTHEZERICONMAC-iOS-TintedDark-1024x1024@1x.png"  "$ASSETS/icon-tinted-dark.png"

echo "==> Updating Asset Catalog images..."
APPICONSET="$ASSETS/AppIcon.xcassets/AppIcon.appiconset"
mkdir -p "$APPICONSET"
cp "$SRC/SYNTHEZERICONMAC-iOS-Default-1024x1024@1x.png"    "$APPICONSET/icon-mac-any-1024.png"
cp "$SRC/SYNTHEZERICONMAC-iOS-Dark-1024x1024@1x.png"       "$APPICONSET/icon-mac-dark-1024.png"
cp "$SRC/SYNTHEZERICONMAC-iOS-TintedDark-1024x1024@1x.png" "$APPICONSET/icon-mac-tinted-1024.png"
sips -z 512 512 "$SRC/SYNTHEZERICONMAC-iOS-Default-1024x1024@1x.png"    --out "$APPICONSET/icon-mac-any-512.png"     >/dev/null
sips -z 512 512 "$SRC/SYNTHEZERICONMAC-iOS-Dark-1024x1024@1x.png"       --out "$APPICONSET/icon-mac-dark-512.png"    >/dev/null
sips -z 512 512 "$SRC/SYNTHEZERICONMAC-iOS-TintedDark-1024x1024@1x.png" --out "$APPICONSET/icon-mac-tinted-512.png"  >/dev/null

# Compile Asset Catalog if actool is available (requires full Xcode)
if xcrun --find actool >/dev/null 2>&1; then
  echo "==> Compiling Asset Catalog with actool..."
  xcrun actool \
    --compile "$ASSETS" \
    --platform macosx \
    --minimum-deployment-target 11.0 \
    --app-icon AppIcon \
    --output-partial-info-plist "$ASSETS/AssetCatalog-Info.plist" \
    "$ASSETS/AppIcon.xcassets"
  echo "    Assets.car compiled successfully"
else
  echo "==> NOTICE: actool not found (requires full Xcode installation)."
  echo "   The Asset Catalog structure has been created but not compiled."
  echo "   Install Xcode.app for dark mode + tinted icon support in production builds."
  echo "   The standard icon.icns will be used as the app icon."
fi

echo ""
echo "Done! Generated:"
echo "  - assets/icon.png         (1024x1024, Default)"
echo "  - assets/icon-256.png     (256x256, Default)"
echo "  - assets/icon.icns        (all sizes, Default)"
echo "  - assets/icon-default.png (1024x1024, Any appearance)"
echo "  - assets/icon-dark.png    (1024x1024, Dark appearance)"
echo "  - assets/icon-clear-light.png  (1024x1024, Clear Light)"
echo "  - assets/icon-clear-dark.png   (1024x1024, Clear Dark)"
echo "  - assets/icon-tinted-light.png (1024x1024, Tinted Light)"
echo "  - assets/icon-tinted-dark.png  (1024x1024, Tinted Dark)"
echo "  - assets/AppIcon.xcassets/     (Asset Catalog: Any + Dark + Tinted)"
