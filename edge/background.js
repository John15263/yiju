// Clicking the toolbar icon opens 一句 in the side panel. Text selected on any page can be sent there with the
// right-click menu: the panel opens and takes it as a new idea to practise. Nothing on the page is read otherwise.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'practise', title: chrome.i18n.getMessage('contextTitle'), contexts: ['selection'] }, () => void chrome.runtime.lastError);
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'practise' || !info.selectionText?.trim()) return;
  // Opening the panel has to happen while the click still counts, so it goes first; the panel then picks up the text.
  if (tab?.windowId !== undefined) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  void chrome.storage.session.set({ source: { text: info.selectionText.slice(0, 20000), at: Date.now() } });
});
