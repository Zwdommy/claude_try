import { generatePieces, initViewer, showPieces, exportAllSTL, exportMergedSTL, loadModels } from '/model3d.js';

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

  const geminiBtn = document.createElement('button');
  geminiBtn.className = 'btn-gemini';
  geminiBtn.textContent = 'Gemini 分析';
  // Pass original CDN URL to Gemini (server-to-server fetch, no CORS issue)
  geminiBtn.addEventListener('click', () => analyzeWithGemini(imageUrl, index));

  actions.appendChild(dlBtn);
  actions.appendChild(geminiBtn);

  card.appendChild(label);
  card.appendChild(img);
  card.appendChild(actions);
  return card;
}

// ── Gemini ────────────────────────────────────────────────────────────────────

async function analyzeWithGemini(imageUrl, cardIndex) {
  geminiSection.classList.remove('hidden');
  geminiSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  pixelCanvas.classList.add('hidden');
  pixelInfo.textContent   = '';
  setGeminiStatus('发送给 Gemini，请稍候…');

  try {
    // Send the CDN URL directly — Gemini fetches it server-side, no CORS/base64 needed
    const res = await fetch(`${GEMINI_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GEMINI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: imageUrl },
            },
            {
              type: 'text',
              text:
                'This is pixel art made of solid-colored square blocks arranged in a grid.\n' +
                'Carefully identify every pixel block and its exact dominant color.\n' +
                'Return ONLY a valid JSON object, no markdown, no explanation:\n' +
                '{"cols":<int>,"rows":<int>,"pixels":[{"row":0,"col":0,"color":"#RRGGBB"},...]}' +
                '\nRules:\n' +
                '- color must be the most representative hex color of that block (e.g. "#FF3300"), never approximate to white/black unless the block truly is\n' +
                '- EXCLUDE background pixels: do NOT include pixels that belong to the background, empty space, or plain backdrop surrounding the main subject\n' +
                '- only include pixels that are part of the actual foreground subject\n' +
                '- list included pixels row by row (top to bottom), left to right' +
                (smallMode
                  ? '\n- IMPORTANT: use a coarse grid of at most 10 columns and 10 rows; the total number of foreground pixels must not exceed 100'
                  : ''),
            },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Gemini 错误 ${res.status}：${body.error?.message || JSON.stringify(body)}`);
    }

    const data    = await res.json();
    const rawText = data.choices?.[0]?.message?.content ?? '';

    // Extract JSON (may be wrapped in ```json ... ```)
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Gemini 未返回有效 JSON');

    const pixelData = JSON.parse(jsonMatch[0]);
    if (!pixelData.cols || !pixelData.rows || !Array.isArray(pixelData.pixels)) {
      throw new Error('JSON 格式不正确');
    }

    // 小鼻嘎模式：强制限制在 100 个像素以内
    if (smallMode && pixelData.pixels.length > 100) {
      pixelData.pixels = pixelData.pixels.slice(0, 100);
      setGeminiStatus(`⚠️ 小鼻嘎模式：已裁剪至 100 个像素`, false);
    }

    renderPixelCanvas(pixelData);
    if (!smallMode || pixelData.pixels.length <= 100) setGeminiStatus('');
  } catch (err) {
    console.error('[gemini]', err);
    setGeminiStatus(`Gemini 出错：${err.message}`, true);
  }
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
    });

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
