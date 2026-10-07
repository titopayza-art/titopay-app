document.addEventListener('DOMContentLoaded', function() {
  initializeLeaseForm();
  initializeSignaturePad();
});

function initializeLeaseForm() {
  const leaseForm = document.querySelector('form[data-lease]');
  if (!leaseForm) return;

  leaseForm.addEventListener('submit', handleLeaseSubmit);

  const agreeCheckbox = document.querySelector('input[name="agree_terms"]');
  const submitButton = leaseForm.querySelector('button[type="submit"]');

  if (agreeCheckbox && submitButton) {
    agreeCheckbox.addEventListener('change', () => {
      submitButton.disabled = !agreeCheckbox.checked;
    });
  }
}

function initializeSignaturePad() {
  const canvas = document.getElementById('signature-pad');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  let isDrawing = false;
  let lastX = 0;
  let lastY = 0;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  canvas.width = canvas.offsetWidth * dpr;
  canvas.height = canvas.offsetHeight * dpr;
  ctx.scale(dpr, dpr);

  canvas.addEventListener('mousedown', (e) => startDrawing(e, canvas, ctx));
  canvas.addEventListener('mousemove', (e) => draw(e, canvas, ctx));
  canvas.addEventListener('mouseup', () => stopDrawing());
  canvas.addEventListener('mouseout', () => stopDrawing());

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    const mouseEvent = new MouseEvent('mousedown', {
      clientX: touch.clientX,
      clientY: touch.clientY
    });
    canvas.dispatchEvent(mouseEvent);
  });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    const mouseEvent = new MouseEvent('mousemove', {
      clientX: touch.clientX,
      clientY: touch.clientY
    });
    canvas.dispatchEvent(mouseEvent);
  });

  canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    const mouseEvent = new MouseEvent('mouseup', {});
    canvas.dispatchEvent(mouseEvent);
  });

  const clearButton = document.querySelector('[data-clear-signature]');
  if (clearButton) {
    clearButton.addEventListener('click', () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      document.getElementById('signature-input').value = '';
    });
  }

  function startDrawing(e, canvas, ctx) {
    isDrawing = true;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    lastX = (e.clientX - rect.left) * (canvas.width / (rect.width * dpr));
    lastY = (e.clientY - rect.top) * (canvas.height / (rect.height * dpr));
  }

  function draw(e, canvas, ctx) {
    if (!isDrawing) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (e.clientX - rect.left) * (canvas.width / (rect.width * dpr));
    const y = (e.clientY - rect.top) * (canvas.height / (rect.height * dpr));

    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.strokeStyle = '#221c18';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    lastX = x;
    lastY = y;
  }

  function stopDrawing() {
    isDrawing = false;
  }
}

function handleLeaseSubmit(e) {
  e.preventDefault();

  const form = e.target;
  const canvas = document.getElementById('signature-pad');
  const statusElement = form.querySelector('[data-status]');
  const submitButton = form.querySelector('button[type="submit"]');

  if (!canvas) {
    showStatus(statusElement, 'Signature pad not found', 'error');
    return;
  }

  const signatureData = canvas.toDataURL('image/png');

  const formData = new FormData(form);
  formData.append('signature', signatureData);

  const data = Object.fromEntries(formData);

  if (statusElement) {
    statusElement.textContent = 'Processing lease...';
    statusElement.removeAttribute('hidden');
  }

  if (submitButton) {
    submitButton.disabled = true;
  }

  fetch('/api/lease', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data)
  })
  .then(response => {
    if (!response.ok) {
      throw new Error(`Server responded with status ${response.status}`);
    }
    return response.json();
  })
  .then(result => {
    if (result.pdf_url) {
      const link = document.createElement('a');
      link.href = result.pdf_url;
      link.download = `Ligcabho_Lease_${new Date().getTime()}.pdf`;
      link.click();
    }

    showStatus(statusElement, 'Lease agreement signed and PDF generated successfully!', 'success');

    if (submitButton) {
      submitButton.disabled = false;
    }

    setTimeout(() => {
      form.reset();
      document.getElementById('signature-pad').getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    }, 2000);
  })
  .catch(error => {
    console.error('Error:', error);
    showStatus(statusElement, 'An error occurred. Please try again.', 'error');

    if (submitButton) {
      submitButton.disabled = false;
    }
  });
}

function showStatus(element, message, type) {
  if (!element) return;

  element.textContent = message;
  element.className = `chat-widget__status ${type}`;
  element.removeAttribute('hidden');
}
