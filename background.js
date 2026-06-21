/**
 * Background Service Worker
 * Opens the side panel when the extension icon is clicked.
 */

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('sidePanel behavior error:', error));

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
