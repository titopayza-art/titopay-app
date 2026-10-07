document.addEventListener('DOMContentLoaded', function() {
  initializeResidenceFilters();
  initializeResidenceSearch();
});

function initializeResidenceFilters() {
  const filterButtons = document.querySelectorAll('[data-filter]');
  const residenceCards = document.querySelectorAll('[data-residence]');

  filterButtons.forEach(button => {
    button.addEventListener('click', (e) => {
      e.preventDefault();

      const filter = button.dataset.filter;

      filterButtons.forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');

      residenceCards.forEach(card => {
        if (filter === 'all') {
          card.style.display = '';
          setTimeout(() => card.classList.add('fade-in'), 10);
        } else {
          const residenceLocation = card.dataset.residence;
          if (residenceLocation === filter) {
            card.style.display = '';
            setTimeout(() => card.classList.add('fade-in'), 10);
          } else {
            card.classList.remove('fade-in');
            card.style.display = 'none';
          }
        }
      });
    });
  });
}

function initializeResidenceSearch() {
  const searchInput = document.querySelector('[data-residence-search]');

  if (!searchInput) return;

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    const residenceCards = document.querySelectorAll('[data-residence]');

    residenceCards.forEach(card => {
      const residenceName = card.querySelector('h3')?.textContent.toLowerCase() || '';
      const residenceLocation = card.dataset.residence?.toLowerCase() || '';
      const residenceDescription = card.textContent.toLowerCase();

      if (
        residenceName.includes(query) ||
        residenceLocation.includes(query) ||
        residenceDescription.includes(query)
      ) {
        card.style.display = '';
        setTimeout(() => card.classList.add('fade-in'), 10);
      } else {
        card.classList.remove('fade-in');
        card.style.display = 'none';
      }
    });
  });
}
