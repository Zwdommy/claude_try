const MESHY_BASE  = 'https://api.meshy.ai';
const MESHY_KEY   = 'msy_nuoda1IScPx06JIZHvNuhN38WDYPE7z4gTrC';

const GEMINI_BASE  = 'https://synai996.space';
const GEMINI_KEY   = 'sk-fZlBimZDWmOFqZcA1jZEJiEXP75T1Ae3E04CDLcYrn410aHO';
const GEMINI_MODEL = 'gemini-3.1-pro-high';

const VARIANTS = [
  { prompt: 'pixel bead art, extremely coarse 10x10 pixel grid, very large square pixels, flat bold colors, no gradients, retro 8-bit style' },
  { prompt: 'pixel bead art, coarse 14x14 pixel grid, large square pixels, flat colors, no gradients, retro 16-bit style' },
  { prompt: 'pixel bead art, medium 17x17 pixel grid, square pixels, flat colors, no gradients, retro pixel art style' },
  { prompt: 'pixel bead art, fine 20x20 pixel grid, small square pixels, flat colors, no gradients, detailed retro pixel art' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function resizeAndBase64(img, maxSize = 1024) {
  const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth  * scale);
  const h = Math.round(img.naturalHeight * scale);
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

let sourceImage = null;

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
  if (!file.type.match(/image\/(jpeg|png)/)) {
    showStatus('仅支持 JPG 或 PNG 格式', 'error');
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

    const taskIds = await Promise.all(
      VARIANTS.map(v => createMeshyTask(base64, v.prompt))
    );
    showProgress(20, '等待 4 个任务完成…');

    const imageUrls = await pollAllTasks(taskIds);

    resultsGrid.innerHTML = '';
    for (let i = 0; i < VARIANTS.length; i++) {
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
  geminiBtn.addEventListener('click', () => analyzeWithGemini(proxyUrl, index));

  actions.appendChild(dlBtn);
  actions.appendChild(geminiBtn);

  card.appendChild(label);
  card.appendChild(img);
  card.appendChild(actions);
  return card;
}

// ── Gemini ────────────────────────────────────────────────────────────────────

async function analyzeWithGemini(proxyUrl, cardIndex) {
  geminiSection.classList.remove('hidden');
  geminiSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  pixelCanvas.classList.add('hidden');
  pixelInfo.textContent   = '';
  setGeminiStatus(`正在加载图片 ${cardIndex}…`);

  try {
    const base64DataUri = await urlToBase64(proxyUrl);

    setGeminiStatus('发送给 Gemini，请稍候…');

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
              image_url: { url: base64DataUri },
            },
            {
              type: 'text',
              text:
                'This is pixel art. Identify the pixel grid — each "pixel" is a solid-colored square block.\n' +
                'Return ONLY a valid JSON object, no markdown, no explanation:\n' +
                '{"cols":<int>,"rows":<int>,"pixels":[{"row":0,"col":0,"color":"#RRGGBB"},...]}' +
                '\nList every single pixel, row by row, left to right.',
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

    renderPixelCanvas(pixelData);
    setGeminiStatus('');
  } catch (err) {
    console.error('[gemini]', err);
    setGeminiStatus(`Gemini 出错：${err.message}`, true);
  }
}

// ── Canvas renderer ───────────────────────────────────────────────────────────

function renderPixelCanvas(pixelData) {
  const { cols, rows, pixels } = pixelData;
  const MAX_DIM  = 560;
  const blockSize = Math.max(1, Math.floor(MAX_DIM / Math.max(cols, rows)));

  pixelCanvas.width  = cols * blockSize;
  pixelCanvas.height = rows * blockSize;

  const ctx = pixelCanvas.getContext('2d');
  ctx.clearRect(0, 0, pixelCanvas.width, pixelCanvas.height);

  for (const { row, col, color } of pixels) {
    ctx.fillStyle = color;
    ctx.fillRect(col * blockSize, row * blockSize, blockSize, blockSize);
  }

  // Record for future 3D use
  window.pixelData = pixelData;

  const uniqueColors = new Set(pixels.map(p => p.color.toUpperCase())).size;
  pixelInfo.textContent = `${cols} × ${rows} 格（共 ${pixels.length} 个像素，${uniqueColors} 种颜色）`;
  pixelCanvas.classList.remove('hidden');
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
