// Chirographum never talks to the network: no internet, no local network,
// no update checks, no telemetry. This module decides which URLs the app
// itself may load (its own files) and blocks everything else.

"use strict";

const LOCAL_SCHEMES = new Set(["file:", "data:", "blob:", "devtools:", "chrome-extension:"]);

/**
 * @param {string} rawUrl URL the app is about to request.
 * @param {string | undefined} devServerUrl Vite dev server URL, only set while developing.
 * @returns {boolean} true when the request stays inside the app.
 */
function isAllowedUrl(rawUrl, devServerUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (LOCAL_SCHEMES.has(url.protocol)) return true;
  if (devServerUrl) {
    const dev = new URL(devServerUrl);
    const sameHost = url.hostname === dev.hostname && url.port === dev.port;
    const devProtocol = url.protocol === "http:" || url.protocol === "ws:";
    if (sameHost && devProtocol) return true;
  }
  return false;
}

/**
 * Installs every guard on an Electron session and its windows.
 * @param {import("electron").Session} session
 * @param {string | undefined} devServerUrl
 */
function installNetworkGuard(session, devServerUrl) {
  session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedUrl(details.url, devServerUrl);
    if (!allowed) console.warn(`[network-guard] blocked ${details.url}`);
    callback({ cancel: !allowed });
  });
  // No camera, microphone, geolocation, notifications... nothing.
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  // Spellcheck dictionaries would be downloaded from the internet; they will
  // ship inside the app in a later phase.
  session.setSpellCheckerEnabled(false);
}

/**
 * Prevents a window from navigating away or opening new windows.
 * @param {import("electron").WebContents} contents
 * @param {string | undefined} devServerUrl
 */
function lockNavigation(contents, devServerUrl) {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!isAllowedUrl(url, devServerUrl)) event.preventDefault();
  });
}

module.exports = { isAllowedUrl, installNetworkGuard, lockNavigation };
