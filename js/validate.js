(function (root) {
  'use strict';

  const META_STRING_FIELDS = [
    'title',
    'subtitle',
    'documentTitle',
    'storagePrefix',
    'searchPlaceholder',
    'digitalSectionTitle',
    'digitalSectionSubtitle'
  ];

  const ITEM_REQUIRED_STRINGS = [
    'id',
    'category',
    'artist',
    'title',
    'catalog',
    'kana',
    'filing'
  ];

  const ITEM_OPTIONAL_STRINGS = [
    'artistJa',
    'titleJa',
    'regCatNo',
    'itunesQuery',
    'accent'
  ];

  const PROHIBITED_DOMAINS = [
    'vgmdb.net',
    'wikia.nocookie.net',
    'fandom.com',
    'cdjapan.co.jp'
  ];

  const VALID_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

  function isPlainObject(val) {
    return val !== null && typeof val === 'object' && !Array.isArray(val);
  }

  function isNonEmptyString(val) {
    return typeof val === 'string' && val.trim().length > 0;
  }

  function collectProhibitedDomainErrors(value, pathPrefix, errors) {
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      for (let i = 0; i < PROHIBITED_DOMAINS.length; i++) {
        const domain = PROHIBITED_DOMAINS[i];
        if (lower.indexOf(domain) !== -1) {
          errors.push(pathPrefix + ' contains prohibited hotlinked domain "' + domain + '"');
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        collectProhibitedDomainErrors(value[i], pathPrefix + '[' + i + ']', errors);
      }
      return;
    }
    if (isPlainObject(value)) {
      const keys = Object.keys(value);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        collectProhibitedDomainErrors(value[key], pathPrefix + '.' + key, errors);
      }
    }
  }

  function validateMeta(meta, errors) {
    if (meta === undefined) return;
    if (!isPlainObject(meta)) {
      errors.push('meta must be a plain object');
      return;
    }

    for (let i = 0; i < META_STRING_FIELDS.length; i++) {
      const field = META_STRING_FIELDS[i];
      if (meta[field] !== undefined && typeof meta[field] !== 'string') {
        errors.push('meta.' + field + ' must be a string');
      }
    }

    if (typeof meta.storagePrefix === 'string' && meta.storagePrefix.trim().length === 0) {
      errors.push('meta.storagePrefix must not be empty or whitespace-only');
    }
  }

  function validateCategories(categories, errors) {
    if (categories === undefined) return null;
    if (!Array.isArray(categories)) {
      errors.push('categories must be an array');
      return null;
    }
    if (categories.length === 0) {
      return null;
    }

    const keys = new Set();
    for (let i = 0; i < categories.length; i++) {
      const cat = categories[i];
      const prefix = 'categories[' + i + ']';
      if (!isPlainObject(cat)) {
        errors.push(prefix + ' must be an object');
        continue;
      }

      for (const field of ['key', 'label', 'dot']) {
        if (!isNonEmptyString(cat[field])) {
          errors.push(prefix + '.' + field + ' must be a non-empty string');
        }
      }

      if (isNonEmptyString(cat.key)) {
        if (keys.has(cat.key)) {
          errors.push('Duplicate category key "' + cat.key + '" at ' + prefix);
        } else {
          keys.add(cat.key);
        }
      }
    }

    if (!keys.has('All')) {
      errors.push('Non-empty categories array must include an entry with key "All"');
    }

    return keys;
  }

  function validateMbEditions(mbEditions, prefix, errors) {
    if (mbEditions === undefined) return;
    if (!Array.isArray(mbEditions)) {
      errors.push(prefix + '.mbEditions must be an array');
      return;
    }

    for (let i = 0; i < mbEditions.length; i++) {
      const ed = mbEditions[i];
      const edPrefix = prefix + '.mbEditions[' + i + ']';
      if (!isPlainObject(ed)) {
        errors.push(edPrefix + ' must be an object');
        continue;
      }
      if (!isNonEmptyString(ed.catno)) {
        errors.push(edPrefix + '.catno must be a non-empty string');
      }
      if (ed.label !== undefined && typeof ed.label !== 'string') {
        errors.push(edPrefix + '.label must be a string');
      }
    }
  }

  function validateRequiredGroups(requiredGroups, prefix, errors) {
    if (!Array.isArray(requiredGroups) || requiredGroups.length === 0) {
      errors.push(prefix + '.requiredGroups must be a non-empty array of keyword arrays');
      return;
    }
    for (let g = 0; g < requiredGroups.length; g++) {
      const grp = requiredGroups[g];
      if (!Array.isArray(grp) || grp.length === 0) {
        errors.push(prefix + '.requiredGroups[' + g + '] must be a non-empty array of strings');
        continue;
      }
      for (let k = 0; k < grp.length; k++) {
        if (!isNonEmptyString(grp[k])) {
          errors.push(prefix + '.requiredGroups[' + g + '][' + k + '] must be a non-empty string');
        }
      }
    }
  }

  function validateItem(item, index, seenIds, categoryKeys, errors) {
    const prefix = 'items[' + index + ']';
    if (!isPlainObject(item)) {
      errors.push(prefix + ' must be an object');
      return;
    }

    for (let i = 0; i < ITEM_REQUIRED_STRINGS.length; i++) {
      const field = ITEM_REQUIRED_STRINGS[i];
      if (!isNonEmptyString(item[field])) {
        errors.push(prefix + '.' + field + ' must be a non-empty string');
      }
    }

    if (isNonEmptyString(item.id)) {
      if (!VALID_ID_REGEX.test(item.id)) {
        errors.push(prefix + '.id ("' + item.id + '") must match /^[a-zA-Z0-9_-]+$/');
      }
      if (seenIds.has(item.id)) {
        errors.push('Duplicate item id "' + item.id + '" at ' + prefix);
      } else {
        seenIds.add(item.id);
      }
    }

    if (categoryKeys && isNonEmptyString(item.category) && !categoryKeys.has(item.category)) {
      errors.push(prefix + '.category ("' + item.category + '") is not listed in categories');
    }

    if (typeof item.price !== 'string') {
      errors.push(prefix + '.price must be a string');
    }

    if (item.digitalOnly !== undefined && typeof item.digitalOnly !== 'boolean') {
      errors.push(prefix + '.digitalOnly must be a boolean');
    }

    for (let i = 0; i < ITEM_OPTIONAL_STRINGS.length; i++) {
      const field = ITEM_OPTIONAL_STRINGS[i];
      if (item[field] !== undefined && typeof item[field] !== 'string') {
        errors.push(prefix + '.' + field + ' must be a string');
      }
    }

    validateMbEditions(item.mbEditions, prefix, errors);

    if (isNonEmptyString(item.itunesQuery)) {
      if (item.requiredGroups === undefined) {
        errors.push(prefix + '.requiredGroups is required when itunesQuery is set');
      } else {
        validateRequiredGroups(item.requiredGroups, prefix, errors);
      }
    } else if (item.requiredGroups !== undefined) {
      validateRequiredGroups(item.requiredGroups, prefix, errors);
    }

    collectProhibitedDomainErrors(item, prefix, errors);
  }

  /**
   * Validate a catalog object against the METADATA.md schema and rules.
   * @param {unknown} catalog
   * @returns {{ valid: boolean, errors: string[] }}
   */
  function validateCatalog(catalog) {
    const errors = [];

    if (!isPlainObject(catalog)) {
      return { valid: false, errors: ['Catalog root must be a non-null plain object'] };
    }

    validateMeta(catalog.meta, errors);
    const categoryKeys = validateCategories(catalog.categories, errors);

    if (!Array.isArray(catalog.items) || catalog.items.length === 0) {
      errors.push('items must be a non-empty array');
    } else {
      const seenIds = new Set();
      for (let i = 0; i < catalog.items.length; i++) {
        validateItem(catalog.items[i], i, seenIds, categoryKeys, errors);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Normalize a catalog metadata URL, converting GitHub blob/raw URLs to raw.githubusercontent.com.
   * @param {string} rawUrl
   * @returns {string}
   */
  function normalizeCatalogUrl(rawUrl) {
    const trimmed = String(rawUrl || '').trim();
    if (!trimmed) return '';
    const match = trimmed.match(
      /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^?#]+?)(?:[?#].*)?$/i
    );
    if (match) {
      return 'https://raw.githubusercontent.com/' + match[1] + '/' + match[2] + '/' + match[3];
    }
    return trimmed;
  }

  if (root) {
    root.validateCatalog = validateCatalog;
    root.normalizeCatalogUrl = normalizeCatalogUrl;
    root.CDHunt = root.CDHunt || {};
    root.CDHunt.validateCatalog = validateCatalog;
    root.CDHunt.normalizeCatalogUrl = normalizeCatalogUrl;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { validateCatalog, normalizeCatalogUrl };
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
