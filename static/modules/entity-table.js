import { appState } from './state.js';
import { showToast } from './utils.js';

// Injected callback — set via initEntityTable(); default is a no-op placeholder
let _schedulePreviewUpdate = () => {};

// Guard against double-initialization (multiple calls would duplicate event listeners)
let _initialized = false;

// Cache the label counter element once at module load time
const labelCounter = document.getElementById('label-counter');

/**
 * Initialize entity-table module with required callbacks.
 * Must be called once, after schedulePreviewUpdate is defined in app.js.
 *
 * @param {{ schedulePreviewUpdate: () => void }} callbacks
 */
export function initEntityTable({ schedulePreviewUpdate }) {
  if (_initialized) return;
  _initialized = true;
  _schedulePreviewUpdate = schedulePreviewUpdate;

  // ── Entity table event listeners ──────────────────────────────────

  document.getElementById('entities-tbody').addEventListener('input', () => {
    updateCounter();
    _schedulePreviewUpdate();
    autoSaveTable();
  });

  document.getElementById('entities-tbody').addEventListener('paste', (e) => {
    const target = e.target;
    if (!target.classList.contains('entity-input')) return;

    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    // Filter out blank lines including whitespace-only ones (inherited fix)
    const pasteRows = text.split(/\r?\n/).filter(r => r.trim() !== '');
    if (pasteRows.length === 0) return;
    const pasteData = pasteRows.map(r => r.split('\t'));

    const tbody = document.getElementById('entities-tbody');
    const allRows = Array.from(tbody.querySelectorAll('tr'));
    const focusedRow = target.closest('tr');
    const startRowIdx = allRows.indexOf(focusedRow);
    if (startRowIdx < 0) return;

    const rowInputs = Array.from(focusedRow.querySelectorAll('input.entity-input'));
    const startColIdx = rowInputs.indexOf(target);
    if (startColIdx < 0) return;

    // Pre-add all required rows before iterating to avoid repeated querySelectorAll (O(nu00b2) u2192 O(n))
    const totalRowsNeeded = startRowIdx + pasteData.length;
    let currentRows = Array.from(tbody.querySelectorAll('tr'));
    while (currentRows.length < totalRowsNeeded) {
      addEntityRow();
      currentRows = Array.from(tbody.querySelectorAll('tr'));
    }

    pasteData.forEach((cols, ri) => {
      const tr = currentRows[startRowIdx + ri];
      const inputs = tr.querySelectorAll('input.entity-input');
      cols.forEach((val, ci) => {
        const colIdx = startColIdx + ci;
        if (colIdx < inputs.length) {
          inputs[colIdx].value = val;
        }
      });
    });

    updateCounter();
    _schedulePreviewUpdate();
    autoSaveTable();
  });

  document.getElementById('btn-add-entity-row').addEventListener('click', () => {
    addEntityRow();
    updateCounter();
    _schedulePreviewUpdate();
    autoSaveTable();
  });

  document.getElementById('btn-add-entity-col').addEventListener('click', () => {
    appState.entityColumnCount += 1;
    renderTableHeader();

    const tbody = document.getElementById('entities-tbody');
    tbody.querySelectorAll('tr').forEach((tr) => {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'entity-input form-control form-control-sm';
      td.appendChild(input);
      tr.insertBefore(td, tr.lastElementChild);
    });

    _schedulePreviewUpdate();
    autoSaveTable();
  });

  document.getElementById('btn-clear-table').addEventListener('click', () => {
    const tbody = document.getElementById('entities-tbody');
    tbody.innerHTML = '';
    addEntityRow();
    updateCounter();
    _schedulePreviewUpdate();
    localStorage.removeItem('lm_table');
  });
}

/** Render (or re-render) the entity table header row based on current column count. */
export function renderTableHeader() {
  const headRow = document.getElementById('entities-thead-row');
  headRow.innerHTML = '';

  for (let i = 0; i < appState.entityColumnCount; i += 1) {
    const th = document.createElement('th');
    const label = document.createElement('span');
    label.textContent = `%E${i + 1}%`;

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn-delete-col';
    deleteBtn.textContent = '✕';
    deleteBtn.title = 'Delete column';
    deleteBtn.setAttribute('aria-label', 'Delete column');
    deleteBtn.dataset.colIndex = String(i);
    deleteBtn.addEventListener('click', () => {
      if (appState.entityColumnCount <= 1) {
        showToast('At least one column must remain.', 'warning');
        return;
      }

      // Use the closed-over loop variable directly instead of re-parsing the data attribute
      const colIndex = i;
      if (colIndex < 0 || colIndex >= appState.entityColumnCount) return;

      const tbody = document.getElementById('entities-tbody');
      tbody.querySelectorAll('tr').forEach((tr) => {
        const cellToRemove = tr.children[colIndex];
        if (cellToRemove) {
          cellToRemove.remove();
        }
      });

      appState.entityColumnCount -= 1;
      renderTableHeader();
      updateCounter();
      autoSaveTable();
      _schedulePreviewUpdate();
    });

    th.appendChild(label);
    th.appendChild(deleteBtn);
    headRow.appendChild(th);
  }

  const actionTh = document.createElement('th');
  actionTh.style.width = '1%';
  headRow.appendChild(actionTh);
}

/** Append a new entity row to the entities table. */
export function addEntityRow(entities = []) {
  const tbody = document.getElementById('entities-tbody');
  const tr = document.createElement('tr');

  for (let i = 0; i < appState.entityColumnCount; i += 1) {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'entity-input form-control form-control-sm';
    input.value = entities[i] || '';
    td.appendChild(input);
    tr.appendChild(td);
  }

  const deleteCell = document.createElement('td');
  deleteCell.className = 'text-center';
  deleteCell.innerHTML = `
    <button type="button" class="btn btn-danger btn-sm btn-delete-row" title="Delete row" aria-label="Delete row">
      <i class="bi bi-trash"></i>
    </button>
  `;
  tr.appendChild(deleteCell);
  tbody.appendChild(tr);

  tr.querySelector('.btn-delete-row').addEventListener('click', () => {
    tr.remove();
    updateCounter();
    _schedulePreviewUpdate();
    autoSaveTable();
  });

  return tr;
}

/** Return array of non-empty entity rows. */
export function getRows() {
  const tbody = document.getElementById('entities-tbody');
  const rows = [];
  tbody.querySelectorAll('tr').forEach((tr) => {
    const inputs = tr.querySelectorAll('input.entity-input');
    const entities = [];
    for (let i = 0; i < appState.entityColumnCount; i += 1) {
      entities.push((inputs[i]?.value || '').trim());
    }
    if (entities.some(entity => entity !== '')) {
      rows.push({ entities });
    }
  });
  return rows;
}

/**
 * Read all entity table rows from the DOM and return them as a plain-object array.
 * Includes empty rows; used by autoSaveTable and captureCurrentState.
 *
 * @returns {{ entities: string[] }[]}
 */
export function serializeTableRows() {
  const tbody = document.getElementById('entities-tbody');
  const rows = [];
  tbody.querySelectorAll('tr').forEach((tr) => {
    const inputs = tr.querySelectorAll('input.entity-input');
    const entities = [];
    for (let i = 0; i < appState.entityColumnCount; i += 1) {
      entities.push(inputs[i]?.value || '');
    }
    rows.push({ entities });
  });
  return rows;
}

/** Persist all entity table rows to localStorage, including empty rows. */
export function autoSaveTable() {
  localStorage.setItem('lm_table', JSON.stringify({
    columnCount: appState.entityColumnCount,
    rows: serializeTableRows(),
  }));
}

/** Update the label count display. */
export function updateCounter() {
  const n = getRows().length;
  labelCounter.textContent = n === 1 ? '1 label loaded' : `${n} labels loaded`;
}
