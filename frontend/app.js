// CafeBot chat widget (mock replies only, no API calls)

document.addEventListener('DOMContentLoaded', function () {
  var toggle = document.getElementById('chatToggle');
  var closeBtn = document.getElementById('chatClose');
  var chatWindow = document.getElementById('chatWindow');
  var form = document.getElementById('chatForm');
  var input = document.getElementById('chatInput');
  var messages = document.getElementById('chatMessages');

  var MOCK_REPLY = "Hi! I'm CafeBot. My AI brain isn't connected yet.";

  function openChat() {
    chatWindow.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    input.focus();
  }

  function closeChat() {
    chatWindow.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }

  function addBubble(text, sender) {
    var bubble = document.createElement('div');
    bubble.className = 'chat-bubble ' + (sender === 'user' ? 'chat-bubble-user' : 'chat-bubble-bot');
    bubble.textContent = text;
    messages.appendChild(bubble);
    messages.scrollTop = messages.scrollHeight;
  }

  toggle.addEventListener('click', function () {
    if (chatWindow.hidden) {
      openChat();
    } else {
      closeChat();
    }
  });

  closeBtn.addEventListener('click', closeChat);

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var text = input.value.trim();
    if (!text) {
      return;
    }
    addBubble(text, 'user');
    input.value = '';
    addBubble(MOCK_REPLY, 'bot');
  });
});
