import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileTypeFromBuffer } from 'file-type';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultStorageRoot = path.resolve(__dirname, '../../private/uploads/fdr');
const defaultMaxUploadBytes = 10 * 1024 * 1024;
const allowedMimeTypes = new Map([
  ['application/pdf', { extension: 'pdf', extensions: ['pdf'] }],
  ['image/jpeg', { extension: 'jpg', extensions: ['jpg', 'jpeg'] }],
  ['image/png', { extension: 'png', extensions: ['png'] }],
]);
const storageKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pdf|jpg|png)$/i;

const invalidStorageKeyError = () =>
  Object.assign(new Error('Invalid document storage key.'), { code: 'INVALID_STORAGE_KEY' });

export const getStorageDirectory = () =>
  path.resolve(process.env.FDR_STORAGE_DIR || defaultStorageRoot);

export const getMaxUploadBytes = () => {
  const configured = process.env.FDR_MAX_UPLOAD_BYTES;
  if (configured === undefined || configured === '') {
    return defaultMaxUploadBytes;
  }

  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 100 * 1024 * 1024) {
    throw new Error('FDR_MAX_UPLOAD_BYTES must be an integer between 1 and 104857600.');
  }

  return value;
};

const getSafeStoragePath = (storageKey) => {
  if (typeof storageKey !== 'string' || !storageKeyPattern.test(storageKey)) {
    throw invalidStorageKeyError();
  }

  const root = getStorageDirectory();
  const filePath = path.resolve(root, storageKey);
  if (path.dirname(filePath) !== root) {
    throw invalidStorageKeyError();
  }

  return filePath;
};

const sanitizeFileName = (fileName) => {
  const base = path.basename(fileName || 'document');
  const safe = base.replace(/[<>:"/\\|?*]+/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return safe.slice(0, 180) || 'document';
};

export const deleteStoredDocument = async (storageKey) => {
  if (!storageKey) return;

  try {
    await fs.unlink(getSafeStoragePath(storageKey));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
};

export const validateUploadBuffer = async (file) => {
  const maxUploadBytes = getMaxUploadBytes();
  if (!file?.buffer?.length) {
    throw new Error('The uploaded document is empty.');
  }

  if (file.buffer.length > maxUploadBytes) {
    throw new Error(`Document exceeds the ${maxUploadBytes} byte size limit.`);
  }

  const detectedType = await fileTypeFromBuffer(file.buffer);
  const detectedFormat = detectedType && allowedMimeTypes.get(detectedType.mime);
  if (!detectedFormat) {
    throw new Error('Unsupported document type. Only PDF, JPEG, and PNG are allowed.');
  }

  if (file.mimetype !== detectedType.mime) {
    throw new Error('The file Content-Type does not match the detected document type.');
  }

  const extension = path.extname(sanitizeFileName(file.originalname || 'document')).toLowerCase().slice(1);
  if (extension && !detectedFormat.extensions.includes(extension)) {
    throw new Error('The file extension does not match the detected document type.');
  }

  return {
    mimeType: detectedType.mime,
    extension: detectedFormat.extension,
  };
};

export const storeUploadedDocument = async (file) => {
  const result = await validateUploadBuffer(file);
  const safeName = sanitizeFileName(file.originalname || 'document');
  const storageKey = `${crypto.randomUUID()}.${result.extension}`;
  const directoryPath = getStorageDirectory();

  await fs.mkdir(directoryPath, { recursive: true });

  const filePath = getSafeStoragePath(storageKey);
  try {
    await fs.writeFile(filePath, file.buffer, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    try {
      await deleteStoredDocument(storageKey);
    } catch (cleanupError) {
      console.error('Failed to clean up incomplete private FDR upload:', cleanupError.name || 'Error');
    }
    throw error;
  }

  return {
    storageKey,
    fileName: safeName,
    mimeType: result.mimeType,
    fileSize: file.buffer.length,
    checksum: crypto.createHash('sha256').update(file.buffer).digest('hex'),
    uploadedAt: new Date(),
  };
};

export const readDocumentStream = async (storageKey) => {
  if (!storageKey) {
    return null;
  }

  const filePath = getSafeStoragePath(storageKey);
  try {
    const stats = await fs.lstat(filePath);
    return stats.isFile() ? filePath : null;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

export const readStoredDocument = async (storageKey) => {
  const filePath = await readDocumentStream(storageKey);
  if (!filePath) {
    return null;
  }

  const document = await fs.readFile(filePath);
  if (document.length > getMaxUploadBytes()) {
    throw new Error('Stored document exceeds the configured size limit.');
  }

  return document;
};
