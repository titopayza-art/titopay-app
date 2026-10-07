document.addEventListener('DOMContentLoaded', function() {
  initializeChat();
});

function initializeChat() {
  const chatButtons = document.querySelectorAll('[data-open-chat]');

  chatButtons.forEach(button => {
    button.addEventListener('click', openChat);
  });
}

function openChat(e) {
  e.preventDefault();

  const chatContainer = document.getElementById('chat-widget');

  if (!chatContainer) {
    createChatWidget();
  } else {
    chatContainer.classList.toggle('chat-widget--open');
  }
}

function createChatWidget() {
  const chatContainer = document.createElement('div');
  chatContainer.id = 'chat-widget';
  chatContainer.className = 'chat-widget chat-widget--open';
  chatContainer.innerHTML = `
    <div class="chat-widget__header">
      <h3>Ligcabho Support</h3>
      <button class="chat-widget__close" aria-label="Close chat" type="button">&times;</button>
    </div>
    <div class="chat-widget__messages">
      <div class="chat-widget__message chat-widget__message--bot">
        <p>Hi there! 👋 How can we help you today?</p>
        <p>Send us a message and we'll get back to you as soon as possible.</p>
      </div>
    </div>
    <form class="chat-widget__form" data-endpoint="chat" novalidate>
      <div class="chat-widget__input-group">
        <input
          type="text"
          name="message"
          placeholder="Type your message..."
          required
          autocomplete="off"
        >
        <button type="submit" aria-label="Send message">Send</button>
      </div>
      <p class="chat-widget__status" data-status hidden></p>
    </form>
  `;

  document.body.appendChild(chatContainer);

  const closeButton = chatContainer.querySelector('.chat-widget__close');
  closeButton.addEventListener('click', () => {
    chatContainer.classList.remove('chat-widget--open');
  });

  const form = chatContainer.querySelector('.chat-widget__form');
  form.addEventListener('submit', handleChatSubmit);
}

function handleChatSubmit(e) {
  e.preventDefault();

  const form = e.target;
  const messageInput = form.querySelector('input[name="message"]');
  const messagesContainer = document.querySelector('.chat-widget__messages');
  const statusElement = form.querySelector('[data-status]');
  const submitButton = form.querySelector('button[type="submit"]');

  const message = messageInput.value.trim();

  if (!message) return;

  const userMessageEl = document.createElement('div');
  userMessageEl.className = 'chat-widget__message chat-widget__message--user';
  userMessageEl.innerHTML = `<p>${escapeHtml(message)}</p>`;
  messagesContainer.appendChild(userMessageEl);

  messageInput.value = '';
  submitButton.disabled = true;

  const formData = new FormData(form);
  const data = Object.fromEntries(formData);

  fetch('/api/chat', {
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
    const botMessageEl = document.createElement('div');
    botMessageEl.className = 'chat-widget__message chat-widget__message--bot';
    botMessageEl.innerHTML = `<p>${escapeHtml(result.message || 'Thanks for your message. We\'ll get back to you soon!')}</p>`;
    messagesContainer.appendChild(botMessageEl);

    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    submitButton.disabled = false;
  })
  .catch(error => {
    console.error('Chat error:', error);
    const botMessageEl = document.createElement('div');
    botMessageEl.className = 'chat-widget__message chat-widget__message--bot';
    botMessageEl.innerHTML = `<p>Sorry, we couldn't process your message. Please try again or contact us directly.</p>`;
    messagesContainer.appendChild(botMessageEl);
    submitButton.disabled = false;
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
