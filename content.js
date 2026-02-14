// content.js — Google Maps Scraper (injected into Google Maps pages)

(function () {
  'use strict';

  // Prevent double-injection
  if (window.__gmapsScraper) return;
  window.__gmapsScraper = true;

  // ═══════════════════════════════════════════════════════════════
  //  GOOGLE MAPS SCRAPER CLASS
  // ═══════════════════════════════════════════════════════════════

  class GoogleMapsScraper {
    constructor() {
      this.scrapedData = [];
      this.scrapedUrls = new Set();
      this.isRunning = false;
      this.CLICK_DELAY = 100;         // Faster click cycle
      this.SCROLL_WAIT = 1500;        // Slightly faster scroll wait
      this.DETAIL_TIMEOUT = 3000;     // Faster timeout for detail panel
      this.MAX_SCROLL_FAILS = 3;      // consecutive scroll fails before stopping
    }

    // ── Utility helpers ───────────────────────────────────────────

    wait(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    log(message) {
      console.log(`[Maps Scraper] ${message}`);
    }

    sendCount() {
      try {
        chrome.runtime.sendMessage({
          action: 'updateCount',
          count: this.scrapedData.length
        });
      } catch (_) { /* popup may be closed */ }
    }

    sendProgress(message) {
      try {
        chrome.runtime.sendMessage({ action: 'updateProgress', message });
      } catch (_) { /* popup may be closed */ }
    }

    sendComplete() {
      try {
        chrome.runtime.sendMessage({
          action: 'scrapingComplete',
          count: this.scrapedData.length
        });
      } catch (_) { /* popup may be closed */ }
    }

    sendError(message) {
      try {
        chrome.runtime.sendMessage({ action: 'scrapingError', message });
      } catch (_) { /* popup may be closed */ }
    }

    // ── Feed & card selectors ─────────────────────────────────────

    getFeedContainer() {
      return document.querySelector('div[role="feed"]');
    }

    getCards() {
      const feed = this.getFeedContainer();
      if (!feed) return [];
      return Array.from(feed.querySelectorAll('a[href*="/maps/place/"]'));
    }

    // ── Wait for the detail panel to fully load ───────────────────

    waitForDetailPanel(previousName = '') {
      return new Promise(resolve => {
        let elapsed = 0;
        const interval = 100;

        const check = setInterval(() => {
          elapsed += interval;

          // Find specific elements that only exist in the detail view
          // Updated to include hotel-specific class .DUwDvf and others
          const possibleH1s = Array.from(document.querySelectorAll('h1.fontHeadlineLarge, h1.DUwDvf, h1.kpih0e, h1.uvopNe, div[role="main"] h1'));
          const detailH1 = possibleH1s.find(h1 => {
            const text = h1.textContent.trim();
            // VALIDATION:
            // 1. Must be non-empty
            // 2. Must not be "Results" or "Google Maps"
            // 3. Must be DIFFERENT from the previous place name (unless it's the very first scrape)
            return text.length > 0 && 
                   text !== "Results" && 
                   text !== "Google Maps" &&
                   text !== previousName;
          });
          
          const hasActionButtons = document.querySelector('button[data-item-id]');
          const hasTabs = document.querySelector('div[role="tablist"]');
          const hasHotelClass = document.querySelector('.DUwDvf'); // Extra check for hotel header existence

          if (detailH1 && (hasActionButtons || hasTabs || hasHotelClass)) {
            clearInterval(check);
            resolve(true);
          }

          if (elapsed >= this.DETAIL_TIMEOUT) {
            clearInterval(check);
            resolve(!!detailH1);
          }
        }, interval);
      });
    }

    // ── Data extraction from the open detail panel ────────────────

    getUniqueUrl(url) {
      if (!url) return '';
      // Strip query parameters to use as unique ID
      return url.split('?')[0]; 
    }

    extractName() {
      // Updated to include hotel-specific class .DUwDvf
      // Also added .kpih0e and .uvopNe based on specific hotel HTML structure
      const possibleH1s = Array.from(document.querySelectorAll('h1.fontHeadlineLarge, h1.DUwDvf, h1.kpih0e, h1.uvopNe, div[role="main"] h1'));
      
      // Filter out common UI headers
      const validH1 = possibleH1s.find(h1 => {
        const text = h1.textContent.trim();
        return text.length > 0 && 
               text !== "Results" && 
               text !== "Google Maps" &&
               !text.includes("found"); // e.g. "No results found"
      });
      
      if (validH1) return validH1.textContent.trim();
      
      // Fallback: aria-label of the main content region sometimes has the name
      const mainRegion = document.querySelector('div[role="main"]');
      if (mainRegion) {
        const label = mainRegion.getAttribute('aria-label');
        if (label && label !== "Results" && label !== "Google Maps") {
          return label;
        }
      }

      return ''; 
    }

    extractPhone() {
      let phone = '';

      // Method 1: button with data-item-id containing "phone"
      const phoneBtn = document.querySelector('button[data-item-id*="phone"]');
      if (phoneBtn) {
        const label = phoneBtn.getAttribute('aria-label') || '';
        phone = label.replace(/^Phone:\s*/i, '').trim() || phoneBtn.textContent.trim();
      }

      // Method 2: button whose aria-label starts with "Phone"
      if (!phone) {
        const byLabel = document.querySelector('button[aria-label^="Phone"]');
        if (byLabel) {
          phone = byLabel.getAttribute('aria-label').replace(/^Phone:\s*/i, '').trim();
        }
      }

      // Method 3: scan all buttons for a phone-number pattern
      if (!phone) {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
          const text = (btn.textContent || '') + ' ' + (btn.getAttribute('aria-label') || '');
          const match = text.match(/[\+\(]?\d[\d\s\-\(\)]{6,}/);
          if (match) {
            phone = match[0].trim();
            break;
          }
        }
      }

      return this.cleanPhone(phone);
    }

    extractPhoneFromCard(card) {
      // Some categories (dentists, etc.) show phone right on the list card
      try {
        const container = card.closest('[data-result-index]') || card.parentElement;
        if (!container) return '';

        const spans = container.querySelectorAll('span');
        for (const span of spans) {
          const text = span.textContent.trim();
          if (/[\+\(]?\d[\d\s\-\(\)]{6,}/.test(text)) {
            return this.cleanPhone(text);
          }
        }

        const ariaPhoneEl = container.querySelector('[aria-label*="Phone"]');
        if (ariaPhoneEl) {
          return this.cleanPhone(
            ariaPhoneEl.getAttribute('aria-label').replace(/^Phone:\s*/i, '')
          );
        }
      } catch (_) { /* ignore */ }

      return '';
    }

    cleanPhone(text) {
      if (!text) return '';
      const match = text.match(/[\+\(]?[\d\s\-\(\)\.]{7,}/);
      return match ? match[0].replace(/[\s\-\.]+$/g, '').trim() : '';
    }

    extractWebsite() {
      // Method 1: link with data-item-id="authority"
      const authorityLink = document.querySelector('a[data-item-id="authority"]') ||
                            document.querySelector('a[data-item-id*="authority"]');
      if (authorityLink) {
        return authorityLink.href || authorityLink.getAttribute('href') || '';
      }

      // Method 2: button with data-item-id="authority"
      const authorityBtn = document.querySelector('button[data-item-id="authority"]') ||
                           document.querySelector('button[data-item-id*="authority"]');
      if (authorityBtn) {
        const label = authorityBtn.getAttribute('aria-label') || '';
        const urlMatch = label.match(/https?:\/\/[^\s]+/);
        return urlMatch ? urlMatch[0] : label.replace(/^Website:\s*/i, '').trim();
      }

      // Method 3: scan action buttons area for an external link
      const actionArea = document.querySelector('div[role="main"]');
      if (actionArea) {
        const links = actionArea.querySelectorAll('a[href]');
        for (const link of links) {
          const href = link.href;
          if (href && !href.includes('google.com') &&
              !href.includes('gstatic.com') &&
              href.startsWith('http')) {
            return href;
          }
        }
      }

      return '';
    }

    extractAddress() {
      const addressBtn = document.querySelector('button[data-item-id="address"]') ||
                         document.querySelector('button[data-item-id*="address"]');
      if (addressBtn) {
        const label = addressBtn.getAttribute('aria-label') || '';
        return label.replace(/^Address:\s*/i, '').trim() || addressBtn.textContent.trim();
      }
      return '';
    }

    extractRating() {
      // aria-label like "4.5 stars 123 Reviews"
      const ratingEl = document.querySelector('div[role="img"][aria-label*="star"]') ||
                       document.querySelector('span[role="img"][aria-label*="star"]');
      if (ratingEl) {
        const label = ratingEl.getAttribute('aria-label') || '';
        const match = label.match(/([\d.]+)\s*star/i);
        return match ? match[1] : '';
      }

      // Fallback: look for rating span near review count
      const ratingSpan = document.querySelector('span[aria-hidden="true"]');
      if (ratingSpan) {
        const text = ratingSpan.textContent.trim();
        if (/^\d\.\d$/.test(text)) return text;
      }

      return '';
    }

    extractReviews() {
      const ratingEl = document.querySelector('div[role="img"][aria-label*="star"]') ||
                       document.querySelector('span[role="img"][aria-label*="star"]');
      if (ratingEl) {
        const label = ratingEl.getAttribute('aria-label') || '';
        const match = label.match(/([\d,]+)\s*review/i);
        if (match) return match[1].replace(/,/g, '');
      }

      // Fallback: look for parenthesized number near rating
      const spans = Array.from(document.querySelectorAll('span[aria-label*="reviews"]'));
      for (const span of spans) {
         const label = span.getAttribute('aria-label');
         const match = label.match(/([\d,]+)\s*reviews/);
         if (match) return match[1].replace(/,/g, '');
      }
      
      // Fallback 2: look for parenthesized number in text
      const allSpans = document.querySelectorAll('span');
      for (const span of allSpans) {
        const text = span.textContent.trim();
        const match = text.match(/^\(?([\d,]+)\)?$/);
        if (match && parseInt(match[1].replace(/,/g, '')) > 0 ) {
           // Ensure it's not a year or price by checking context if possible
           // But generally (230) is likely reviews if near rating
           return match[1].replace(/,/g, '');
        }
      }

      return '';
    }

    extractCategory() {
      // Category usually appears as a button or span near the name
      const categoryBtn = document.querySelector('button[jsaction*="category"]');
      if (categoryBtn) return categoryBtn.textContent.trim();
      
      // Fallback: Hotel star rating sometimes looks like category "5-star hotel"
      const hotelStars = document.querySelector('span[aria-label*="-star hotel"]');
      if (hotelStars) return hotelStars.textContent.trim();

      // Sometimes shown as a span right after the rating row
      // We look for the detail panel container if role="main" is missing
      const infoArea = document.querySelector('div[role="main"]') || document.querySelector('.m6QErb[aria-label]');
      if (infoArea) {
        const spans = infoArea.querySelectorAll('span');
        for (const span of spans) {
          const text = span.textContent.trim();
          // Category patterns: "Dentist", "Hotel", "Italian restaurant", etc.
          if (text.length > 2 && text.length < 60 &&
              !text.includes('star') && !text.includes('review') &&
              !/^\d/.test(text) && !text.includes('Open') &&
              !text.includes('Closed') && !text.includes('·')) {
            // Heuristic: categories are short words
            if (/^[A-Z]/.test(text) && text.split(' ').length <= 4) {
              return text;
            }
          }
        }
      }

      return '';
    }

    // ── Full extraction for one place ─────────────────────────────

    extractAllData() {
      return {
        name: this.extractName(),
        phone: this.extractPhone(),
        website: this.extractWebsite(),
        address: this.extractAddress(),
        rating: this.extractRating(),
        reviews: this.extractReviews(),
      };
    }

    // ── Scrape a single card ──────────────────────────────────────

    async scrapeCard(card) {
      const rawUrl = card.href;
      const uniqueUrl = this.getUniqueUrl(rawUrl);

      // Dedup check using the clean URL
      if (this.scrapedUrls.has(uniqueUrl)) {
        return false;
      }

      // Capture the CURRENT name displayed in the panel (if any)
      // We will wait for the name to CHANGE from this value
      const previousName = this.extractName();

      // Try extracting phone from the outer card first (backup)
      const outerPhone = this.extractPhoneFromCard(card);

      // Click the card to open detail panel
      card.click();

      // Wait for detail panel content to change
      const loaded = await this.waitForDetailPanel(previousName);
      if (!loaded) {
        this.log(`Detail panel did not load or update for: ${uniqueUrl}`);
      }

      // Small extra wait for any trailing DOM mutations
      await this.wait(500); // Increased wait time for hotel details to populate

      // Check if we actually got new data
      const currentName = this.extractName();
      if (currentName === previousName && previousName !== '') {
          this.log(`Duplicate content detected (Name did not change from '${previousName}'). Skipping.`);
          return false;
      }

      // Extract data
      const data = this.extractAllData();

      // Use outer-card phone if detail panel didn't have one
      if (!data.phone && outerPhone) {
        data.phone = outerPhone;
      }

      // Only store if we got at least a name
      if (data.name) {
        data.url = rawUrl; // Store the original full URL
        data.scrapedAt = new Date().toISOString();
        
        this.scrapedData.push(data);
        this.scrapedUrls.add(uniqueUrl); // Mark this clean URL as done
        
        this.log(`Scraped: ${data.name} | Phone: ${data.phone || '—'} | Website: ${data.website || '—'}`);
        this.sendCount();
        return true;
      }

      return false;
    }

    // ── Auto-scroll the feed ──────────────────────────────────────

    async scrollFeed(feed) {
      feed.scrollTop = feed.scrollHeight;
      await this.wait(this.SCROLL_WAIT);
    }

    // ── Check for "end of results" indicator ──────────────────────

    hasReachedEnd() {
      // Google Maps shows a message or divider at the bottom when results are exhausted
      const endEl = document.querySelector('p > span > span');
      if (endEl && /you.ve reached the end/i.test(endEl.textContent)) return true;

      const endAlt = document.querySelector('div.m6QErb span');
      if (endAlt && /you.ve reached the end/i.test(endAlt.textContent)) return true;

      return false;
    }

    // ── Main scraping loop ────────────────────────────────────────

    async start() {
      if (this.isRunning) {
        this.log('Already running');
        return;
      }

      const feed = this.getFeedContainer();
      if (!feed) {
        this.sendError('No search results found. Please search on Google Maps first.');
        return;
      }

      this.isRunning = true;
      this.log('Scraping started');

      let consecutiveScrollFails = 0;
      let lastProcessedIndex = 0; // Optimization: Resume from last index

      try {
        while (this.isRunning) {
          const cards = this.getCards();
          let newDataThisRound = 0;

          // Safety check: if list shrank (virtualization), reset index
          if (cards.length < lastProcessedIndex) {
            lastProcessedIndex = 0;
          }

          this.sendProgress(`Processing ${cards.length} visible cards…`);

          // Start loop from lastProcessedIndex instead of 0
          for (let i = lastProcessedIndex; i < cards.length; i++) {
            if (!this.isRunning) break;

            // Mark this index as processed for next time
            lastProcessedIndex = i + 1;

            const card = cards[i];
            const uniqueUrl = this.getUniqueUrl(card.href);
            
            if (this.scrapedUrls.has(uniqueUrl)) continue;

            this.sendProgress(`Scraping card ${i + 1} of ${cards.length}…`);

            try {
              const scraped = await this.scrapeCard(card);
              if (scraped) newDataThisRound++;
            } catch (err) {
              this.log(`Error scraping card: ${err.message}`);
            }

            await this.wait(this.CLICK_DELAY);
          }

          // Check end-of-list
          if (this.hasReachedEnd()) {
            this.log('Reached end of results');
            break;
          }

          // Scroll for more
          this.sendProgress('Scrolling for more results…');
          const beforeCount = this.getCards().length;
          await this.scrollFeed(feed);
          const afterCount = this.getCards().length;

          if (afterCount <= beforeCount && newDataThisRound === 0) {
            consecutiveScrollFails++;
            this.log(`No new cards after scroll (attempt ${consecutiveScrollFails}/${this.MAX_SCROLL_FAILS})`);
            if (consecutiveScrollFails >= this.MAX_SCROLL_FAILS) {
              this.log('Max scroll attempts reached, stopping');
              break;
            }
          } else {
            consecutiveScrollFails = 0;
          }
        }
      } catch (err) {
        this.log(`Fatal error: ${err.message}`);
        this.sendError(`Error: ${err.message}`);
      }

      this.isRunning = false;
      this.log(`Scraping complete. Total: ${this.scrapedData.length} places`);
      this.sendComplete();
    }

    stop() {
      this.isRunning = false;
      this.log('Scraping stopped by user');
      this.sendProgress('Stopped by user');
    }

    reset() {
      this.scrapedData = [];
      this.scrapedUrls = new Set();
      this.log('Data reset cleared');
    }

    // ── Export helpers ─────────────────────────────────────────────

    generateCSVContent() {
      const headers = ['Name', 'Phone', 'Website', 'Address', 'Rating', 'Reviews', 'URL'];
      const rows = this.scrapedData.map(d => [
        d.name || '',
        d.phone || '',
        d.website || '',
        d.address || '',
        d.rating || '',
        d.reviews || '',
        d.url || ''
      ]);

      return [headers, ...rows]
        .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
        .join('\n');
    }

    downloadFile(content, filename, mimeType) {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    }

    exportCSV() {
      const csv = this.generateCSVContent();
      this.downloadFile(csv, 'google-maps-data.csv', 'text/csv;charset=utf-8');
      this.log('Exported CSV');
    }

    exportExcelCSV() {
      const csv = this.generateCSVContent();
      const bom = '\uFEFF'; // UTF-8 BOM for Excel
      this.downloadFile(bom + csv, 'google-maps-data-excel.csv', 'text/csv;charset=utf-8');
      this.log('Exported Excel CSV');
    }

    exportJSON() {
      const json = JSON.stringify(this.scrapedData, null, 2);
      this.downloadFile(json, 'google-maps-data.json', 'application/json');
      this.log('Exported JSON');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  SINGLETON INSTANCE
  // ═══════════════════════════════════════════════════════════════

  const scraper = new GoogleMapsScraper();

  // ═══════════════════════════════════════════════════════════════
  //  MESSAGE LISTENER
  // ═══════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {

      case 'startScraping':
        if (scraper.isRunning) {
          sendResponse({ status: 'already_running' });
        } else {
          scraper.start(); // async — runs in background
          sendResponse({ status: 'started' });
        }
        break;

      case 'stopScraping':
        scraper.stop();
        sendResponse({ status: 'stopped', count: scraper.scrapedData.length });
        break;
      
      case 'resetData':
        scraper.reset();
        sendResponse({ status: 'reset', count: 0 });
        break;

      case 'getStatus':
        sendResponse({
          isRunning: scraper.isRunning,
          count: scraper.scrapedData.length
        });
        break;

      case 'export':
        if (scraper.scrapedData.length === 0) {
          sendResponse({ status: 'no_data' });
          break;
        }
        switch (request.format) {
          case 'csv':   scraper.exportCSV();      break;
          case 'excel': scraper.exportExcelCSV();  break;
          case 'json':  scraper.exportJSON();      break;
        }
        sendResponse({ status: 'exported' });
        break;

      default:
        sendResponse({ status: 'unknown_action' });
    }

    // Return true to indicate we'll send a response asynchronously
    // (not strictly needed here since we respond synchronously, but safe)
    return true;
  });

  console.log('[Maps Scraper] Content script loaded and ready');
})();
