import { generatePieces, initViewer, showPieces, exportAllSTL, exportMergedSTL, export3MFColored, loadModels } from '/model3d.js';

const MESHY_BASE  = 'https://api.meshy.ai';
const MESHY_KEY   = 'msy_nuoda1IScPx06JIZHvNuhN38WDYPE7z4gTrC';

const GEMINI_BASE  = '/gemini-proxy';
const GEMINI_KEY   = 'sk-fZlBimZDWmOFqZcA1jZEJiEXP75T1Ae3E04CDLcYrn410aHO';
const GEMINI_MODEL = 'gemini-3.1-pro-high';

const VARIANTS = [
  { prompt: 'pixel bead art, extremely coarse 10x10 pixel grid, very large square pixels, flat bold colors, no gradients, retro 8-bit style' },
  { prompt: 'pixel bead art, coarse 14x14 pixel grid, large square pixels, flat colors, no gradients, retro 16-bit style' },
  { prompt: 'pixel bead art, medium 17x17 pixel grid, square pixels, flat colors, no gradients, retro pixel art style' },
  { prompt: 'pixel bead art, fine 20x20 pixel grid, small square pixels, flat colors, no gradients, detailed retro pixel art' },
];

const SMALL_VARIANTS = [
  { prompt: 'pixel bead art, ultra coarse 6x6 pixel grid, huge square pixels, flat bold colors, no gradients, retro 8-bit style' },
  { prompt: 'pixel bead art, extremely coarse 7x7 pixel grid, very large square pixels, flat bold colors, no gradients, retro 8-bit style' },
  { prompt: 'pixel bead art, very coarse 8x8 pixel grid, large square pixels, flat colors, no gradients, retro 8-bit style' },
  { prompt: 'pixel bead art, coarse 10x10 pixel grid, large square pixels, flat bold colors, no gradients, retro 8-bit style' },
];

let smallMode = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function resizeAndBase64(img, maxSize = 1024) {
  // SVG 没有声明 width/height 时 naturalWidth 为 0，回退到 maxSize
  const srcW = img.naturalWidth  || maxSize;
  const srcH = img.naturalHeight || maxSize;
  const scale = Math.min(1, maxSize / Math.max(srcW, srcH));
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.92);
}

async function urlToBase64(url) {
  const resp = await fetch(url);
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── DOM refs ──────────────────────────────────────────────────────────────────
const dropzone      = document.getElementById('dropzone');
const dropzoneInner = document.getElementById('dropzone-inner');
const fileInput     = document.getElementById('file-input');
const previewImg    = document.getElementById('preview-img');
const generateBtn   = document.getElementById('generate-btn');
const btnText       = document.getElementById('btn-text');
const btnSpinner    = document.getElementById('btn-spinner');
const progressWrap  = document.getElementById('progress-wrap');
const progressFill  = document.getElementById('progress-fill');
const progressText  = document.getElementById('progress-text');
const resultsGrid   = document.getElementById('results-grid');
const statusBar     = document.getElementById('status-bar');
const geminiSection = document.getElementById('gemini-section');
const geminiStatus  = document.getElementById('gemini-status');
const pixelCanvas   = document.getElementById('pixel-canvas');
const pixelInfo     = document.getElementById('pixel-info');

// ── 3D param sliders (range ↔ number sync) ───────────────────────────────────
function syncMpRange(rangeId, valId) {
  const r = document.getElementById(rangeId);
  const v = document.getElementById(valId);
  if (!r || !v) return;
  r.addEventListener('input',  () => { v.value = r.value; });
  v.addEventListener('change', () => {
    r.value = Math.min(+r.max, Math.max(+r.min, +v.value));
    v.value = r.value;
  });
}
syncMpRange('mp-height-r', 'mp-height-v');
syncMpRange('mp-plugw-r',  'mp-plugw-v');
syncMpRange('mp-head-r',   'mp-head-v');
syncMpRange('mp-plugh-r',  'mp-plugh-v');
syncMpRange('mp-surf-r',   'mp-surf-v');

function getModelParams() {
  const BASE_H = 37.625;
  const targetH         = parseFloat(document.getElementById('mp-height-v')?.value ?? BASE_H);
  const plugWidth       = parseFloat(document.getElementById('mp-plugw-v')?.value  ?? 4.263);
  const headScale       = parseFloat(document.getElementById('mp-head-v')?.value   ?? 1);
  const plugHeight      = parseFloat(document.getElementById('mp-plugh-v')?.value  ?? 6.1);
  const surfaceThickness = parseFloat(document.getElementById('mp-surf-v')?.value  ?? 0.8);
  return { zScale: targetH / BASE_H, plugWidth, headScale, plugHeight, surfaceThickness };
}

// ── 3D section refs ───────────────────────────────────────────────────────────
const model3dSection      = document.getElementById('model3d-section');
const model3dStatus       = document.getElementById('model3d-status');
const model3dInfo         = document.getElementById('model3d-info');
const model3dProgressWrap = document.getElementById('model3d-progress');
const model3dProgressFill = document.getElementById('model3d-progress-fill');
const model3dProgressText = document.getElementById('model3d-progress-text');
const viewerCanvas        = document.getElementById('viewer-canvas');
const model3dActions      = document.getElementById('model3d-actions');
const exportMergedBtn     = document.getElementById('export-merged-btn');
const exportPartsBtn      = document.getElementById('export-parts-btn');
const export3mfBtn        = document.getElementById('export-3mf-btn');

let sourceImage  = null;
let cachedPieces = null; // last generated pieces

// ── 小鼻嘎模式 ────────────────────────────────────────────────────────────────
const smallModeBtn = document.getElementById('small-mode-btn');
smallModeBtn.addEventListener('click', () => {
  smallMode = !smallMode;
  smallModeBtn.classList.toggle('active', smallMode);
  smallModeBtn.textContent = smallMode ? '🐣 小鼻嘎模式 ON' : '🐣 小鼻嘎模式';
});

// ── Upload / Drag-drop ────────────────────────────────────────────────────────
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); });

function loadFile(file) {
  if (!file.type.match(/image\/(jpeg|png|svg\+xml)/)) {
    showStatus('仅支持 JPG、PNG 或 SVG 格式', 'error');
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    sourceImage = img;
    previewImg.src = url;
    previewImg.classList.remove('hidden');
    dropzoneInner.classList.add('hidden');
    generateBtn.disabled = false;
    hideStatus();
    resultsGrid.classList.add('hidden');
    resultsGrid.innerHTML = '';
    geminiSection.classList.add('hidden');
  };
  img.src = url;
}

// ── Generate ──────────────────────────────────────────────────────────────────
generateBtn.addEventListener('click', async () => {
  if (!sourceImage) return;
  setGenerating(true);
  resultsGrid.classList.add('hidden');
  resultsGrid.innerHTML = '';
  geminiSection.classList.add('hidden');
  showProgress(0, '准备图片…');

  try {
    const base64 = resizeAndBase64(sourceImage, 1024);
    showProgress(10, '并行提交 4 个任务到 Meshy AI…');

    const activeVariants = smallMode ? SMALL_VARIANTS : VARIANTS;
    const taskIds = await Promise.all(
      activeVariants.map(v => createMeshyTask(base64, v.prompt))
    );
    showProgress(20, '等待 4 个任务完成…');

    const imageUrls = await pollAllTasks(taskIds);

    resultsGrid.innerHTML = '';
    for (let i = 0; i < activeVariants.length; i++) {
      resultsGrid.appendChild(buildCard(i + 1, imageUrls[i]));
    }
    resultsGrid.classList.remove('hidden');

    hideProgress();
    showStatus('完成！点击任意图片下方的「Gemini 分析」按钮', 'info');
  } catch (err) {
    console.error('[pixel-bead] error:', err);
    hideProgress();
    showStatus(err.message || '发生错误，请重试', 'error');
  } finally {
    setGenerating(false);
  }
});

// ── Meshy API ─────────────────────────────────────────────────────────────────

async function createMeshyTask(base64DataUri, prompt) {
  const res = await fetch(`${MESHY_BASE}/openapi/v1/image-to-image`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MESHY_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ai_model: 'nano-banana-pro',
      prompt,
      reference_image_urls: [base64DataUri],
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Meshy 错误 ${res.status}：${body.message || JSON.stringify(body)}`);
  }

  const data = await res.json();
  if (!data.result) throw new Error(`未收到任务 ID：${JSON.stringify(data)}`);
  return data.result;
}

async function pollAllTasks(taskIds) {
  const MAX_MS     = 5 * 60 * 1000;
  const INTERVAL   = 3000;
  const start      = Date.now();
  const done       = new Array(taskIds.length).fill(null);
  const progresses = new Array(taskIds.length).fill(0);

  while (Date.now() - start < MAX_MS) {
    await sleep(INTERVAL);

    await Promise.all(taskIds.map(async (id, i) => {
      if (done[i]) return;
      const res = await fetch(`${MESHY_BASE}/openapi/v1/image-to-image/${id}`, {
        headers: { 'Authorization': `Bearer ${MESHY_KEY}` },
      });
      if (!res.ok) throw new Error(`查询失败：${res.status}`);
      const data = await res.json();

      progresses[i] = data.progress ?? 0;

      if (data.status === 'SUCCEEDED') {
        const url = data.image_urls?.[0];
        if (!url) throw new Error('未获取到结果图片');
        done[i] = url;
      } else if (data.status === 'FAILED')   { throw new Error(`任务 ${i + 1} 失败`); }
      else if (data.status === 'CANCELED') { throw new Error(`任务 ${i + 1} 已取消`); }
    }));

    const avg      = progresses.reduce((s, p) => s + p, 0) / progresses.length;
    const finished = done.filter(Boolean).length;
    showProgress(
      20 + Math.round(avg * 0.75),
      `AI 处理中… ${finished}/${taskIds.length} 完成（平均 ${Math.round(avg)}%）`
    );

    if (done.every(Boolean)) return done;
  }

  throw new Error('处理超时，请重试');
}

// ── Result card ───────────────────────────────────────────────────────────────

function buildCard(index, imageUrl) {
  const proxyUrl = imageUrl.replace('https://assets.meshy.ai', '/meshy-asset');

  const card = document.createElement('div');
  card.className = 'result-card';

  const label = document.createElement('div');
  label.className = 'result-label';
  label.textContent = index;

  const img = document.createElement('img');
  img.src = proxyUrl;
  img.alt = `结果 ${index}`;
  img.className = 'result-img';

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const dlBtn = document.createElement('button');
  dlBtn.className = 'btn-download';
  dlBtn.textContent = '⬇ 下载';
  dlBtn.addEventListener('click', async () => {
    const resp = await fetch(proxyUrl);
    const blob = await resp.blob();
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `pixel-bead-${index}.png`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // Grid size selector
  const gridSelect = document.createElement('select');
  gridSelect.className = 'grid-select';
  [8, 12, 16, 20, 24, 32].forEach(n => {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = `${n}×${n}`;
    if (n === 16) opt.selected = true;
    gridSelect.appendChild(opt);
  });

  const analyzeBtn = document.createElement('button');
  analyzeBtn.className = 'btn-gemini';
  analyzeBtn.textContent = '像素分析';
  analyzeBtn.addEventListener('click', () => {
    analyzeDirectly(proxyUrl, parseInt(gridSelect.value));
  });

  actions.appendChild(dlBtn);
  actions.appendChild(gridSelect);
  actions.appendChild(analyzeBtn);

  card.appendChild(label);
  card.appendChild(img);
  card.appendChild(actions);
  return card;
}

// ── Direct canvas-based pixel analysis (no Gemini) ────────────────────────────

function analyzeDirectly(proxyUrl, gridSize) {
  geminiSection.classList.remove('hidden');
  geminiSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  pixelCanvas.classList.add('hidden');
  pixelInfo.textContent = '';
  setGeminiStatus('分析中…');

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const pixelData = sampleImage(img, gridSize);
      if (pixelData.pixels.length === 0) throw new Error('未检测到前景像素，尝试换一个格子数');
      renderPixelCanvas(pixelData);
      setGeminiStatus('');
    } catch (e) {
      setGeminiStatus(`分析失败：${e.message}`, true);
    }
  };
  img.onerror = () => setGeminiStatus('图片加载失败', true);
  img.src = proxyUrl;
}

// Sample image at gridSize×gridSize, return pixelData with background removed
function sampleImage(img, gridSize) {
  const canvas = document.createElement('canvas');
  canvas.width  = gridSize;
  canvas.height = gridSize;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, gridSize, gridSize);
  const { data } = ctx.getImageData(0, 0, gridSize, gridSize);

  const getPixel = (x, y) => {
    const i = (y * gridSize + x) * 4;
    return { r: data[i], g: data[i+1], b: data[i+2], a: data[i+3] };
  };

  const colorDist = (a, b) =>
    Math.sqrt((a.r-b.r)**2 + (a.g-b.g)**2 + (a.b-b.b)**2);

  const toHex = ({ r, g, b }) =>
    '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();

  // Detect background: flood-fill from all 4 corners using corner color
  const corners = [
    getPixel(0, 0), getPixel(gridSize-1, 0),
    getPixel(0, gridSize-1), getPixel(gridSize-1, gridSize-1),
  ];
  // Pick the most opaque corner as background reference
  const bgRef = corners.reduce((a, b) => b.a > a.a ? b : a);
  const BG_THRESH = 40; // color distance threshold

  // Flood-fill to mark background pixels
  const isBg = new Uint8Array(gridSize * gridSize);
  const queue = [];
  const enqueue = (x, y) => {
    const idx = y * gridSize + x;
    if (x < 0 || x >= gridSize || y < 0 || y >= gridSize) return;
    if (isBg[idx]) return;
    const px = getPixel(x, y);
    if (px.a < 30 || colorDist(px, bgRef) < BG_THRESH) {
      isBg[idx] = 1;
      queue.push(x, y);
    }
  };
  // Seed from all border pixels
  for (let x = 0; x < gridSize; x++) { enqueue(x, 0); enqueue(x, gridSize-1); }
  for (let y = 0; y < gridSize; y++) { enqueue(0, y); enqueue(gridSize-1, y); }
  while (queue.length) {
    const y = queue.pop(), x = queue.pop();
    enqueue(x+1, y); enqueue(x-1, y); enqueue(x, y+1); enqueue(x, y-1);
  }

  const pixels = [];
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      if (isBg[row * gridSize + col]) continue;
      const px = getPixel(col, row);
      if (px.a < 30) continue;
      pixels.push({ row, col, color: toHex(px) });
    }
  }

  // 小鼻嘎模式限制
  const limited = smallMode ? pixels.slice(0, 100) : pixels;
  return { cols: gridSize, rows: gridSize, pixels: limited };
}

// ── Canvas renderer ───────────────────────────────────────────────────────────

// Physical box size from 初始长方体.stl (mm)
const BOX_W = 8.063;
const BOX_D = 8.062;

function renderPixelCanvas(pixelData) {
  const { cols, rows, pixels } = pixelData;
  const MAX_DIM   = 560;
  const blockSize = Math.max(1, Math.floor(MAX_DIM / Math.max(cols, rows)));

  pixelCanvas.width  = cols * blockSize;
  pixelCanvas.height = rows * blockSize;

  const ctx = pixelCanvas.getContext('2d');
  ctx.clearRect(0, 0, pixelCanvas.width, pixelCanvas.height);

  for (const { row, col, color } of pixels) {
    ctx.fillStyle = color;
    ctx.fillRect(col * blockSize, row * blockSize, blockSize, blockSize);
  }

  // ── Build enriched data for 3D algorithm ─────────────────────────────────
  // Index pixel set for O(1) neighbor lookup
  const occupied = new Set(pixels.map(p => `${p.row},${p.col}`));

  const enriched = pixels.map(p => {
    const { row, col, color } = p;
    return {
      row,
      col,
      color: color.toUpperCase(),          // normalise hex
      x: col * BOX_W,                      // mm, left edge
      y: row * BOX_D,                      // mm, top edge
      neighbors: {
        right:  occupied.has(`${row},${col + 1}`),
        left:   occupied.has(`${row},${col - 1}`),
        bottom: occupied.has(`${row + 1},${col}`),
        top:    occupied.has(`${row - 1},${col}`),
      },
    };
  });

  window.pixelData = {
    cols,
    rows,
    boxW: BOX_W,
    boxD: BOX_D,
    pixels: enriched,
  };

  const uniqueColors = new Set(enriched.map(p => p.color)).size;
  pixelInfo.textContent =
    `${cols} × ${rows} 格（共 ${enriched.length} 个像素，${uniqueColors} 种颜色）`;
  pixelCanvas.classList.remove('hidden');

  // ── Show 3D generate button ───────────────────────────────────────────────
  model3dSection.classList.remove('hidden');
  model3dStatus.textContent = '像素数据已就绪，点击下方按钮生成 3D 模型';
  viewerCanvas.classList.add('hidden');
  model3dActions.classList.add('hidden');
  cachedPieces = null;

  // Show generate button (injected once)
  let gen3dBtn = document.getElementById('gen3d-btn');
  if (!gen3dBtn) {
    gen3dBtn = document.createElement('button');
    gen3dBtn.id        = 'gen3d-btn';
    gen3dBtn.className = 'btn-gen3d';
    gen3dBtn.textContent = '🧱 生成 3D 模型';
    model3dSection.insertBefore(gen3dBtn, model3dProgressWrap);
    gen3dBtn.addEventListener('click', handleGenerate3D);
  }
  gen3dBtn.disabled = false;

  // Preload models in background
  loadModels().catch(() => {});
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setGenerating(on) {
  generateBtn.disabled = on;
  btnText.textContent  = on ? '处理中…' : '生成拼豆图';
  btnSpinner.classList.toggle('hidden', !on);
}

function setGeminiStatus(msg, isError = false) {
  geminiStatus.textContent = msg;
  geminiStatus.className   = 'gemini-status' + (isError ? ' error' : '');
}

function showProgress(pct, label) {
  progressWrap.classList.remove('hidden');
  progressFill.style.width = `${pct}%`;
  progressText.textContent = label;
}

function hideProgress() {
  progressWrap.classList.add('hidden');
}

function showStatus(msg, type = 'info') {
  statusBar.textContent = msg;
  statusBar.className   = `status-bar ${type}`;
  statusBar.classList.remove('hidden');
}

function hideStatus() {
  statusBar.classList.add('hidden');
}

// ── 3D generation ─────────────────────────────────────────────────────────────

async function handleGenerate3D() {
  const data = window.pixelData;
  if (!data) return;

  const gen3dBtn = document.getElementById('gen3d-btn');
  gen3dBtn.disabled = true;
  model3dActions.classList.add('hidden');
  viewerCanvas.classList.add('hidden');

  // Show progress
  model3dProgressWrap.classList.remove('hidden');
  model3dProgressFill.style.width = '0%';
  model3dProgressText.textContent  = '加载模型文件…';
  model3dStatus.textContent = '';

  let pieces;
  try {
    let step = 0;
    const total = data.pixels.length;

    pieces = await generatePieces(data, (msg) => {
      // Parse progress from message like "正在生成零件 N / M…"
      const m = msg.match(/(\d+)\s*\/\s*(\d+)/);
      if (m) {
        const pct = Math.round((parseInt(m[1]) / parseInt(m[2])) * 100);
        model3dProgressFill.style.width = `${pct}%`;
      }
      model3dProgressText.textContent = msg;
    }, getModelParams());

    cachedPieces = pieces;
    model3dInfo.textContent = `${pieces.length} 个零件`;

    // Make canvas visible first so clientWidth/clientHeight are valid
    viewerCanvas.classList.remove('hidden');
    viewerCanvas.style.width  = '100%';
    viewerCanvas.style.height = '480px';
    await new Promise(r => setTimeout(r, 50)); // let browser lay out canvas
    initViewer(viewerCanvas);
    showPieces(pieces);

    model3dProgressWrap.classList.add('hidden');
    model3dActions.classList.remove('hidden');
    model3dStatus.textContent = '✅ 生成完成，可旋转查看';
    gen3dBtn.disabled = false;
  } catch (err) {
    console.error('[3D]', err);
    model3dProgressWrap.classList.add('hidden');
    model3dStatus.textContent = `❌ 生成失败：${err.message}`;
    gen3dBtn.disabled = false;
  }
}

exportMergedBtn.addEventListener('click', () => {
  if (cachedPieces) exportMergedSTL(cachedPieces);
});

exportPartsBtn.addEventListener('click', () => {
  if (cachedPieces) exportAllSTL(cachedPieces);
});

export3mfBtn.addEventListener('click', () => {
  if (cachedPieces) export3MFColored(cachedPieces);
});
