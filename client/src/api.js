const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 30_000;

let unauthorizedHandler = () => {};
export const setUnauthorizedHandler = (handler) => {
  unauthorizedHandler = handler;
};

const makeError = async (response) => {
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  const error = new Error(payload.error || `Request failed (${response.status}).`);
  error.status = response.status;
  error.code = payload.code;
  error.details = payload.details || [];
  if (error.details.length > 0) {
    error.message = `${error.message} ${error.details.map(({ field, message }) => `${field}: ${message}`).join('; ')}`;
  }
  return error;
};

export const apiRequest = async (path, {
  token,
  method = 'GET',
  body,
  headers = {},
  timeout = REQUEST_TIMEOUT_MS,
  responseType = 'json',
} = {}) => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  const requestHeaders = new Headers(headers);
  if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
  if (body && !(body instanceof FormData)) requestHeaders.set('Content-Type', 'application/json');

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: requestHeaders,
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      credentials: 'omit',
    });
    if (response.status === 401) unauthorizedHandler();
    if (!response.ok) throw await makeError(response);
    if (responseType === 'blob') return response.blob();
    if (response.status === 204) return null;
    return response.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('The request timed out. Check your connection and try again.');
    }
    if (error instanceof TypeError) {
      throw new Error('Cannot reach the backend. Confirm it is running and the API URL is correct.');
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
};

export const saveAuthenticatedDownload = async ({ path, token, filename }) => {
  const blob = await apiRequest(path, { token, responseType: 'blob' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename || 'fdr-document';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
};
