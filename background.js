/**
 * Background Service Worker
 * Opens the side panel when the extension icon is clicked.
 */

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('sidePanel behavior error:', error));

// Enable side panel only for NotebookLM tabs
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!tab.url) return;
  const enabled = tab.url.includes('notebooklm.google.com');
  chrome.sidePanel.setOptions({ tabId, enabled, path: 'sidepanel.html' });
});
