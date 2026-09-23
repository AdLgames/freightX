// Harbour — document upload (M5, brief §7.4). Progressive enhancement for /app/documents/new.
//
// Served from the app's own origin (CSP `script-src 'self'`, so no nonce or inline handler is
// needed) and loaded as a module. Without it the form still works: the browser posts the file to
// the app, which streams it to storage server-side.
//
// With it: (1) POST the metadata to /app/documents/presign → a Document row and a presigned PUT;
// (2) PUT the bytes straight to storage; (3) POST /app/documents/:id/complete so the server can
// verify the object and queue the scan. The CSRF token comes from the form's hidden `_csrf` field.

const form = document.querySelector('form[data-upload-form]');
if (form) {
  const status = form.querySelector('[data-upload-status]');
  const quoteField = form.querySelector('[data-quote-field]');
  const typeSelect = form.querySelector('select[name="type"]');
  const fileInput = form.querySelector('input[name="file"]');
  const presignUrl = form.getAttribute('data-presign-url') || '/app/documents/presign';
  const maxBytes = Number(form.getAttribute('data-max-bytes') || '0') || 25 * 1024 * 1024;

  const say = (text, isError) => {
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('field-error', Boolean(isError));
  };

  // Show only the document types that belong to the chosen scope, and hide the quote picker
  // for organisation documents.
  const syncScope = () => {
    const scope = (form.querySelector('input[name="scope"]:checked') || {}).value || 'ORGANISATION';
    if (quoteField) quoteField.hidden = scope !== 'QUOTE';
    if (typeSelect) {
      for (const group of typeSelect.querySelectorAll('optgroup')) {
        const match = group.getAttribute('data-scope') === scope;
        group.hidden = !match;
        for (const option of group.options) option.disabled = !match;
      }
      const selected = typeSelect.selectedOptions[0];
      if (selected && selected.disabled) typeSelect.value = '';
    }
  };
  for (const radio of form.querySelectorAll('input[name="scope"]')) {
    radio.addEventListener('change', syncScope);
  }
  syncScope();

  const csrf = () => {
    const field = form.querySelector('input[name="_csrf"]');
    return field ? field.value : '';
  };

  const postForm = async (url, fields) => {
    const body = new URLSearchParams(fields);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
      credentials: 'same-origin',
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { res, json };
  };

  form.addEventListener('submit', async (event) => {
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) return; // let the browser validate
    event.preventDefault();
    const file = fileInput.files[0];
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      if (file.size > maxBytes) {
        say('The file is larger than 25 MB.', true);
        return;
      }
      say('Preparing upload…');
      const scope = (form.querySelector('input[name="scope"]:checked') || {}).value || '';
      const quoteId = (form.querySelector('select[name="quoteId"]') || {}).value || '';
      const type = typeSelect ? typeSelect.value : '';
      const presign = await postForm(presignUrl, {
        _csrf: csrf(),
        type,
        scope,
        quoteId,
        filename: file.name,
        mimeType: file.type || '',
        sizeBytes: String(file.size),
      });
      if (!presign.res.ok || !presign.json || !presign.json.upload) {
        const errors = (presign.json && presign.json.errors) || {};
        const first = Object.values(errors)[0];
        say(first || 'The upload could not be started. Reload and try again.', true);
        return;
      }
      say('Uploading…');
      const { upload, completeUrl } = presign.json;
      const put = await fetch(upload.url, {
        method: upload.method || 'PUT',
        headers: upload.headers || {},
        body: file,
        // Same-origin for the local backend; a cross-origin S3/R2 PUT sends no cookies anyway.
        credentials: 'omit',
        mode: 'cors',
      });
      if (!put.ok) {
        say('The storage service refused the upload (' + put.status + '). Try again.', true);
        return;
      }
      say('Checking upload…');
      const done = await postForm(completeUrl, { _csrf: csrf() });
      if (!done.res.ok || !done.json || !done.json.ok) {
        const message = done.json && done.json.message;
        say(message || 'The upload could not be completed.', true);
        return;
      }
      say('Done.');
      window.location.assign(done.json.next || '/app/documents?notice=uploaded');
    } catch {
      say('Something went wrong during the upload. Try again.', true);
    } finally {
      if (submit) submit.disabled = false;
    }
  });
}
