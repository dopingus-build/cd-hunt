/**
 * @fileoverview Static deployment configuration for CD Hunt optional cloud sync.
 * Attaches configuration to window.CDHunt.config and exports via CommonJS for Node tests.
 */
(function (root) {
  'use strict';

  const config = {
    syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev'
  };

  if (root) {
    root.CDHunt = root.CDHunt || {};
    root.CDHunt.config = config;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = config;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
