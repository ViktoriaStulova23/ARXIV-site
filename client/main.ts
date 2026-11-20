import './styles.css';
import { parseResultMetadata, type Operation } from './result.js';
import { MAX_ARCHIVE_SIZE, MAX_ORIGINAL_SIZE, type Method } from '../core/types.js';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}
const form = element<HTMLFormElement>('archive-form');
const controls = element<HTMLFieldSetElement>('controls');
const input = element<HTMLInputElement>('file-input');
const choose = element<HTMLButtonElement>('choose-file');
const remove = element<HTMLButtonElement>('remove-file');
const submit = element<HTMLButtonElement>('submit');
const dropzone = element('dropzone');
const status = element('request-status');
const error = element('error');
const result = element('result');
const download = element<HTMLAnchorElement>('download');
const tabs = [element<HTMLButtonElement>('compress-tab'), element<HTMLButtonElement>('decompress-tab')];
const methodInput = element<HTMLSelectElement>('method-input');
let operation: Operation = 'compress';
let file: File | null = null;
let busy = false;
let objectUrl: string | null = null;
let xhr: XMLHttpRequest | null = null;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString('ru-RU')} Б`;
  const power = bytes < 1024 * 1024 ? 1 : 2;
  return `${(bytes / 1024 ** power).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${power === 1 ? 'KiB' : 'MiB'}`;
}
function clearResult() {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  download.removeAttribute('href');
  result.hidden = true;
}
function showError(message: string) {
  error.textContent = message;
  error.hidden = false;
}
function refreshFile() {
  element('drop-title').textContent = file?.name ?? (operation === 'compress' ? 'Перетащите файл сюда' : 'Перетащите архив сюда');
  element('drop-description').textContent = file ? formatSize(file.size) :
    operation === 'compress' ? 'или выберите его на устройстве' : 'Файл в формате .sarc';
  choose.textContent = file ? 'Заменить файл' : 'Выбрать файл';
  remove.hidden = !file;
  submit.disabled = !file || busy;
  status.classList.remove('processing');
  status.textContent = '';
}
function selectFiles(files: FileList | File[]) {
  if (busy) return;
  clearResult();
  error.hidden = true;
  file = null;
  if (files.length !== 1) {
    showError('Выберите ровно один файл. Папки и несколько файлов не поддерживаются.');
  } else {
    const candidate = files[0]!;
    const limit = operation === 'compress' ? MAX_ORIGINAL_SIZE : MAX_ARCHIVE_SIZE;
    if (candidate.size > limit) showError(`Файл превышает лимит ${operation === 'compress' ? 100 : 102} MiB.`);
    else file = candidate;
  }
  input.value = '';
  refreshFile();
}
function setOperation(next: Operation) {
  if (busy || next === operation) return;
  operation = next;
  file = null;
  input.value = '';
  input.accept = next === 'decompress' ? '.sarc' : '';
  clearResult();
  error.hidden = true;
  tabs.forEach((tab, index) => {
    const active = (index === 0 ? 'compress' : 'decompress') === next;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  element('operation-panel').setAttribute('aria-labelledby', `${next}-tab`);
  element('method-section').hidden = next === 'decompress';
  element('decompress-note').hidden = next === 'compress';
  element('drop-limit').textContent = next === 'compress' ? 'До 100 MiB · обработка на локальном сервере' : 'До 102 MiB · обработка на локальном сервере';
  submit.innerHTML = `${next === 'compress' ? 'Сжать файл' : 'Распаковать файл'} <span aria-hidden="true">→</span>`;
  refreshFile();
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => setOperation(index === 0 ? 'compress' : 'decompress'));
  tab.addEventListener('keydown', event => {
    if (busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
    setOperation(next === 0 ? 'compress' : 'decompress');
    tabs[next]!.focus();
  });
});
choose.addEventListener('click', () => input.click());
input.addEventListener('change', () => { if (input.files?.length) selectFiles(input.files); });
remove.addEventListener('click', () => { file = null; input.value = ''; clearResult(); error.hidden = true; refreshFile(); choose.focus(); });
let dragDepth = 0;
dropzone.addEventListener('dragenter', event => { event.preventDefault(); if (!busy) { dragDepth++; dropzone.classList.add('dragging'); } });
dropzone.addEventListener('dragover', event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; });
dropzone.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropzone.classList.remove('dragging'); });
dropzone.addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0; dropzone.classList.remove('dragging');
  if (!event.dataTransfer) return;
  const hasDirectory = Array.from(event.dataTransfer.items).some(item => item.webkitGetAsEntry?.()?.isDirectory);
  selectFiles(hasDirectory ? [] : event.dataTransfer.files);
});
// Prevent the browser navigating away when a file misses the drop target.
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
methodInput.addEventListener('change', () => {
  const method = methodInput.value as Method;
  clearResult();
  refreshFile();
  element('method-note').textContent = method === 'auto' ?
    'Наименьший вариант из доступных методов. Размер может увеличиться из-за заголовка.' :
    method === 'lz' ? 'Собственный LZ77 с кодированием Хаффмана. При ручном выборе размер может увеличиться.' :
    'Стандартный DEFLATE. При ручном выборе размер может увеличиться.';
});

function stat(label: string, value: string, increase = false) {
  const group = document.createElement('div');
  const dt = document.createElement('dt'); dt.textContent = label;
  const dd = document.createElement('dd'); dd.textContent = value;
  if (increase) dd.classList.add('increase');
  group.append(dt, dd);
  return group;
}
function showResult(response: XMLHttpRequest, original: File, elapsed: number) {
  const body = response.response as Blob;
  const { originalSize, archiveSize, codec } = parseResultMetadata(
    name => response.getResponseHeader(name), operation, original.size, body.size,
  );
  let filename = operation === 'compress' ? `${original.name}.sarc` : 'file.bin';
  const encodedName = response.getResponseHeader('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encodedName) {
    try { filename = decodeURIComponent(encodedName); }
    catch { throw new Error('Сервер вернул некорректное имя файла.'); }
  }
  objectUrl = URL.createObjectURL(body);
  download.href = objectUrl;
  download.download = filename;
  download.innerHTML = `${operation === 'compress' ? 'Скачать архив' : 'Скачать исходный файл'} <span aria-hidden="true">↓</span>`;
  element('result-title').textContent = operation === 'compress' ? 'Архив готов' : 'Оригинал восстановлен';
  element('result-name').textContent = filename;
  const stats = element('result-stats');
  if (operation === 'compress') {
    const increase = archiveSize > originalSize;
    const percent = originalSize === 0 ? `+${archiveSize} Б` : `${(Math.abs(1 - archiveSize / originalSize) * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %`;
    stats.replaceChildren(stat('Было', formatSize(originalSize)), stat('Стало', formatSize(archiveSize)),
      stat(increase ? 'Увеличение' : 'Экономия', percent, increase), stat('Алгоритм', codec));
    element('result-detail').textContent = `Время запроса: ${(elapsed / 1000).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} с`;
  } else {
    stats.replaceChildren(stat('Архив', formatSize(archiveSize)), stat('Восстановлено', formatSize(originalSize)),
      stat('Алгоритм', codec), stat('Время запроса', `${(elapsed / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} с`));
    element('result-detail').textContent = 'Проверка SHA-256: пройдена';
  }
  result.hidden = false;
  element('result-title').focus({ preventScroll: true });
  result.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' });
}
function send(data: FormData): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    xhr = request;
    request.open('POST', `/api/${operation}`);
    request.responseType = 'blob';
    request.timeout = 180_000;
    request.upload.onload = () => { status.textContent = 'Обработка…'; };
    request.onload = () => resolve(request);
    request.onerror = () => reject(new Error('Нет связи с сервером. Проверьте, что приложение запущено, и повторите запрос.'));
    request.ontimeout = () => reject(new Error('Время ожидания истекло. Повторите запрос.'));
    request.onabort = () => reject(new Error('Запрос прерван.'));
    request.send(data);
  });
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!file || busy) return;
  const original = file;
  clearResult(); error.hidden = true;
  busy = true; controls.disabled = true; submit.disabled = true;
  tabs.forEach(tab => { tab.disabled = true; });
  form.setAttribute('aria-busy', 'true');
  status.classList.add('processing'); status.textContent = 'Загрузка…';
  const started = performance.now();
  try {
    const data = new FormData();
    data.append('file', original);
    if (operation === 'compress') data.append('method', methodInput.value);
    const response = await send(data);
    if (response.status < 200 || response.status >= 300) {
      let message = `Ошибка сервера (${response.status}). Повторите операцию.`;
      try {
        const body: unknown = JSON.parse(await (response.response as Blob).text());
        if (body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' &&
          'message' in body.error && typeof body.error.message === 'string') message = body.error.message;
      } catch { /* A non-JSON proxy error still has a useful HTTP status. */ }
      throw new Error(message);
    }
    showResult(response, original, performance.now() - started);
  } catch (cause) {
    clearResult();
    showError(cause instanceof Error ? cause.message : 'Не удалось обработать файл. Повторите операцию.');
  } finally {
    xhr = null; busy = false; controls.disabled = false;
    tabs.forEach(tab => { tab.disabled = false; });
    form.setAttribute('aria-busy', 'false');
    refreshFile();
    if (!result.hidden) status.textContent = 'Готово. Результат можно скачать';
    else if (!error.hidden) status.textContent = 'Операция не завершена';
  }
});
element('close-result').addEventListener('click', () => { clearResult(); refreshFile(); submit.focus(); });
window.addEventListener('pagehide', () => { xhr?.abort(); clearResult(); });
