(function () {
  const FILTER_FIELD  = 'wf-field';
  const FILTER_VALUE  = 'wf-value';
  const FILTER_ACTIVE = 'wf-activeclass';
  const LIST_ELEMENT  = 'wf-element';

  const STATUS_FIELD      = 'status';
  const STATUS_OPEN_VALUE = 'open';
  const DIM_OPACITY       = '0.25';

  const SORT_ATTR       = 'wf-sort';        // on controls: field to sort by
  const SORT_ORDER_ATTR = 'wf-sort-order';  // on controls: asc | desc (optional)
  const SORT_FIELD_ATTR = 'wf-sort-field';  // on item elements: value source
  const SORT_TYPE_ATTR  = 'wf-sort-type';   // on item elements: number | date | text (optional)

  const sliderState     = {};
  const loadMoreState   = new WeakMap();
  const paginationState = new WeakMap();
  const sortState       = { field: '', order: 'asc' };

  let collator;
  try {
    collator = new Intl.Collator(document.documentElement.lang || 'cs', { numeric: true, sensitivity: 'base' });
  } catch (e) {
    collator = new Intl.Collator('cs', { numeric: true, sensitivity: 'base' });
  }

  // ─── Formatters ───────────────────────────────────────────────────────────────

  function runFormatters() {
    if (typeof window.formatI18n === 'function') window.formatI18n();
    if (typeof window.initInvestmentProgress === 'function') window.initInvestmentProgress();
    if (typeof window.initRatingFormat === 'function') window.initRatingFormat();
    if (typeof window.initYieldPremium === 'function') window.initYieldPremium();
  }

  // ─── Checkbox helper ──────────────────────────────────────────────────────────

  function setCheckbox(cb, checked) {
    cb.checked = checked;
    const activeClass = cb.getAttribute(FILTER_ACTIVE) || 'is-active';
    cb.closest('label')?.classList.toggle(activeClass, checked);
    cb.closest('label')?.querySelector('.w-checkbox-input')
      ?.classList.toggle('w--redirected-checked', checked);
  }

  // ─── Status checkbox state ────────────────────────────────────────────────────

  function getStatusCheckbox() {
    return document.querySelector(
      `input[type="checkbox"][${FILTER_FIELD}="${STATUS_FIELD}"]`
    );
  }

  function isStatusFilterActive() {
    const cb = getStatusCheckbox();
    return cb ? cb.checked : false;
  }

  // ─── Slider UI ───────────────────────────────────────────────────────────────

  function updateSliderUI(slider) {
    const min = parseFloat(slider.min);
    const max = parseFloat(slider.max);
    const val = parseFloat(slider.value);
    const pct = (max > min) ? ((val - min) / (max - min)) * 100 : 0;

    const container = slider.closest('.filter_slider-container');
    const fill = container?.querySelector('[class*="slider-fill"]');
    if (fill) fill.style.width = pct + '%';

    const field = slider.getAttribute(FILTER_VALUE);
    const label = document.querySelector(`[${LIST_ELEMENT}="${field}SliderValue"]`);
    if (label) {
      label.dataset.rawValue = (val * 100).toFixed(4);
      if (typeof window.formatI18n === 'function') {
        window.formatI18n();
      } else {
        const pctVal = val * 100;
        label.textContent = Number.isInteger(pctVal)
          ? pctVal.toString()
          : pctVal.toFixed(1);
      }
    }
  }

  // ─── Dropdown toggle text ─────────────────────────────────────────────────────

  function updateDropdownToggleText(input) {
    const dropdown = input.closest('.w-dropdown');
    if (!dropdown) return;
    const toggle = dropdown.querySelector('.filter_dropdown-toggle-text');
    if (!toggle) return;

    if (input.type === 'checkbox') {
      const field = input.getAttribute(FILTER_FIELD) || input.name;
      const checkedLabels = Array.from(
        document.querySelectorAll(
          `input[type="checkbox"][wf-field="${field}"]:checked, input[type="checkbox"][name="${input.name}"]:checked`
        )
      )
        .filter(cb => cb.getAttribute(FILTER_VALUE) !== '')
        .map(cb => cb.closest('label')?.querySelector('.w-form-label')?.textContent.trim())
        .filter(Boolean);

      toggle.textContent = checkedLabels.length > 0
        ? checkedLabels.join(', ')
        : (toggle.dataset.default || 'Vše');
    } else {
      const labelEl = input.closest('label')?.querySelector('.w-form-label');
      if (labelEl) {
        toggle.textContent = labelEl.textContent.trim();
      } else if (toggle.dataset.default) {
        toggle.textContent = toggle.dataset.default;
      }
    }
  }

  // ─── Page fetching ────────────────────────────────────────────────────────────

  // Reads "3 / 38" from Webflow's .w-page-count
  function getPageInfo(dynList) {
    const counter = dynList.querySelector('.w-page-count');
    const match = counter?.textContent.match(/(\d+)\s*\/\s*(\d+)/);
    return match
      ? { current: parseInt(match[1], 10), total: parseInt(match[2], 10) }
      : { current: 1, total: 1 };
  }

  // Finds the native "?xxxxxx_page=N" param from any pagination link (next OR prev)
  function getNativePageParam(dynList) {
    const link = dynList.querySelector('.w-pagination-wrapper a[href*="_page="]');
    if (!link) return null;
    try {
      const url = new URL(link.getAttribute('href'), window.location.href);
      for (const key of url.searchParams.keys()) {
        if (key.endsWith('_page')) return { key, href: url.toString() };
      }
    } catch (e) {}
    return null;
  }

  async function fetchPageItems(pageUrl, listSelector) {
    try {
      const res  = await fetch(pageUrl);
      const html = await res.text();
      const doc  = new DOMParser().parseFromString(html, 'text/html');
      const remoteList = doc.querySelector(listSelector);
      if (!remoteList) return null;
      const fragment = document.createDocumentFragment();
      remoteList.querySelectorAll('[role="listitem"]').forEach(item => {
        fragment.appendChild(document.importNode(item, true));
      });
      return fragment;
    } catch (e) {
      console.warn('[wf-filters] fetch error:', e);
      return null;
    }
  }

  function buildPageUrl(href, pageNumber) {
    try {
      const url = new URL(href, window.location.href);
      for (const [key] of url.searchParams.entries()) {
        if (key.endsWith('_page')) {
          url.searchParams.set(key, pageNumber);
          return url.toString();
        }
      }
    } catch (e) {}
    return null;
  }

  // Loads every native page (except the one already rendered) and inserts
  // items in the correct order. Works even when landing on ?xxx_page=N.
  async function fetchAndInjectAllPages(list) {
    const info = {
      currentPage: 1,
      firstPageSize: list.querySelectorAll('[role="listitem"]').length,
      pageKey: null,
    };

    const dynList = list.closest('.w-dyn-list');
    if (!dynList) return info;

    const { current, total } = getPageInfo(dynList);
    info.currentPage = current;

    const param = getNativePageParam(dynList);
    if (!param) return info;
    info.pageKey = param.key;
    if (total <= 1) return info;

    const listClasses = Array.from(list.classList)
      .filter(c => c !== 'w-dyn-items')
      .map(c => '.' + CSS.escape(c))
      .join('');
    const listSelector = `.w-dyn-list .w-dyn-items${listClasses}`;

    const pages = [];
    for (let p = 1; p <= total; p++) if (p !== current) pages.push(p);

    const results = await Promise.all(
      pages.map(p => {
        const url = buildPageUrl(param.href, p);
        return url ? fetchPageItems(url, listSelector) : Promise.resolve(null);
      })
    );

    const before = document.createDocumentFragment();
    results.forEach((fragment, i) => {
      if (!fragment) return;
      const p = pages[i];
      if (p === 1) info.firstPageSize = fragment.childElementCount;
      if (p < current) before.appendChild(fragment);
      else list.appendChild(fragment);
    });
    list.insertBefore(before, list.firstChild);

    runFormatters();
    return info;
  }

  // ─── Filters ──────────────────────────────────────────────────────────────────

  function getActiveFilters() {
    const exactFilters = {};
    const rangeFilters = {};

    document.querySelectorAll(`input[type="radio"], input[type="checkbox"]`).forEach(cb => {
      if (!cb.checked) return;

      // Status checkbox is handled separately via dimming
      if (cb.getAttribute(FILTER_FIELD) === STATUS_FIELD) return;

      const field = cb.getAttribute(FILTER_FIELD) || cb.name;
      if (!field) return;

      const hasMin = cb.hasAttribute('wf-value-min');
      const hasMax = cb.hasAttribute('wf-value-max');

      if (hasMin || hasMax) {
        const minRaw = cb.getAttribute('wf-value-min');
        const maxRaw = cb.getAttribute('wf-value-max');
        const min = (minRaw !== null && minRaw !== '') ? parseFloat(minRaw) : null;
        const max = (maxRaw !== null && maxRaw !== '') ? parseFloat(maxRaw) : null;
        if (min !== null || max !== null) {
          rangeFilters[field] = { min, max };
        }
        return;
      }

      const value = cb.getAttribute(FILTER_VALUE);
      if (value === null) return;
      if (value === '') return;

      const orAttr   = cb.getAttribute('wf-value-or') || '';
      const orValues = orAttr.split(';').map(v => v.trim().toLowerCase()).filter(Boolean);
      const allValues = [value.toLowerCase(), ...orValues];

      if (!exactFilters[field]) exactFilters[field] = [];
      allValues.forEach(v => { if (!exactFilters[field].includes(v)) exactFilters[field].push(v); });
    });

    return { exactFilters, rangeFilters };
  }

  function getItemTags(item) {
    const tags = {};
    item.querySelectorAll(`[${FILTER_FIELD}]`).forEach(el => {
      if (el.tagName === 'INPUT') return;
      const field = el.getAttribute(FILTER_FIELD);
      const value = el.textContent.trim().toLowerCase();
      if (!value) return;
      if (!tags[field]) tags[field] = [];
      tags[field].push(value);
    });
    return tags;
  }

  function getItemNumericField(item, field) {
    const nodes = Array.from(item.querySelectorAll(`[${FILTER_FIELD}="${field}"]`))
      .filter(n => n.tagName !== 'INPUT');
    if (nodes.length === 0) return null;
    const text = nodes[nodes.length - 1].textContent.trim();
    const val  = parseFloat(text);
    return isNaN(val) ? null : val;
  }

  function itemMatchesFilters(item, { exactFilters, rangeFilters }) {
    const itemTags = getItemTags(item);
    for (const [field, values] of Object.entries(exactFilters)) {
      if (!values.some(v => (itemTags[field] || []).includes(v))) return false;
    }

    for (const [field, { min, max }] of Object.entries(rangeFilters)) {
      const val = getItemNumericField(item, field);
      if (val === null) return false;
      if (min !== null && val < min) return false;
      if (max !== null && val > max) return false;
    }

    for (const [field, sliderVal] of Object.entries(sliderState)) {
      const slider = document.querySelector(`input[type="range"][${FILTER_VALUE}="${field}"]`);
      const mode   = slider?.getAttribute('wf-filter-mode') || 'min';

      if (slider) {
        const sliderMin = parseFloat(slider.min);
        const sliderMax = parseFloat(slider.max);
        if (mode === 'min' && sliderVal <= sliderMin) continue;
        if (mode === 'max' && sliderVal >= sliderMax) continue;
      }

      const nodes = Array.from(item.querySelectorAll(`[${FILTER_VALUE}="${field}"]`))
        .filter(n => n.tagName !== 'INPUT');
      if (nodes.length === 0) continue;
      const raw = parseFloat(nodes[nodes.length - 1].textContent.trim());
      if (isNaN(raw)) continue;

      if (mode === 'max' ? raw > sliderVal : raw < sliderVal) return false;
    }

    return true;
  }

  // ─── Status dimming ───────────────────────────────────────────────────────────

  function applyStatusDimming(allItems) {
    const active = isStatusFilterActive();
    allItems.forEach(item => {
      const card = item.querySelector('.estate-card');
      if (!card) return;
      if (!active) {
        card.style.opacity = '';
        return;
      }
      const tags   = getItemTags(item);
      const values = tags[STATUS_FIELD] || [];
      const isOpen = values.includes(STATUS_OPEN_VALUE);
      card.style.opacity = isOpen ? '' : DIM_OPACITY;
    });
  }

  // ─── Empty facets ─────────────────────────────────────────────────────────────

  function getAllAvailableTagValues() {
    const available = {};
    document.querySelectorAll(`[${LIST_ELEMENT}="list"] [role="listitem"]`).forEach(item => {
      Object.entries(getItemTags(item)).forEach(([field, values]) => {
        if (!available[field]) available[field] = new Set();
        values.forEach(v => available[field].add(v));
      });
    });
    return available;
  }

  function updateEmptyFacets() {
    const available = getAllAvailableTagValues();
    document.querySelectorAll('[wf-emptyfacet="hide"]').forEach(filterItem => {
      const input = filterItem.querySelector(`[${FILTER_VALUE}]`);
      if (!input) return;
      const field = input.getAttribute(FILTER_FIELD) || input.name;
      const value = input.getAttribute(FILTER_VALUE).toLowerCase();
      filterItem.style.display = (available[field] || new Set()).has(value) ? '' : 'none';
    });
  }

  // ─── Visibility / counts / empty state ────────────────────────────────────────

  // Shows matchingItems[start..end), hides everything else. Returns visible count.
  function showRange(allItems, matchingItems, start, end) {
    const visible = new Set(matchingItems.slice(start, end));
    allItems.forEach(item => { item.style.display = visible.has(item) ? '' : 'none'; });
    return visible.size;
  }

  function formatCount(n) {
    try {
      return n.toLocaleString(document.documentElement.lang || 'cs-CZ');
    } catch (e) {
      return String(n);
    }
  }

  // results-count = items currently shown, items-count = items matching filters,
  // total-count = all items regardless of filters
  function updateCounts(list, visibleCount, matchingCount, totalCount) {
    const scope = list.closest(`[${LIST_ELEMENT}="wrapper"]`) || document;
    const set = (name, value) => {
      scope.querySelectorAll(`[${LIST_ELEMENT}="${name}"]`).forEach(el => {
        el.textContent = formatCount(value);
      });
    };
    set('results-count', visibleCount);
    set('items-count', matchingCount);
    set('total-count', totalCount);
  }

  function updateEmptyState(list, matchingCount) {
    const emptyEl =
      list.closest('[class*="category"], [class*="highlighted"]')?.querySelector('[wf-empty]')
      ?? list.closest('.w-dyn-list')?.querySelector('[wf-empty]')
      ?? document.querySelector('[wf-empty]');

    if (emptyEl) {
      emptyEl.style.display = matchingCount === 0 ? 'block' : 'none';
    }
  }

  // ─── Load more ────────────────────────────────────────────────────────────────

  function getLoadMoreBtn(list) {
    return list.closest('.w-dyn-list')?.querySelector('.w-pagination-next') ?? null;
  }

  function updateLoadMoreButton(list, matchingCount) {
    const btn = getLoadMoreBtn(list);
    if (!btn) return;
    const { revealed } = loadMoreState.get(list);
    btn.style.display = matchingCount > revealed ? '' : 'none';
  }

  function initLoadMore(list, pageSize) {
    const dynList = list.closest('.w-dyn-list');

    dynList?.querySelectorAll('.w-pagination-previous, .w-page-count').forEach(el => {
      el.style.display = 'none';
    });

    loadMoreState.set(list, { revealed: pageSize, pageSize });

    const btn = getLoadMoreBtn(list);
    if (!btn) return;

    btn.addEventListener('click', e => {
      e.preventDefault();
      const { revealed, pageSize } = loadMoreState.get(list);
      const activeFilters = getActiveFilters();
      const allItems      = Array.from(list.querySelectorAll('[role="listitem"]'));
      const matchingItems = allItems.filter(item => itemMatchesFilters(item, activeFilters));
      const next          = revealed + pageSize;
      loadMoreState.set(list, { revealed: next, pageSize });
      const visibleCount = showRange(allItems, matchingItems, 0, next);
      updateLoadMoreButton(list, matchingItems.length);
      applyStatusDimming(allItems);
      updateCounts(list, visibleCount, matchingItems.length, allItems.length);
      runFormatters();
    });
  }

  // ─── Pagination ───────────────────────────────────────────────────────────────

  // Returns e.g. [1, '…', 4, 5, 6, '…', 38]
  function getPageSequence(current, total, siblings, boundary) {
    const pages = new Set();
    for (let i = 1; i <= Math.min(boundary, total); i++) pages.add(i);
    for (let i = Math.max(total - boundary + 1, 1); i <= total; i++) pages.add(i);
    for (let i = current - siblings; i <= current + siblings; i++) {
      if (i >= 1 && i <= total) pages.add(i);
    }

    const sorted = Array.from(pages).sort((a, b) => a - b);
    const out = [];
    let prev = 0;
    sorted.forEach(n => {
      if (n - prev === 2) out.push(prev + 1);   // fill a single gap with the number
      else if (n - prev > 2) out.push('…');
      out.push(n);
      prev = n;
    });
    return out;
  }

  function toggleNav(el, enabled) {
    const disabledClass = el.getAttribute('wf-disabledclass');
    if (disabledClass) {
      el.style.display = '';
      el.classList.toggle(disabledClass, !enabled);
    } else {
      el.style.display = enabled ? '' : 'none';
    }
    el.setAttribute('aria-disabled', String(!enabled));
    el.tabIndex = enabled ? 0 : -1;
  }

  function updatePageUrl(st) {
    if (!st.pageKey || !st.syncQuery) return;
    const url = new URL(window.location.href);
    if (st.page > 1) url.searchParams.set(st.pageKey, st.page);
    else url.searchParams.delete(st.pageKey);
    history.replaceState(history.state, '', url.toString());
  }

  function renderPagination(list, totalPages) {
    const st = paginationState.get(list);
    const ui = st.ui;
    updatePageUrl(st);
    if (!ui) return;

    ui.wrapper.style.display = totalPages > 1 ? '' : 'none';
    if (ui.prev) toggleNav(ui.prev, st.page > 1);
    if (ui.next) toggleNav(ui.next, st.page < totalPages);

    if (ui.pageCount) {
      ui.pageCount.textContent = `${st.page} / ${totalPages}`;
      ui.pageCount.setAttribute('aria-label', `Page ${st.page} of ${totalPages}`);
    }

    if (!ui.host || !ui.template) return;
    ui.host.replaceChildren();

    const activeClass = ui.template.getAttribute(FILTER_ACTIVE) || 'w--current';

    getPageSequence(st.page, totalPages, st.siblings, st.boundary).forEach(p => {
      if (p === '…') {
        let dots;
        if (ui.dotsTemplate) {
          dots = ui.dotsTemplate.cloneNode(true);
        } else {
          dots = document.createElement('div');
          dots.className = 'pagination_dots';
          dots.textContent = '…';
        }
        dots.setAttribute('aria-hidden', 'true');
        ui.host.appendChild(dots);
        return;
      }

      const btn = ui.template.cloneNode(true);
      const label = btn.querySelector(`[${LIST_ELEMENT}="page-number"]`) || btn.querySelector('div') || btn;
      label.textContent = p;
      btn.dataset.wfPage = p;
      btn.setAttribute('href', '#');
      btn.setAttribute('aria-label', `Page ${p}`);
      const isActive = p === st.page;
      btn.classList.toggle(activeClass, isActive);
      if (isActive) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
      ui.host.appendChild(btn);
    });
  }

  function scrollToListTop(list) {
    if (list.getAttribute('wf-page-scroll') === 'false') return;
    const wrapper = list.closest(`[${LIST_ELEMENT}="wrapper"]`);
    const anchor =
      wrapper?.querySelector(`[${LIST_ELEMENT}="scroll-anchor"]`)
      ?? document.querySelector(`[${LIST_ELEMENT}="scroll-anchor"]`)
      ?? wrapper
      ?? list.closest('.w-dyn-list');
    if (!anchor) return;
    if (anchor.getBoundingClientRect().top < 0) {
      anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function goToPage(list, page) {
    const st = paginationState.get(list);
    if (!st || page === st.page || page < 1) return;
    st.page = page;
    renderList(list, getActiveFilters(), { resetPage: false });
    runFormatters();
    scrollToListTop(list);
  }

  function initPagination(list, pageSize, info) {
    const st = {
      page:      info.currentPage || 1,
      pageSize,
      pageKey:   info.pageKey,
      syncQuery: list.getAttribute('wf-page-query') === 'true',
      siblings:  Math.max(0, parseInt(list.getAttribute('wf-page-siblings') ?? '1', 10) || 0),
      boundary:  Math.max(1, parseInt(list.getAttribute('wf-page-boundary') ?? '1', 10) || 1),
      ui:        null,
    };
    paginationState.set(list, st);

    // Native ?xxx_page=N no longer reflects the JS state unless we sync it
    if (st.pageKey && !st.syncQuery) {
      const url = new URL(window.location.href);
      if (url.searchParams.has(st.pageKey)) {
        url.searchParams.delete(st.pageKey);
        history.replaceState(history.state, '', url.toString());
      }
    }

    const dynList = list.closest('.w-dyn-list');
    const wrapper = dynList?.querySelector('.w-pagination-wrapper');
    if (!wrapper) return;

    wrapper.querySelectorAll('link[rel="prerender"]').forEach(l => l.remove());

    const next = wrapper.querySelector(`[${LIST_ELEMENT}="page-next"]`) || wrapper.querySelector('.w-pagination-next');
    let prev   = wrapper.querySelector(`[${LIST_ELEMENT}="page-prev"]`) || wrapper.querySelector('.w-pagination-previous');

    // Webflow doesn't render "Previous" on page 1 → build it from "Next"
    if (!prev && next) {
      prev = next.cloneNode(true);
      prev.classList.remove('w-pagination-next');
      prev.classList.add('w-pagination-previous');
      prev.setAttribute('aria-label', 'Previous Page');
      if (prev.getAttribute(LIST_ELEMENT) === 'page-next') prev.setAttribute(LIST_ELEMENT, 'page-prev');
      prev.querySelectorAll('svg').forEach(svg => { svg.style.transform = 'scaleX(-1)'; });
      wrapper.insertBefore(prev, wrapper.firstChild);
    }

    const template     = wrapper.querySelector(`[${LIST_ELEMENT}="page-button"]`);
    const dotsTemplate = wrapper.querySelector(`[${LIST_ELEMENT}="page-dots"]`);
    const pageCount    = wrapper.querySelector('.w-page-count');

    let host = null;
    if (template) {
      host = document.createElement('div');
      host.style.display = 'contents';
      template.replaceWith(host);
      host.addEventListener('click', e => {
        const btn = e.target.closest('[data-wf-page]');
        if (!btn) return;
        e.preventDefault();
        goToPage(list, parseInt(btn.dataset.wfPage, 10));
      });
    }
    dotsTemplate?.remove();

    [prev, next].forEach(el => {
      if (!el) return;
      el.setAttribute('href', '#');
      el.setAttribute('role', 'button');
    });

    prev?.addEventListener('click', e => {
      e.preventDefault();
      goToPage(list, st.page - 1);
    });
    next?.addEventListener('click', e => {
      e.preventDefault();
      const totalPages = Math.max(1, Math.ceil((st.matchingCount || 0) / st.pageSize));
      if (st.page < totalPages) goToPage(list, st.page + 1);
    });

    st.ui = { wrapper, prev, next, template, dotsTemplate, pageCount, host };
  }

  // ─── Sort ─────────────────────────────────────────────────────────────────────

  function isNumericText(s) {
    return /^-?[\d\s ]+([.,]\d+)?$/.test(s);
  }

  // Supports ISO (2025-03-12) and Czech (12. 3. 2025) dates
  function parseDate(s) {
    const cz = s.match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
    if (cz) return new Date(+cz[3], +cz[2] - 1, +cz[1]).getTime();
    const t = Date.parse(s);
    return isNaN(t) ? null : t;
  }

  function getSortValue(item, field) {
    const el = item.querySelector(`[${SORT_FIELD_ATTR}="${field}"]`);
    if (!el) return null;

    const hasRaw = el.dataset.rawValue !== undefined;
    const raw    = (hasRaw ? el.dataset.rawValue : el.textContent).trim();
    if (raw === '') return null;

    let type = el.getAttribute(SORT_TYPE_ATTR);
    if (!type) type = (hasRaw || isNumericText(raw)) ? 'number' : 'text';

    if (type === 'number') {
      const n = parseFloat(raw.replace(/[\s ]/g, '').replace(',', '.'));
      return isNaN(n) ? null : n;
    }
    if (type === 'date') return parseDate(raw);
    return raw;
  }

  function getListItems(list) {
    return Array.from(list.children).filter(el => el.getAttribute('role') === 'listitem');
  }

  function indexItems() {
    document.querySelectorAll(`[${LIST_ELEMENT}="list"]`).forEach(list => {
      getListItems(list).forEach((item, i) => { item.dataset.wfIndex = i; });
    });
  }

  function sortLists() {
    const { field, order } = sortState;
    const dir = order === 'desc' ? -1 : 1;

    document.querySelectorAll(`[${LIST_ELEMENT}="list"]`).forEach(list => {
      const entries = getListItems(list).map(item => ({
        item,
        idx: parseInt(item.dataset.wfIndex, 10) || 0,
        val: field ? getSortValue(item, field) : null,
      }));

      entries.sort((a, b) => {
        if (!field) return a.idx - b.idx;                 // original CMS order
        if (a.val === null && b.val === null) return a.idx - b.idx;
        if (a.val === null) return 1;                     // empty values always last
        if (b.val === null) return -1;
        const cmp = (typeof a.val === 'number' && typeof b.val === 'number')
          ? a.val - b.val
          : collator.compare(String(a.val), String(b.val));
        return cmp === 0 ? a.idx - b.idx : cmp * dir;
      });

      const fragment = document.createDocumentFragment();
      entries.forEach(({ item }) => fragment.appendChild(item));
      list.appendChild(fragment);
    });
  }

  function updateSortUI() {
    const { field, order } = sortState;

    document.querySelectorAll(`[${SORT_ATTR}]`).forEach(el => {
      const elField     = el.getAttribute(SORT_ATTR);
      const elOrder     = el.getAttribute(SORT_ORDER_ATTR);
      const activeClass = el.getAttribute(FILTER_ACTIVE) || 'is-active';
      const isMatch     = elField === field && (!field || !elOrder || elOrder === order);

      if (el.tagName === 'INPUT') {
        el.checked = isMatch;
        const label = el.closest('label');
        label?.classList.toggle(activeClass, isMatch);
        label?.querySelector('.w-radio-input')?.classList.toggle('w--redirected-checked', isMatch);
        if (isMatch) updateDropdownToggleText(el);
        return;
      }

      const isActive = isMatch && !!field;
      el.classList.toggle(activeClass, isActive);
      el.classList.toggle('is-asc',  isActive && order === 'asc');
      el.classList.toggle('is-desc', isActive && order === 'desc');
    });

    document.querySelectorAll(`select[${LIST_ELEMENT}="sort"]`).forEach(sel => {
      sel.value = field ? `${field}-${order}` : '';
    });
  }

  function parseSortValue(value) {
    if (!value) return { field: '', order: 'asc' };
    const m = value.match(/^(.*)-(asc|desc)$/);
    return m ? { field: m[1], order: m[2] } : { field: value, order: 'asc' };
  }

  function setSort(field, order) {
    sortState.field = field || '';
    sortState.order = order === 'desc' ? 'desc' : 'asc';
    sortLists();
    updateSortUI();
    applyFilters(); // re-renders + resets to page 1
  }

  function initSort() {
    document.querySelectorAll(`[${SORT_ATTR}]`).forEach(el => {
      // Radio / checkbox inside a dropdown
      if (el.tagName === 'INPUT') {
        el.addEventListener('change', () => {
          if (el.checked) setSort(el.getAttribute(SORT_ATTR), el.getAttribute(SORT_ORDER_ATTR) || 'asc');
        });
        return;
      }

      // Clickable element (e.g. table header) — toggles asc/desc unless wf-sort-order is fixed
      el.addEventListener('click', e => {
        e.preventDefault();
        const field = el.getAttribute(SORT_ATTR);
        const fixed = el.getAttribute(SORT_ORDER_ATTR);
        let order   = fixed || 'asc';
        if (!fixed && sortState.field === field) {
          order = sortState.order === 'asc' ? 'desc' : 'asc';
        }
        setSort(field, order);
      });

      if (!['A', 'BUTTON'].includes(el.tagName)) {
        if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
        el.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
        });
      }
    });

    // Native <select>, option values like "loan-amount-desc"
    document.querySelectorAll(`select[${LIST_ELEMENT}="sort"]`).forEach(sel => {
      sel.addEventListener('change', () => {
        const { field, order } = parseSortValue(sel.value);
        setSort(field, order);
      });
    });

    // Initial sort from a pre-checked radio or pre-selected option
    const preRadio  = document.querySelector(`input[${SORT_ATTR}]:checked`);
    const preSelect = document.querySelector(`select[${LIST_ELEMENT}="sort"]`);
    if (preRadio) {
      sortState.field = preRadio.getAttribute(SORT_ATTR) || '';
      sortState.order = preRadio.getAttribute(SORT_ORDER_ATTR) === 'desc' ? 'desc' : 'asc';
    } else if (preSelect?.value) {
      Object.assign(sortState, parseSortValue(preSelect.value));
    }

    if (sortState.field) sortLists();
    updateSortUI();
  }

  // ─── Render a single list ─────────────────────────────────────────────────────

  function renderList(list, activeFilters, { resetPage = true } = {}) {
    const allItems      = Array.from(list.querySelectorAll('[role="listitem"]'));
    const matchingItems = allItems.filter(item => itemMatchesFilters(item, activeFilters));
    const mode          = list.getAttribute('wf-load');
    let visibleCount;

    if (mode === 'more' && loadMoreState.has(list)) {
      const { pageSize } = loadMoreState.get(list);
      loadMoreState.set(list, { revealed: pageSize, pageSize });
      visibleCount = showRange(allItems, matchingItems, 0, pageSize);
      updateLoadMoreButton(list, matchingItems.length);

    } else if (mode === 'pagination' && paginationState.has(list)) {
      const st = paginationState.get(list);
      st.matchingCount = matchingItems.length;
      const totalPages = Math.max(1, Math.ceil(matchingItems.length / st.pageSize));
      if (resetPage) st.page = 1;
      st.page = Math.min(Math.max(st.page, 1), totalPages);
      const start = (st.page - 1) * st.pageSize;
      visibleCount = showRange(allItems, matchingItems, start, start + st.pageSize);
      renderPagination(list, totalPages);

    } else {
      visibleCount = showRange(allItems, matchingItems, 0, Infinity);
    }

    applyStatusDimming(allItems);
    updateEmptyState(list, matchingItems.length);
    updateCounts(list, visibleCount, matchingItems.length, allItems.length);
  }

  // ─── Apply filters ────────────────────────────────────────────────────────────

  function applyFilters(options = {}) {
    const activeFilters = getActiveFilters();
    document.querySelectorAll(`[${LIST_ELEMENT}="list"]`).forEach(list => {
      renderList(list, activeFilters, options);
    });
    runFormatters();
  }

  // ─── Clear ────────────────────────────────────────────────────────────────────

  function clearFilters() {
    document.querySelectorAll(`input[type="radio"], input[type="checkbox"]`).forEach(input => {
      if (input.type === 'range') return;
      if (input.hasAttribute(SORT_ATTR)) return; // sorting is kept on clear
      const isRangeBucket = input.hasAttribute('wf-value-min') || input.hasAttribute('wf-value-max');
      const activeClass   = input.getAttribute(FILTER_ACTIVE) || 'is-active';

      if (input.checked) {
        input.checked = false;
        input.closest('label')?.classList.remove(activeClass);
        input.closest('label')?.querySelector('.w-checkbox-input')
          ?.classList.remove('w--redirected-checked');
      }

      if (input.type === 'radio' && (isRangeBucket || input.hasAttribute(FILTER_VALUE))) {
        const dropdown = input.closest('.w-dropdown');
        const toggle   = dropdown?.querySelector('.filter_dropdown-toggle-text');
        if (toggle?.dataset.default) toggle.textContent = toggle.dataset.default;
      }
    });

    document.querySelectorAll('input[type="checkbox"][wf-value=""]').forEach(vse => {
      setCheckbox(vse, true);
      const toggle = vse.closest('.w-dropdown')?.querySelector('.filter_dropdown-toggle-text');
      if (toggle?.dataset.default) toggle.textContent = toggle.dataset.default;
    });

    // Re-check the "Vše" radios so the UI matches the cleared state
    document.querySelectorAll(`input[type="radio"][${FILTER_VALUE}=""]`).forEach(radio => {
      radio.checked = true;
      radio.closest('label')?.classList.add(radio.getAttribute(FILTER_ACTIVE) || 'is-active');
    });

    // Restore status checkbox to checked default
    const statusCb = getStatusCheckbox();
    if (statusCb) setCheckbox(statusCb, true);

    document.querySelectorAll(`input[type="range"][${FILTER_VALUE}]`).forEach(input => {
      input.value = input.min;
      sliderState[input.getAttribute(FILTER_VALUE)] = parseFloat(input.min);
      updateSliderUI(input);
    });

    applyFilters();
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────

  async function init() {
    const managedLists = Array.from(document.querySelectorAll(
      `[${LIST_ELEMENT}="list"][wf-load="more"], [${LIST_ELEMENT}="list"][wf-load="pagination"]`
    ));

    const loadInfo = new Map();
    await Promise.all(managedLists.map(async list => {
      loadInfo.set(list, await fetchAndInjectAllPages(list));
    }));

    indexItems(); // remember original CMS order for "default" sort

    // Check the status checkbox by default
    const statusCb = getStatusCheckbox();
    if (statusCb) setCheckbox(statusCb, true);

    // ── Attach change listeners ──
    document.querySelectorAll(`input[type="radio"], input[type="checkbox"]`).forEach(input => {
      if (input.type === 'range') return;

      const isExact       = input.hasAttribute(FILTER_VALUE);
      const isRangeBucket = input.hasAttribute('wf-value-min') || input.hasAttribute('wf-value-max');
      if (!isExact && !isRangeBucket) return;

      const activeClass = input.getAttribute(FILTER_ACTIVE) || 'is-active';

      input.addEventListener('change', () => {
        if (input.type === 'radio') {
          document.querySelectorAll(`input[type="radio"][name="${input.name}"]`).forEach(sibling => {
            if (!sibling.checked) {
              sibling.closest('label')?.classList.remove(sibling.getAttribute(FILTER_ACTIVE) || 'is-active');
            }
          });
          updateDropdownToggleText(input);
          input.closest('label')?.classList.toggle(activeClass, input.checked);
          applyFilters();
        }

        if (input.type === 'checkbox') {
          // Status checkbox: sync UI and re-apply only
          if (input.getAttribute(FILTER_FIELD) === STATUS_FIELD) {
            setCheckbox(input, input.checked);
            applyFilters();
            return;
          }

          const field = input.getAttribute(FILTER_FIELD) || input.name;

          setTimeout(() => {
            const allCbs = Array.from(
              document.querySelectorAll(
                `input[type="checkbox"][wf-field="${field}"], input[type="checkbox"][name="${input.name}"]`
              )
            );

            const realCbs        = allCbs.filter(cb => cb.getAttribute(FILTER_VALUE) !== '');
            const vseCb          = allCbs.find(cb => cb.getAttribute(FILTER_VALUE) === '');
            const anyRealChecked = realCbs.some(cb => cb.checked);

            allCbs.forEach(cb => setCheckbox(cb, cb.checked));
            if (vseCb) setCheckbox(vseCb, !anyRealChecked);

            updateDropdownToggleText(input);
            applyFilters();
          }, 0);
        }
      });
    });

    // ── Sync pre-checked radios on init ──
    document.querySelectorAll(`input[type="radio"]`).forEach(input => {
      if (!input.checked) return;
      const isExact       = input.hasAttribute(FILTER_VALUE);
      const isRangeBucket = input.hasAttribute('wf-value-min') || input.hasAttribute('wf-value-max');
      if (!isExact && !isRangeBucket) return;
      const activeClass = input.getAttribute(FILTER_ACTIVE) || 'is-active';
      input.closest('label')?.classList.add(activeClass);
      updateDropdownToggleText(input);
    });

    // ── Sync pre-checked checkboxes on init ──
    document.querySelectorAll(`input[type="checkbox"]`).forEach(input => {
      if (!input.checked) return;
      if (!input.hasAttribute(FILTER_VALUE)) return;
      setCheckbox(input, true);
    });

    // ── Range sliders ──
    document.querySelectorAll(`input[type="range"][${FILTER_VALUE}]`).forEach(slider => {
      const field = slider.getAttribute(FILTER_VALUE);
      const mode  = slider.getAttribute('wf-filter-mode') || 'min';

      const values = [];
      document.querySelectorAll(`[${LIST_ELEMENT}="list"] [role="listitem"]`).forEach(item => {
        const nodes = Array.from(item.querySelectorAll(`[${FILTER_VALUE}="${field}"]`))
          .filter(n => n.tagName !== 'INPUT');
        if (nodes.length === 0) return;
        const raw = parseFloat(nodes[nodes.length - 1].textContent.trim());
        if (!isNaN(raw)) values.push(raw);
      });

      if (values.length > 0) {
        slider.min  = Math.min(...values).toFixed(4);
        slider.max  = Math.max(...values).toFixed(4);
      } else {
        slider.min  = '0.00';
        slider.max  = '1.00';
      }

      slider.step  = '0.001';
      slider.value = mode === 'max' ? slider.max : slider.min;
      sliderState[field] = parseFloat(slider.value);
      updateSliderUI(slider);

      slider.addEventListener('input', () => {
        sliderState[field] = parseFloat(slider.value);
        updateSliderUI(slider);
        applyFilters();
      });
    });

    // ── Clear buttons ──
    document.querySelectorAll(`[${LIST_ELEMENT}="clear"]`).forEach(btn => {
      btn.addEventListener('click', e => { e.preventDefault(); clearFilters(); });
    });

    // ── Sort ──
    initSort();

    // ── Load more / pagination ──
    loadInfo.forEach((info, list) => {
      const override = parseInt(list.getAttribute('wf-page-size'), 10);
      const pageSize = override > 0 ? override : (info.firstPageSize || 9);

      if (list.getAttribute('wf-load') === 'pagination') initPagination(list, pageSize, info);
      else initLoadMore(list, pageSize);
    });

    updateEmptyFacets();
    applyFilters({ resetPage: false }); // keep the page the visitor landed on

    // ── Remove loading state from wrapper ──
    document.querySelectorAll(`[${LIST_ELEMENT}="wrapper"]`).forEach(el => {
      el.classList.remove('is-loading');
    });
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init)
    : init();
})();
