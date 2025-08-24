/**
 * Receipt OCR App - Pure client-side, modular, no build step.
 * Modules: ImageLoader, Preprocessor, OcrService, Parser, WalmartExpander, Ui
 */
(() => {
'use strict';

//// ImageLoader ////
const ImageLoader = (() => {
  let image = null, origDataUrl = null, rotation = 0;

  function loadFromFile(file, cb, errCb) {
    const reader = new FileReader();
    reader.onload = () => {
      origDataUrl = reader.result;
      image = new window.Image();
      image.onload = () => {
        rotation = 0;
        cb(image);
      };
      image.onerror = errCb;
      image.src = origDataUrl;
    };
    reader.onerror = errCb;
    reader.readAsDataURL(file);
  }
  function loadFromUrl(url, cb, errCb) {
    image = new window.Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      origDataUrl = url;
      rotation = 0;
      cb(image);
    };
    image.onerror = errCb;
    image.src = url;
  }
  function getImage() { return image; }
  function getOrigDataUrl() { return origDataUrl; }
  function getRotation() { return rotation; }
  function setRotation(deg) { rotation = (deg + 360) % 360; }
  function clear() {
    image = null; origDataUrl = null; rotation = 0;
  }
  return { loadFromFile, loadFromUrl, getImage, getOrigDataUrl, getRotation, setRotation, clear };
})();

//// Preprocessor ////
const Preprocessor = (() => {
  function process(image, opts, cb) {
    // Limit to 2000px on longest side
    const maxDim = 2000;
    let [w, h] = [image.width, image.height];
    let scale = Math.min(1, maxDim/Math.max(w,h));
    w = Math.round(w*scale); h = Math.round(h*scale);

    // Create canvas, rotate if needed
    let offcanvas = document.createElement('canvas');
    let ctx = offcanvas.getContext('2d');
    let degrees = opts.rotation || 0;
    if (degrees % 180 === 0) {
      offcanvas.width = w;
      offcanvas.height = h;
      ctx.save();
      ctx.clearRect(0,0,w,h);
      ctx.translate(w/2, h/2);
      ctx.rotate(degrees * Math.PI / 180);
      ctx.drawImage(image, -w/2, -h/2, w, h);
      ctx.restore();
    } else {
      offcanvas.width = h;
      offcanvas.height = w;
      ctx.save();
      ctx.clearRect(0,0,h,w);
      ctx.translate(h/2, w/2);
      ctx.rotate(degrees * Math.PI / 180);
      ctx.drawImage(image, -w/2, -h/2, w, h);
      ctx.restore();
    }
    if (opts.enhance) {
      // Grayscale
      let imgData = ctx.getImageData(0,0,offcanvas.width,offcanvas.height);
      let d = imgData.data;
      for(let i=0; i<d.length; i+=4) {
        let v = 0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];
        d[i]=d[i+1]=d[i+2]=v;
      }
      // Contrast stretch
      let min=255,max=0;
      for(let i=0;i<d.length;i+=4) {
        min = Math.min(min, d[i]);
        max = Math.max(max, d[i]);
      }
      let delta = max-min || 1;
      for(let i=0;i<d.length;i+=4) {
        let v = (d[i]-min)*255/delta;
        d[i]=d[i+1]=d[i+2]=v;
      }
      // Adaptive threshold (simple: global threshold at mean)
      if (opts.threshold) {
        let sum=0; for(let i=0;i<d.length;i+=4) sum+=d[i];
        let mean = sum/(d.length/4);
        for(let i=0;i<d.length;i+=4) {
          let v = d[i]>mean?255:0;
          d[i]=d[i+1]=d[i+2]=v;
        }
      }
      ctx.putImageData(imgData,0,0);
    }
    cb(offcanvas);
  }
  return { process };
})();

//// OcrService ////
const OcrService = (() => {
  let worker = null, busy = false;
  function ensureWorker() {
    if (!worker) {
      worker = Tesseract.createWorker({
        logger: m => {
          if (onProgress) onProgress(m);
        }
      });
    }
    return worker;
  }
  let onProgress = null;
  function setProgressHandler(handler) { onProgress = handler; }
  async function recognize(canvas) {
    busy = true;
    const w = ensureWorker();
    await w.load();
    await w.loadLanguage('eng');
    await w.initialize('eng');
    let resp = await w.recognize(canvas);
    busy = false;
    return resp;
  }
  function isBusy() { return busy; }
  async function terminate() {
    if (worker) {
      await worker.terminate();
      worker = null;
    }
  }
  return { recognize, setProgressHandler, isBusy, terminate };
})();

//// WalmartExpander ////
const WalmartExpander = (() => {
  // Modular, easy to extend
  const glossary = {
    "GAL": "Gallon", "MLK": "Milk", "STRWB": "Strawberry", "WHT": "White", "CHK": "Chicken",
    "TND": "Ground", "GRND": "Ground", "LRG": "Large", "MED": "Medium", "SM": "Small", "LT": "Light", "W/": "with",
    "OG": "Organic", "MLTGRN": "Multigrain", "SPGH": "Spaghetti", "PNT": "Peanut", "BTR": "Butter", "CTN": "Carton",
    "PK": "Pack", "EA": "Each", "CN": "Can", "TOM": "Tomato", "ONN": "Onion", "ONI": "Onion", "POT": "Potato",
    "RST": "Roasted", "BRST": "Breast", "THG": "Thigh", "BNS": "Boneless", "SKL": "Skinless", "SHR": "Shrimp",
    "GR": "Green", "APP": "Apple", "ORG": "Orange", "STK": "Steak", "BRD": "Bread", "CHZ": "Cheese", 
    "CRK": "Cracker", "HRB": "Herb", "VEG": "Vegetable", "YGT": "Yogurt", "CBC": "Cabbage", "CAR": "Carrot"
  };

  function expandAbbreviations(desc) {
    // Tokenize by non-word or /
    let tokens = desc.split(/[\s/,-]+/g);
    let expanded = tokens.map(t => {
      let key = t.toUpperCase();
      if (/^\d+%$/.test(key)) return t; // percent values
      if (glossary[key]) return glossary[key];
      // handle W/ as "with"
      if (key === "W/") return "with";
      return t;
    });
    // Title case result
    let str = expanded.join(' ');
    return str.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.substr(1).toLowerCase());
  }
  return { expandAbbreviations };
})();

//// Parser ////
const Parser = (() => {
  const NON_ITEM_WORDS = [
    "SUBTOTAL", "TOTAL", "TAX", "CHANGE", "CASH", "CREDIT", "DEBIT", "AUTH", "APPROVAL", "CARD",
    "BALANCE", "SAVINGS", "COUPON", "VENDOR", "STORE", "VISIT", "SURVEY", "WWW", "HTTP", "THANK",
    "RETURN", "REFUND", "ITEM COUNT"
  ];
  const NON_ITEM_RE = new RegExp(NON_ITEM_WORDS.join("|"), "i");

  function parseOcrText(text, walmartMode) {
    let lines = text.split(/\r?\n/).map(l => l.trim().replace(/\s{2,}/g,' ')).filter(Boolean);
    let items = [];
    let detected = { subtotal: null, taxes: [], total: null };
    let prevDescIdx = -1;
    let rawLines = [...lines];
    let i = 0;
    while (i < lines.length) {
      let line = lines[i];
      if (!line || NON_ITEM_RE.test(line)) {
        // Extract subtotal/tax/total if present
        if (/SUBTOTAL/i.test(line)) {
          let price = extractPrice(line);
          if (price) detected.subtotal = price;
        } else if (/TAX/i.test(line)) {
          let price = extractPrice(line);
          if (price) detected.taxes.push({label:"Tax", value: price});
        } else if (/TOTAL/i.test(line)) {
          let price = extractPrice(line);
          if (price) detected.total = price;
        }
        i++; continue;
      }
      // Item line: look for price at end
      let priceMatch = line.match(/(?:\$?\s*)(\d{1,4}[.,]\d{2})\s*$/);
      if (priceMatch) {
        let priceStr = priceMatch[1].replace(',', '.');
        let price = parseFloat(priceStr);
        // Look for qty/unit: e.g. "x2 @ 1.99" or "2 @ 1.99"
        let qty = 1, unit = price, desc = line.replace(/(?:\$?\s*\d{1,4}[.,]\d{2})\s*$/, '').trim(), sku=null;
        let qtyMatch = line.match(/(?:^|\s)(?:x)?(\d+)\s*@\s*(\d{1,4}[.,]\d{2})/i);
        if (qtyMatch) {
          qty = parseInt(qtyMatch[1]);
          unit = parseFloat(qtyMatch[2].replace(',', '.'));
        }
        // Prefer rightmost price as line total, infer unit if possible
        if (qtyMatch && price !== unit && qty > 0) {
          unit = +(price/qty).toFixed(2);
        }
        // Merge with preceding uppercase fragment (wrapped description)
        if (i > 0 && /^[A-Z0-9 &\-]{3,20}$/.test(lines[i-1]) && !extractPrice(lines[i-1])) {
          desc = lines[i-1] + ' ' + desc;
          i--; // skip prev line next loop
        }
        // Walmart: check for numeric-only next line (sku/upc)
        if (walmartMode && i+1<lines.length && /^\d{8,14}$/.test(lines[i+1])) {
          sku = lines[i+1];
          i++;
        }
        // Clean description: remove trailing 8-14 digit tokens
        desc = desc.replace(/\b\d{8,14}\b/g, '').replace(/\s{2,}/g,' ').trim();
        // Walmart expansion
        if (walmartMode) {
          desc = WalmartExpander.expandAbbreviations(desc);
        }
        items.push({ description: desc, qty, unit, total: +(qty*unit).toFixed(2), sku, orig: line });
      }
      i++;
    }
    // Remove empty desc items
    items = items.filter(it => it.description && !NON_ITEM_RE.test(it.description));
    return { items, detected };
  }

  function extractPrice(line) {
    let m = line.match(/(?:\$?\s*)(\d{1,4}[.,]\d{2})\s*$/);
    return m ? parseFloat(m[1].replace(',', '.')) : null;
  }
  return { parseOcrText };
})();

//// Ui ////
const Ui = (() => {
  const els = {
    drop: document.getElementById('drop-area'),
    file: document.getElementById('file-input'),
    imgPreview: document.getElementById('img-preview'),
    imgCanvas: document.getElementById('img-canvas'),
    enhance: document.getElementById('enhance'),
    walmart: document.getElementById('walmart-mode'),
    rotateLeft: document.getElementById('rotate-left'),
    rotateRight: document.getElementById('rotate-right'),
    startOcr: document.getElementById('start-ocr'),
    clear: document.getElementById('clear'),
    progress: document.getElementById('progress'),
    progressText: document.getElementById('progress-text'),
    errorBanner: document.getElementById('error-banner'),
    errorMsg: document.getElementById('error-msg'),
    dismissError: document.getElementById('dismiss-error'),
    resultsSection: document.getElementById('results-section'),
    resultsTable: document.getElementById('results-table'),
    exportCsv: document.getElementById('export-csv'),
    exportJson: document.getElementById('export-json'),
    trySample: document.getElementById('try-sample-btn')
  };

  // Drag-and-drop
  els.drop.addEventListener('dragover', e => {
    e.preventDefault(); e.dataTransfer.dropEffect = "copy";
    els.drop.classList.add('dragover');
  });
  els.drop.addEventListener('dragleave', e => {
    els.drop.classList.remove('dragover');
  });
  els.drop.addEventListener('drop', e => {
    e.preventDefault(); els.drop.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      onFile(e.dataTransfer.files[0]);
    }
  });
  els.file.addEventListener('change', e => {
    if (els.file.files[0]) onFile(els.file.files[0]);
  });

  // Try sample
  els.trySample.addEventListener('click', e => {
    ImageLoader.loadFromUrl('sample/receipt_sample.png', img => {
      setImagePreview(img);
    }, showError);
  });

  // Controls
  els.rotateLeft.addEventListener('click', () => rotate(-90));
  els.rotateRight.addEventListener('click', () => rotate(90));
  els.enhance.addEventListener('change', () => refreshCanvas());
  els.walmart.addEventListener('change', () => {}); // nothing needed
  els.clear.addEventListener('click', clearAll);
  els.startOcr.addEventListener('click', startOcr);

  // Dismiss error
  els.dismissError.addEventListener('click', () => {
    els.errorBanner.style.display = 'none';
  });

  let currentCanvas = null;
  function onFile(file) {
    if (!file.type.startsWith('image/')) {
      showError('Only image files are supported.');
      return;
    }
    ImageLoader.loadFromFile(file, img => {
      setImagePreview(img);
    }, showError);
  }

  function setImagePreview(img) {
    refreshCanvas();
    els.imgPreview.src = ImageLoader.getOrigDataUrl();
    els.imgPreview.style.display = 'block';
    els.imgCanvas.style.display = 'none';
    els.resultsSection.style.display = "none";
  }

  function refreshCanvas() {
    let img = ImageLoader.getImage();
    if (!img) return;
    const opts = {
      enhance: els.enhance.checked,
      rotation: ImageLoader.getRotation(),
      threshold: true
    };
    Preprocessor.process(img, opts, canvas => {
      els.imgCanvas.width = canvas.width;
      els.imgCanvas.height = canvas.height;
      els.imgCanvas.getContext('2d').drawImage(canvas, 0, 0);
      els.imgCanvas.style.display = 'block';
      els.imgPreview.style.display = 'none';
      currentCanvas = canvas;
    });
  }

  function rotate(delta) {
    if (!ImageLoader.getImage()) return;
    let rot = (ImageLoader.getRotation() + delta + 360) % 360;
    ImageLoader.setRotation(rot);
    refreshCanvas();
  }

  function clearAll() {
    ImageLoader.clear();
    els.imgPreview.src = '';
    els.imgPreview.style.display = 'none';
    els.imgCanvas.style.display = 'none';
    els.resultsSection.style.display = "none";
    els.progressText.textContent = '';
    els.file.value = '';
    hideError();
  }

  function showError(msg) {
    els.errorBanner.style.display = 'flex';
    els.errorMsg.textContent = msg;
  }
  function hideError() {
    els.errorBanner.style.display = 'none';
  }

  // OCR progress
  OcrService.setProgressHandler(m => {
    if (m.status) {
      let pct = m.progress ? Math.round(m.progress*100) : '';
      els.progressText.textContent = m.status + (pct ? ` (${pct}%)` : '');
    }
  });

  // OCR start
  async function startOcr() {
    if (!ImageLoader.getImage()) {
      showError('Please upload a receipt image.');
      return;
    }
    hideError();
    els.progressText.textContent = 'Initializing...';
    let canvas = document.createElement('canvas');
    refreshCanvas();
    canvas.width = els.imgCanvas.width;
    canvas.height = els.imgCanvas.height;
    canvas.getContext('2d').drawImage(els.imgCanvas, 0, 0);
    try {
      let { data: { text } } = await OcrService.recognize(canvas);
      renderResults(text);
    } catch (e) {
      showError('OCR failed. Please try with a clearer image.');
    } finally {
      els.progressText.textContent = '';
    }
  }

  function renderResults(text) {
    let walmartMode = els.walmart.checked;
    let { items, detected } = Parser.parseOcrText(text, walmartMode);
    if (!items.length) {
      showError('No items detected. Try enhancing image or rotating.');
      return;
    }
    renderTable(items, detected);
    els.resultsSection.style.display = "block";
  }

  function renderTable(items, detected) {
    let tb = els.resultsTable.querySelector('tbody');
    let tf = els.resultsTable.querySelector('tfoot');
    tb.innerHTML = '';
    tf.innerHTML = '';
    items.forEach((item, idx) => {
      let tr = document.createElement('tr');
      ['description','qty','unit','total'].forEach(field => {
        let td = document.createElement('td');
        td.textContent = item[field];
        td.dataset.field = field;
        td.dataset.idx = idx;
        td.tabIndex = 0;
        td.addEventListener('click', editCell);
        td.addEventListener('keydown', e => {
          if (e.key === 'Enter') editCell.call(td, e);
        });
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    // Subtotal, Taxes, Total
    let subtotal = sum(items.map(i=>i.total));
    let trow = document.createElement('tr');
    trow.innerHTML = `<td style="text-align:right;" colspan="3"><strong>Subtotal</strong></td><td>${subtotal.toFixed(2)}</td>`;
    tf.appendChild(trow);
    if (detected.taxes && detected.taxes.length) {
      detected.taxes.forEach(tax => {
        let ttr = document.createElement('tr');
        ttr.innerHTML = `<td style="text-align:right;" colspan="3"><strong>${tax.label}</strong></td><td>${tax.value.toFixed(2)}</td>`;
        tf.appendChild(ttr);
      });
    }
    if (detected.total) {
      let ttr = document.createElement('tr');
      ttr.innerHTML = `<td style="text-align:right;" colspan="3"><strong>Grand Total</strong></td><td>${detected.total.toFixed(2)}</td>`;
      tf.appendChild(ttr);
    }
    // Store for CSV/JSON export
    els.exportCsv.onclick = () => exportCsv(items);
    els.exportJson.onclick = () => exportJson(items);

    // Inline editing: update items array
    function editCell(e) {
      let td = e.currentTarget;
      let field = td.dataset.field, idx = +td.dataset.idx;
      let val = td.textContent;
      let input = document.createElement('input');
      input.type = (field === 'qty' || field === 'unit' || field === 'total') ? 'number' : 'text';
      input.value = val;
      input.style.width = '90%';
      input.addEventListener('blur', save);
      input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { input.blur(); }
        if (ev.key === 'Escape') { td.textContent = val; }
      });
      td.innerHTML = '';
      td.appendChild(input);
      input.focus();
      function save() {
        let newVal = input.value;
        if (field === 'qty' || field === 'unit' || field === 'total') {
          newVal = parseFloat(newVal) || 0;
        }
        items[idx][field] = newVal;
        // Update dependent totals
        if (field === 'qty' || field === 'unit') {
          items[idx].total = +(items[idx].qty * items[idx].unit).toFixed(2);
        }
        renderTable(items, detected);
      }
    }
  }

  function exportCsv(items) {
    let rows = [
      ['Description','Qty','Unit Price','Line Total'],
      ...items.map(i=>[i.description,i.qty,i.unit,i.total])
    ];
    let csv = rows.map(r => r.map(val => `"${(val+'').replace(/"/g,'""')}"`).join(',')).join('\r\n');
    download('receipt_items.csv', csv, 'text/csv');
  }
  function exportJson(items) {
    download('receipt_items.json', JSON.stringify(items, null, 2), 'application/json');
  }
  function download(filename, content, mime) {
    let blob = new Blob([content], {type: mime});
    let url = URL.createObjectURL(blob);
    let a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  }
  function sum(arr) {
    return arr.reduce((a,b)=>a+ (parseFloat(b)||0),0);
  }

  // Public API (none needed)
  return {};
})();

})(); // end main IIFE