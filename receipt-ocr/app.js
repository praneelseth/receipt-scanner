/**
 * Receipt OCR App – Modular implementation with UI, image preprocessing, Tesseract OCR, parsing, and exports.
 * All logic is encapsulated in IIFE modules and wired via the Ui module.
 */

(function() {
  // Utility
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.from(document.querySelectorAll(sel)); }
  function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }
  function round2(x) { return Math.round(x * 100) / 100; }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  // Module: ImageLoader
  const ImageLoader = (function() {
    let image = null, url = null, angle = 0;

    function loadFile(file, cb, errCb) {
      const reader = new FileReader();
      reader.onload = e => {
        loadUrl(e.target.result, cb, errCb);
      };
      reader.onerror = errCb;
      reader.readAsDataURL(file);
    }

    function loadUrl(imgUrl, cb, errCb) {
      const img = new window.Image();
      img.onload = () => {
        image = img;
        url = imgUrl;
        angle = 0;
        cb && cb(img);
      };
      img.onerror = errCb || (() => {});
      img.src = imgUrl;
    }

    function getImage() { return image; }
    function getUrl() { return url; }
    function getAngle() { return angle; }

    function rotate(delta) {
      angle = (angle + delta + 360) % 360;
    }

    function reset() {
      image = url = null;
      angle = 0;
    }

    return { loadFile, loadUrl, getImage, getUrl, getAngle, rotate, reset };
  })();

  // Module: Preprocessor
  const Preprocessor = (function() {
    function preprocess({ image, angle = 0, enhance = false }) {
      // Resize to max 2000px, grayscale, contrast stretch, (optionally threshold), rotation
      const maxDim = 2000;
      let w = image.width, h = image.height;
      let scale = Math.min(1, maxDim / Math.max(w, h));
      let nw = Math.round(w * scale), nh = Math.round(h * scale);

      // Create canvas
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      if (angle % 360 !== 0) {
        // Expand canvas to fit rotated image
        const rad = angle * Math.PI / 180;
        const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
        c.width = Math.round(nw * cos + nh * sin);
        c.height = Math.round(nw * sin + nh * cos);
        ctx.save();
        ctx.translate(c.width / 2, c.height / 2);
        ctx.rotate(rad);
        ctx.drawImage(image, -nw / 2, -nh / 2, nw, nh);
        ctx.restore();
      } else {
        c.width = nw;
        c.height = nh;
        ctx.drawImage(image, 0, 0, nw, nh);
      }

      // Grayscale
      let imgData = ctx.getImageData(0, 0, c.width, c.height);
      let d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        // Luminance
        let v = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
        d[i] = d[i+1] = d[i+2] = v;
      }
      // Contrast stretch
      if (enhance) {
        let min = 255, max = 0;
        for (let i = 0; i < d.length; i += 4) {
          let v = d[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
        let range = max - min || 1;
        for (let i = 0; i < d.length; i += 4) {
          let v = (d[i] - min) * 255 / range;
          d[i] = d[i+1] = d[i+2] = v;
        }
        // Optionally add thresholding for very noisy images
        // (Not enabled by default)
      }
      ctx.putImageData(imgData, 0, 0);
      return c;
    }
    return { preprocess };
  })();

  // Module: OcrService
  const OcrService = (function() {
    let worker = null;
    let busy = false;

    async function init() {
      if (!worker) {
        worker = Tesseract.createWorker({
          logger: m => { if (OcrService.onProgress) OcrService.onProgress(m); }
        });
        await worker.load();
        await worker.loadLanguage('eng');
        await worker.initialize('eng');
      }
    }

    async function recognize(canvas) {
      if (busy) throw new Error('OCR is already running.');
      busy = true;
      try {
        await init();
        const { data } = await worker.recognize(canvas);
        return data.text;
      } finally {
        busy = false;
      }
    }

    async function terminate() {
      if (worker) {
        await worker.terminate();
        worker = null;
      }
    }

    return { recognize, terminate, onProgress: null };
  })();

  // Module: WalmartExpander
  const WalmartExpander = (function() {
    // Glossary of abbreviations/expansions
    const GLOSSARY = {
      "GLCRY": "Grocery",
      "PRD": "Produce",
      "FRZN": "Frozen",
      "BKRY": "Bakery",
      "DAIRY": "Dairy",
      "MEAT": "Meat",
      "DEL": "Deli",
      "PHRM": "Pharmacy",
      "HBA": "Health & Beauty",
      "ELEC": "Electronics",
      "CLTH": "Clothing",
      "HSHLD": "Household",
      "LWNGRD": "Lawn & Garden",
      "OTC": "Over-the-counter",
      "BEEF": "Beef",
      "CHK": "Chicken",
      "PORK": "Pork",
      "TAX1": "Tax 1",
      "TAX2": "Tax 2",
      "SUBTL": "Subtotal"
    };
    function expandAbbreviations(text) {
      return text.replace(/\b([A-Z]{3,6})\b/g, (m, abbr) =>
        GLOSSARY[abbr] ? GLOSSARY[abbr] : abbr
      );
    }
    return { expandAbbreviations };
  })();

  // Module: Parser
  const Parser = (function() {
    // Main method to parse raw OCR text into structured table rows
    function parseOcrText(rawText, walmartMode) {
      let lines = rawText.split(/\n/).map(l => l.trim()).filter(l => !!l);
      // Merge wrapped lines: lines ending with non-price and next line not starting with price
      for (let i = 0; i < lines.length - 1; ++i) {
        if (!priceAtEnd(lines[i]) && !lines[i+1].match(/^\d+(\.\d{2})?\b/)) {
          lines[i] += " " + lines[i+1];
          lines.splice(i+1,1);
          i--;
        }
      }
      // Remove headers/footers, filter out non-item lines
      lines = lines.filter(line =>
        // Must contain a price at end, or look like an item line
        priceAtEnd(line) && !/TOTAL|SUBTOTAL|CREDIT|DEBIT|CHANGE|BALANCE|TAX/i.test(line)
      );
      // Parse lines
      let rows = [];
      for (const line of lines) {
        let qty = 1, desc = "", unit = "", total = "";
        let l = line;
        // Walmart SKU: Numeric-only line, skip (handled below)
        if (/^\d{5,}$/.test(l)) continue;
        // Pattern: <desc> x2 @ 1.99 3.98
        let m = l.match(/^(.+?)\s+[xX](\d+)\s*@\s*(\d+(\.\d{2})?)\s+(\d+(\.\d{2})?)$/);
        if (m) {
          desc = m[1]; qty = +m[2]; unit = m[3]; total = m[5];
        } else if ((m = l.match(/^(.+?)\s+(\d+(\.\d{2})?)$/))) {
          // <desc> <price>
          desc = m[1]; total = m[2];
        } else if ((m = l.match(/^(.+?)\s+(\d+)\s+(\d+(\.\d{2})?)$/))) {
          // <desc> <qty> <price>
          desc = m[1]; qty = +m[2]; total = m[3];
        } else if ((m = l.match(/^(.+?)\s+(\d+(\.\d{2})?)\s+(\d+(\.\d{2})?)$/))) {
          // <desc> <unit> <total>
          desc = m[1]; unit = m[2]; total = m[4];
        } else {
          // Fallback: try to find trailing price
          m = l.match(/(.+?)\s+(\d+\.\d{2})$/);
          if (m) {
            desc = m[1]; total = m[2];
          } else {
            desc = l; total = "";
          }
        }
        desc = desc.replace(/\s{2,}/g, " ").trim();
        // Expand Walmart abbreviations if in Walmart mode
        if (walmartMode) desc = WalmartExpander.expandAbbreviations(desc);

        // Clean up
        if (!desc || !total) continue;
        if (qty === 1 && (desc.match(/x\d+\s*@/) || desc.match(/\d+\/\d+\s*@/))) {
          // Remove redundant qty markers in desc (e.g. x2 @)
          desc = desc.replace(/x\d+\s*@\s*\d+(\.\d{2})?/, '').trim();
        }
        rows.push({
          description: desc,
          quantity: qty,
          unitPrice: unit,
          lineTotal: total
        });
      }
      return rows;
    }
    function priceAtEnd(line) {
      return /\d+\.\d{2}$/.test(line);
    }
    return { parseOcrText };
  })();

  // Module: Ui
  const Ui = (function() {
    // Elements
    const dropArea = $('#drop-area');
    const fileInput = $('#file-input');
    const trySampleBtn = $('#try-sample-btn');
    const previewCanvas = $('#preview-canvas');
    const previewImg = $('#preview-img');
    const rotateLeftBtn = $('#rotate-left');
    const rotateRightBtn = $('#rotate-right');
    const enhanceToggle = $('#enhance-toggle');
    const walmartToggle = $('#walmart-toggle');
    const startOcrBtn = $('#start-ocr');
    const clearBtn = $('#clear-btn');
    const progressText = $('#progress-text');
    const errorBanner = $('#error-banner');
    const resultsSection = $('#results-section');
    const resultsTable = $('#results-table');
    const subtotalCell = $('#subtotal-cell');
    const taxCell = $('#tax-cell');
    const grandTotalCell = $('#grandtotal-cell');
    const exportCsvBtn = $('#export-csv');
    const exportJsonBtn = $('#export-json');

    // State
    let currentRows = [];
    let enhance = false, walmartMode = false;
    let isOcrRunning = false;

    // Drag & drop logic
    dropArea.addEventListener('dragover', e => {
      e.preventDefault();
      dropArea.classList.add('dragover');
    });
    dropArea.addEventListener('dragleave', e => {
      e.preventDefault();
      dropArea.classList.remove('dragover');
    });
    dropArea.addEventListener('drop', e => {
      e.preventDefault();
      dropArea.classList.remove('dragover');
      if (e.dataTransfer.files.length) {
        handleFile(e.dataTransfer.files[0]);
      }
    });
    dropArea.addEventListener('click', e => {
      if (e.target === dropArea || e.target.classList.contains('drop-text') || e.target.classList.contains('drop-icon')) {
        fileInput.click();
      }
    });
    fileInput.addEventListener('change', e => {
      if (fileInput.files.length) {
        handleFile(fileInput.files[0]);
      }
    });
    trySampleBtn.addEventListener('click', () => {
      ImageLoader.reset();
      errorBanner.style.display = 'none';
      loadSample(() => {
        renderPreview();
        resetResults();
      }, showError);
    });

    // Image preview and controls
    rotateLeftBtn.addEventListener('click', () => { rotateImage(-90); });
    rotateRightBtn.addEventListener('click', () => { rotateImage(90); });
    enhanceToggle.addEventListener('change', () => {
      enhance = enhanceToggle.checked;
      renderPreview();
    });
    walmartToggle.addEventListener('change', () => {
      walmartMode = walmartToggle.checked;
      renderResults(currentRows);
    });
    clearBtn.addEventListener('click', clearAll);

    startOcrBtn.addEventListener('click', () => {
      if (!ImageLoader.getImage()) return showError('No image loaded.');
      runOcr();
    });

    exportCsvBtn.addEventListener('click', () => {
      exportCsv(currentRows);
    });
    exportJsonBtn.addEventListener('click', () => {
      exportJson(currentRows);
    });

    // Functions
    function handleFile(file) {
      errorBanner.style.display = 'none';
      ImageLoader.loadFile(file, img => {
        renderPreview();
        resetResults();
      }, showError);
    }

    function loadSample(cb, errCb) {
      ImageLoader.loadUrl('sample/receipt_sample.png', cb, errCb);
    }

    function renderPreview() {
      const img = ImageLoader.getImage();
      if (!img) {
        previewCanvas.style.display = 'none';
        previewImg.style.display = 'none';
        return;
      }
      // Preprocess and show on canvas
      const canvas = Preprocessor.preprocess({
        image: img,
        angle: ImageLoader.getAngle(),
        enhance
      });
      previewCanvas.width = canvas.width;
      previewCanvas.height = canvas.height;
      previewCanvas.getContext('2d').drawImage(canvas, 0, 0);
      previewCanvas.style.display = '';
      previewImg.style.display = 'none';
    }

    function rotateImage(delta) {
      if (!ImageLoader.getImage()) return;
      ImageLoader.rotate(delta);
      renderPreview();
    }

    function clearAll() {
      ImageLoader.reset();
      previewCanvas.style.display = 'none';
      previewImg.style.display = 'none';
      fileInput.value = '';
      resetResults();
      errorBanner.style.display = 'none';
      enhanceToggle.checked = false;
      walmartToggle.checked = false;
      enhance = false;
      walmartMode = false;
      progressText.textContent = '';
    }

    function resetResults() {
      currentRows = [];
      resultsSection.style.display = 'none';
      renderTable([]);
    }

    function showError(msg) {
      errorBanner.textContent = msg;
      errorBanner.style.display = '';
    }

    function runOcr() {
      if (isOcrRunning) return;
      isOcrRunning = true;
      progressText.textContent = 'Preprocessing image...';
      errorBanner.style.display = 'none';
      // Preprocess
      const img = ImageLoader.getImage();
      if (!img) return showError('No image loaded.');
      const canvas = Preprocessor.preprocess({
        image: img,
        angle: ImageLoader.getAngle(),
        enhance
      });
      // OCR
      progressText.textContent = 'Running OCR...';
      OcrService.onProgress = m => {
        if (m.progress) {
          progressText.textContent =
            (m.status ? m.status + ': ' : '') +
            Math.floor(m.progress * 100) + '%';
        } else if (m.status) {
          progressText.textContent = m.status;
        }
      };
      OcrService.recognize(canvas).then(text => {
        progressText.textContent = 'Parsing...';
        // Post-process/parse
        let rows = Parser.parseOcrText(text, walmartMode);
        currentRows = rows;
        renderResults(rows);
        progressText.textContent = 'Done!';
        isOcrRunning = false;
      }).catch(e => {
        showError('OCR failed: ' + (e && e.message || e));
        isOcrRunning = false;
      });
    }

    function renderResults(rows) {
      resultsSection.style.display = '';
      renderTable(rows);
      computeTotals(rows);
    }

    function renderTable(rows) {
      const tbody = resultsTable.querySelector('tbody');
      tbody.innerHTML = '';
      (rows || []).forEach((row, rowIdx) => {
        const tr = document.createElement('tr');
        ['description', 'quantity', 'unitPrice', 'lineTotal'].forEach((key, colIdx) => {
          const td = document.createElement('td');
          td.textContent = row[key];
          td.className = "editable-cell";
          td.addEventListener('click', () => activateCellEdit(td, rowIdx, key));
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }

    function activateCellEdit(td, rowIdx, key) {
      const prev = td.textContent;
      td.innerHTML = '';
      const input = document.createElement('input');
      input.type = (key === 'quantity' || key === 'unitPrice' || key === 'lineTotal') ? 'number' : 'text';
      input.value = prev;
      input.className = 'edit-input';
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') input.blur();
      });
      input.addEventListener('blur', () => {
        currentRows[rowIdx][key] = input.value;
        renderTable(currentRows);
        computeTotals(currentRows);
      });
      td.appendChild(input);
      input.focus();
      input.select();
    }

    function computeTotals(rows) {
      let subtotal = 0, tax = 0, grandTotal = 0;
      rows.forEach(r => {
        let n = parseFloat(r.lineTotal);
        if (!isNaN(n)) subtotal += n;
      });
      // Attempt to infer tax and grand total from OCR text, else set to 0
      tax = round2(subtotal * 0.07);
      grandTotal = round2(subtotal + tax);
      subtotalCell.textContent = subtotal.toFixed(2);
      taxCell.textContent = tax.toFixed(2);
      grandTotalCell.textContent = grandTotal.toFixed(2);
    }

    function exportCsv(rows) {
      let csv = 'Description,Quantity,Unit Price,Line Total\n';
      rows.forEach(r => {
        csv += [r.description, r.quantity, r.unitPrice, r.lineTotal].map(x =>
          '"' + ('' + x).replace(/"/g, '""') + '"'
        ).join(',') + '\n';
      });
      downloadText(csv, 'receipt.csv', 'text/csv');
    }
    function exportJson(rows) {
      downloadText(JSON.stringify(rows, null, 2), 'receipt.json', 'application/json');
    }
    function downloadText(text, filename, type) {
      const blob = new Blob([text], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    }

    // Init: Try to load sample on first visit
    (function init() {
      // Responsive preview: fit inside card
      window.addEventListener('resize', debounce(renderPreview, 200));
    })();

    return {};
  })();
})();