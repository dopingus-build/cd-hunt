/**
 * @fileoverview Static deployment configuration for Disk Crate optional cloud sync.
 * Attaches configuration to window.DiskCrate.config (legacy alias window.CDHunt.config) and exports via CommonJS for Node tests.
 */
(function (root) {
  'use strict';

  const config = {
    syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev'
  };

  if (root) {
    root.DiskCrate = root.DiskCrate || root.CDHunt || {};
    root.DiskCrate.config = config;
    root.CDHunt = root.DiskCrate;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = config;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
