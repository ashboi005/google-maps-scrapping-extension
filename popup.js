// popup.js — Extension popup logic & messaging

(function () {
  'use strict';

  // ── DOM Elements ──────────────────────────────────────────────
  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  const btnReset = document.getElementById('btnReset');
  const btnCSV = document.getElementById('btnCSV');
  const btnExcel = document.getElementById('btnExcel');
  const btnJSON = document.getElementById('btnJSON');
  const countEl = document.getElementById('count');
  const statusText = document.getElementById('statusText');
  const progressInfo = document.getElementById('progressInfo');
  const warningEl = document.getElementById('warning');

  let isRunning = false;

  // ── Helpers ───────────────────────────────────────────────────
  function showWarning(message) {
    warningEl.textContent = message;
    warningEl.classList.add('show');
    setTimeout(() => warningEl.classList.remove('show'), 5000);
  }

  function updateResetButton(hasData) {
    if (btnReset) {
      if (hasData && !isRunning) {
        btnReset.classList.remove('hidden');
      } else {
        btnReset.classList.add('hidden');
      }
    }
  }

  function setRunningState(running) {
    isRunning = running;
    btnStart.classList.toggle('hidden', running);
    btnStop.classList.toggle('hidden', !running);
    statusText.textContent = running ? 'Scraping in progress…' : 'Ready to scrape';
    
    // Hide reset while running
    if (running) {
      if (btnReset) btnReset.classList.add('hidden');
    } else {
        // If stopped, check if we have data to show reset button
        const count = parseInt(countEl.textContent, 10);
        updateResetButton(count > 0);
    }
  }

  function enableExportButtons(hasData) {    
    btnCSV.disabled = !hasData;
    btnExcel.disabled = !hasData;
    btnJSON.disabled = !hasData;
    
    // Also update reset button visibility if not running
    if (!isRunning) {
        updateResetButton(hasData);
    }
  }

  // ── Get the active Google Maps tab ────────────────────────────
  async function getActiveMapTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes('google.com/maps')) {
      showWarning('Please navigate to Google Maps first.');
      return null;
    }
    return tab;
  }

  // ── Send message to content script ────────────────────────────
  async function sendToContent(tab, message) {
    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (error) {
      console.error('Message send failed:', error);
      // Try injecting the content script first
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        // Retry after injection
        return await chrome.tabs.sendMessage(tab.id, message);
      } catch (injectErr) {
        console.error('Script injection failed:', injectErr);
        showWarning('Cannot connect to page. Refresh Google Maps and try again.');
        return null;
      }
    }
  }

  // ── Button Handlers ───────────────────────────────────────────

  btnStart.addEventListener('click', async () => {
    const tab = await getActiveMapTab();
    if (!tab) return;

    // First check if there's existing data and warn/clear implicitly?
    // Current behavior: Appends. 
    // We update UI:
    setRunningState(true);
    // don't clear countEl yet, wait for update
    progressInfo.textContent = 'Starting...';
    enableExportButtons(false);
    updateResetButton(false);

    const response = await sendToContent(tab, { action: 'startScraping' });
    if (!response || response.status === 'error') {
      setRunningState(false);
      showWarning(response?.message || 'Failed to start scraping.');
    }
  });

  btnStop.addEventListener('click', async () => {
    const tab = await getActiveMapTab();
    if (!tab) return;
    
    // Stop content script
    await sendToContent(tab, { action: 'stopScraping' });
    setRunningState(false);
    
    // Show reset button since we have stopped
    const response = await sendToContent(tab, { action: 'getStatus' });
    if (response && response.count > 0) {
      updateResetButton(true);
    }
  });

  if (btnReset) {
    btnReset.addEventListener('click', async () => {
      const tab = await getActiveMapTab();
      if (!tab) return;
  
      await sendToContent(tab, { action: 'resetData' });
      countEl.textContent = '0';
      progressInfo.textContent = '';
      enableExportButtons(false);
      updateResetButton(false);
      statusText.textContent = 'Ready to scrape';
    });
  }

  btnCSV.addEventListener('click', async () => {
    const tab = await getActiveMapTab();
    if (!tab) return;
    await sendToContent(tab, { action: 'export', format: 'csv' });
  });

  btnExcel.addEventListener('click', async () => {
    const tab = await getActiveMapTab();
    if (!tab) return;
    await sendToContent(tab, { action: 'export', format: 'excel' });
  });

  btnJSON.addEventListener('click', async () => {
    const tab = await getActiveMapTab();
    if (!tab) return;
    await sendToContent(tab, { action: 'export', format: 'json' });
  });

  // ── Listen for messages from content script ───────────────────
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
      case 'updateCount':
        countEl.textContent = request.count;
        enableExportButtons(request.count > 0);
        break;

      case 'updateProgress':
        progressInfo.textContent = request.message || '';
        break;

      case 'scrapingComplete':
        setRunningState(false);
        statusText.textContent = `Done — ${request.count} places scraped`;
        countEl.textContent = request.count;
        enableExportButtons(request.count > 0);
        updateResetButton(request.count > 0);
        break;

      case 'scrapingError':
        setRunningState(false);
        showWarning(request.message || 'An error occurred.');
        updateResetButton(parseInt(countEl.textContent || '0') > 0);
        break;
    }
  });

  // ── On popup open, ask content script for current state ───────
  (async () => {
    const tab = await getActiveMapTab();
    if (!tab) return;

    const response = await sendToContent(tab, { action: 'getStatus' });
    if (response) {
      countEl.textContent = response.count || 0;
      const hasData = (response.count || 0) > 0;
      enableExportButtons(hasData);

      if (response.isRunning) {
        setRunningState(true);
      } else {
        updateResetButton(hasData);
      }
    }
  })();
})();
