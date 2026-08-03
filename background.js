/**
 * Background Service Worker
 * Opens the side panel when the extension icon is clicked.
 */

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('sidePanel behavior error:', error));

// Record the true install time once — this is the single source of truth
// for trial start, immune to side-panel re-inits or storage clears elsewhere.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({ license_install_date: Date.now() });
  }
});

// Enable side panel for all supported chat platforms
const SUPPORTED_HOSTS = [
  'notebooklm.google.com',
  'chatgpt.com',
  'claude.ai',
];

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!tab.url) return;
  const enabled = SUPPORTED_HOSTS.some((host) => tab.url.includes(host));
  chrome.sidePanel.setOptions({ tabId, enabled, path: 'sidepanel.html' });
});
