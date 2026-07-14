// build/notarize.cjs — electron-builder `afterSign` hook.
//
// Submits the freshly-signed .app to Apple's notary service, but ONLY when Developer ID credentials
// are present in the environment; otherwise it skips cleanly so a local (unsigned) build still
// completes. To notarize you need a paid Apple Developer Program membership (a Developer ID
// Application certificate in your keychain) plus, in the environment:
//   APPLE_ID                       your Apple ID email
//   APPLE_APP_SPECIFIC_PASSWORD    an app-specific password (appleid.apple.com)
//   APPLE_TEAM_ID                  your 10-char Apple Developer Team ID

const { notarize } = require("@electron/notarize");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log("[notarize] skipped — set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID to notarize.");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  console.log(`[notarize] submitting ${appName}.app to Apple — this can take a few minutes…`);
  await notarize({
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log("[notarize] done — the app is notarized and stapled.");
};
