document.addEventListener('DOMContentLoaded', function() {
  initializeForms();
  initializeNavigation();
  updateYear();
});

function initializeForms() {
  const forms = document.querySelectorAll('form[data-endpoint]');
  forms.forEach(form => {
    form.addEventListener('submit', handleFormSubmit);
  });
}

function handleFormSubmit(e) {
  e.preventDefault();

  const form = e.target;
  const endpoint = form.dataset.endpoint;
  const successMessage = form.dataset.success;
  const busyMessage = form.dataset.busy;
  const statusElement = form.querySelector('[data-status]');
  const submitButton = form.querySelector('button[type="submit"]');

  if (!endpoint) return;

  const formData = new FormData(form);
  const data = Object.fromEntries(formData);

  if (statusElement) {
    statusElement.textContent = busyMessage || 'Sending...';
    statusElement.removeAttribute('hidden');
  }

  if (submitButton) {
    submitButton.disabled = true;
  }

  fetch(`/api/${endpoint}`, {
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
    if (statusElement) {
      statusElement.textContent = successMessage || 'Success!';
      statusElement.removeAttribute('hidden');
    }
    form.reset();

    if (submitButton) {
      submitButton.disabled = false;
    }
  })
  .catch(error => {
    console.error('Error:', error);
    if (statusElement) {
      statusElement.textContent = 'An error occurred. Please try again.';
      statusElement.removeAttribute('hidden');
    }

    if (submitButton) {
      submitButton.disabled = false;
    }
  });
}

function initializeNavigation() {
  const navToggle = document.querySelector('.nav-toggle');
  const nav = document.querySelector('.nav');
  const navClose = document.querySelector('.nav__close');

  if (navToggle) {
    navToggle.addEventListener('click', () => {
      const isExpanded = navToggle.getAttribute('aria-expanded') === 'true';
      navToggle.setAttribute('aria-expanded', !isExpanded);
      nav.classList.toggle('nav--active');
    });
  }

  if (navClose) {
    navClose.addEventListener('click', () => {
      navToggle.setAttribute('aria-expanded', false);
      nav.classList.remove('nav--active');
    });
  }

  const navLinks = document.querySelectorAll('.nav__link');
  navLinks.forEach(link => {
    link.addEventListener('click', () => {
      navToggle.setAttribute('aria-expanded', false);
      nav.classList.remove('nav--active');
    });
  });
}

function updateYear() {
  const yearElements = document.querySelectorAll('[data-year]');
  const currentYear = new Date().getFullYear();
  yearElements.forEach(el => {
    el.textContent = currentYear;
  });
}
