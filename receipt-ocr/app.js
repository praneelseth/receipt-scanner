const imageInput = document.getElementById('imageInput');
const imagePreview = document.getElementById('imagePreview');
const runOcrBtn = document.getElementById('runOcrBtn');
const ocrResult = document.getElementById('ocrResult');

let selectedImage = null;

imageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        selectedImage = file;
        const reader = new FileReader();
        reader.onload = function(ev) {
            imagePreview.innerHTML = `<img src="${ev.target.result}" alt="Preview" />`;
        };
        reader.readAsDataURL(file);
        runOcrBtn.disabled = false;
    } else {
        imagePreview.innerHTML = '';
        runOcrBtn.disabled = true;
        selectedImage = null;
    }
});

runOcrBtn.addEventListener('click', async () => {
    if (!selectedImage) return;
    ocrResult.textContent = "Running OCR, please wait...";
    // Example using Tesseract.js in browser
    if (typeof Tesseract === 'undefined') {
        ocrResult.textContent = "OCR engine not loaded. Please include Tesseract.js library.";
        return;
    }
    const reader = new FileReader();
    reader.onload = function(ev) {
        Tesseract.recognize(
            ev.target.result,
            'eng',
            { logger: m => { /* optionally log progress */ } }
        ).then(({ data: { text } }) => {
            ocrResult.textContent = text;
        }).catch(err => {
            ocrResult.textContent = "Error running OCR: " + err;
        });
    };
    reader.readAsDataURL(selectedImage);
});